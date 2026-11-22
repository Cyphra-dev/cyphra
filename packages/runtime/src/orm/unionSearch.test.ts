import { describe, expect, it } from "vitest";
import { schemaModel } from "./__fixtures__/unionSearch.gen.js";
import { QueryContext } from "./compile.js";
import { ModelEngine, type Executor, type Runner } from "./engine.js";
import { CyphraValidationError } from "./errors.js";
import { compileUnionFindSimilar, compileUnionSearch } from "./unionSearch.js";

type Dialect = "neo4j" | "memgraph" | "falkordb";
const node = (name: string) => schemaModel.nodes.find((n) => n.name === name)!;
const ctx = (dialect: Dialect = "neo4j") => new QueryContext(schemaModel, dialect);

function engine(
  name: string,
  answer: (text: string) => Record<string, unknown>[] = () => [],
  dialect?: "memgraph" | "falkordb",
) {
  const calls: { text: string; params: Record<string, unknown> }[] = [];
  const exec: Executor = async (text, params) => {
    calls.push({ text, params });
    return answer(text);
  };
  const runner: Runner = { read: (fn) => fn(exec), write: (fn) => fn(exec) };
  return { calls, e: new ModelEngine(schemaModel, node(name), runner, dialect ? { dialect } : {}) };
}

const ALL = { UsArticle: "usArticleText", UsAuthor: "usAuthorBio", UsEditor: "usPersonAbout" };

/** What follows the per-index subqueries: fusion, paging, projection (Neo4j). */
const FUSE =
  " WITH [hits0, hits1, hits2] AS lists UNWIND range(0, size(lists) - 1) AS li WITH li, lists[li] AS hits" +
  " UNWIND range(0, size(hits) - 1) AS pos WITH li, hits[pos].n AS n, hits[pos].s AS score, pos + 1 AS rank," +
  " hits[0].s AS hi, hits[size(hits) - 1].s AS lo" +
  " WITH n, li, score, rank, CASE WHEN hi = lo THEN 1.0 ELSE (score - lo) / (hi - lo) END AS norm" +
  " WITH n, sum(1.0 / ($p7 + rank)) AS fused, max(norm) AS best, min(li) AS first," +
  " collect({li: li, score: score, norm: norm, rank: rank}) AS parts" +
  " ORDER BY fused DESC, best DESC, first ASC, elementId(n) ASC";

describe("union search: compile", () => {
  it("queries each member's index in its own subquery, then fuses, pages and projects", () => {
    const c = compileUnionSearch(ctx(), node("UsHit"), {
      query: "graph",
      indexes: ALL,
      skip: 1,
      take: 2,
      select: { $on: { UsArticle: { title: true } } },
    })!;
    const sub = (i: number, name: string, query: string, extra = "") =>
      `CALL { CALL db.index.fulltext.queryNodes(${name}, ${query}${extra}) YIELD node, score WITH node AS n, score` +
      `${i === 2 ? " WHERE (n:`UsEditor`:`UsPerson`)" : ""} ` +
      `WITH n, score ORDER BY score DESC, elementId(n) ASC LIMIT $p8 RETURN collect({n: n, s: score}) AS hits${i} }`;
    expect(c.text).toBe(
      [
        // Unfiltered lists let Lucene collect only the `skip + take` best hits.
        sub(0, "$p0", "$p1", ", {limit: $p2}"),
        sub(1, "$p3", "$p4", ", {limit: $p5}"),
        // An index inherited from an interface: only this member's nodes.
        "CALL { CALL db.index.fulltext.queryNodes($p6, $p7) YIELD node, score WITH node AS n, score WHERE (n:`UsEditor`:`UsPerson`) " +
          "WITH n, score ORDER BY score DESC, elementId(n) ASC LIMIT $p8 RETURN collect({n: n, s: score}) AS hits2 }",
      ].join(" ") +
        FUSE.replace("$p7", "$p9") +
        " SKIP $p10 LIMIT $p11" +
        " RETURN n{`__labels`: labels(n), `__on_UsArticle`: CASE WHEN n:`UsArticle` THEN n{.`title`} END} AS row," +
        " fused, best, first, elementId(n) AS key, parts ORDER BY fused DESC, best DESC, first ASC, key ASC",
    );
    expect(c.params).toMatchObject({
      p0: "usArticleText",
      p1: "graph",
      p3: "usAuthorBio",
      p6: "usPersonAbout",
      p9: 60,
    });
    expect(Number(c.params.p8)).toBe(3);
  });

  it("applies the union where and minScore in every list, before ranking", () => {
    const c = compileUnionSearch(ctx(), node("UsHit"), {
      query: "C++ (beta)",
      mode: "terms",
      indexes: { UsArticle: "usArticleText" },
      where: { $on: { UsArticle: { published: true }, UsAuthor: {} } },
      minScore: 0.5,
      rrfK: 10,
    })!;
    expect(c.text).toContain(
      "CALL { CALL db.index.fulltext.queryNodes($p2, $p3) YIELD node, score WITH node AS n, score " +
        "WHERE (score >= $p1) AND (((n:`UsArticle`) AND (n.`published` = $p0)) OR (n:`UsAuthor`)) " +
        "WITH n, score ORDER BY score DESC, elementId(n) ASC RETURN collect({n: n, s: score}) AS hits0 }",
    );
    expect(c.text).toContain(" WITH [hits0] AS lists ");
    expect(c.params.p3).toBe("C\\+\\+ \\(beta\\)");
    expect(c.params.p4).toBe(10);
  });

  it("compiles Memgraph's and FalkorDB's text search", () => {
    const m = compileUnionSearch(ctx("memgraph"), node("UsParty"), {
      query: "graph",
      indexes: { UsPerson: "usPersonAbout", UsAuthor: "usAuthorName" },
    })!;
    expect(m.text).toContain(
      "CALL { CALL text_search.search_all($p0, $p1, {limit: $p2}) YIELD node AS hit, score " +
        "MATCH (node) WHERE id(node) = id(hit) WITH node AS n, score WITH n, score ORDER BY score DESC, id(n) ASC " +
        "RETURN collect({n: n, s: score}) AS hits0 }",
    );
    expect(m.text).toContain("ORDER BY fused DESC, best DESC, first ASC, id(n) ASC");
    const f = compileUnionSearch(ctx("falkordb"), node("UsHit"), {
      query: "graph db",
      mode: "terms",
      indexes: { UsEditor: "usPersonAbout" },
    })!;
    // FalkorDB's index is the label's, here the interface's (inherited by UsEditor).
    expect(f.text).toContain(
      "CALL { CALL db.idx.fulltext.queryNodes($p0, $p1) YIELD node, score WITH node AS n, score WHERE (n:`UsEditor`:`UsPerson`) ",
    );
    expect(f.params).toMatchObject({ p0: "UsPerson", p1: "graph | db" });
    // Nothing to search on FalkorDB: no statement.
    expect(
      compileUnionSearch(ctx("falkordb"), node("UsHit"), {
        query: "+-",
        mode: "terms",
        indexes: ALL,
      }),
    ).toBeNull();
  });

  it("returns nothing for a blank query or take: 0", () => {
    expect(compileUnionSearch(ctx(), node("UsHit"), { query: " ", indexes: ALL })).toBeNull();
    expect(
      compileUnionSearch(ctx(), node("UsHit"), { query: "x", indexes: ALL, take: 0 }),
    ).toBeNull();
  });

  it("defaults to every member with one index, and checks indexes", () => {
    const party = compileUnionSearch(ctx(), node("UsParty"), {
      query: "x",
      indexes: { UsAuthor: "usAuthorName" },
    })!;
    expect(party.text).toContain(" WITH [hits0] AS lists ");
    const op =
      (args: Record<string, unknown>, model = "UsHit") =>
      () =>
        compileUnionSearch(ctx(), node(model), { query: "x", ...args });
    expect(op({})).toThrow(
      new CyphraValidationError(
        'UsHit.search: UsAuthor has several @@fulltext indexes (usAuthorName, usAuthorBio); name the one to search in indexes: { UsAuthor: "…" }.',
      ),
    );
    expect(op({ indexes: { UsTag: "x" } })).toThrow(
      "UsHit.search: indexes.UsTag: not a member of UsHit (UsArticle, UsAuthor, UsEditor).",
    );
    expect(op({ indexes: { UsArticle: "usAuthorBio" } })).toThrow(
      'UsHit.search: indexes.UsArticle: "usAuthorBio" is not a @@fulltext index of UsArticle (usArticleText).',
    );
    expect(op({ indexes: {} })).toThrow("UsHit.search: indexes names no member to search.");
    expect(op({ indexes: "usArticleText" })).toThrow("UsHit.search: indexes must be an object");
    expect(op({ index: "usArticleText" })).toThrow(
      'UsHit.search: unknown argument "index" (a union searches one index per member: indexes: { <member>: <index> }).',
    );
    expect(op({ indexes: ALL, mode: "fuzzy" })).toThrow(
      "UsHit.search: mode must be lucene, terms, phrase.",
    );
    expect(op({ indexes: ALL, rrfK: -1 })).toThrow(
      "UsHit.search: rrfK must be a non-negative number.",
    );
    expect(op({ indexes: ALL, scores: "yes" })).toThrow("UsHit.search: scores must be a boolean.");
    expect(op({ indexes: ALL, take: 1.5 })).toThrow(CyphraValidationError);
    expect(op({ indexes: ALL, where: { title: "x" } })).toThrow(CyphraValidationError);
  });
});

describe("union findSimilar: compile", () => {
  it("queries each member's vector index with one vector parameter", () => {
    const c = compileUnionFindSimilar(ctx(), node("UsHit"), {
      vector: [1, 0, 0],
      take: 2,
      where: { __typename: { not: "UsEditor" } },
    })!;
    expect(c.text).toContain(
      "CALL { CALL db.index.vector.queryNodes($p2, $p1, $p0) YIELD node, score WITH node AS n, score " +
        "WHERE (NOT (n:`UsEditor`)) WITH n, score ORDER BY score DESC, elementId(n) ASC LIMIT $p5 " +
        "RETURN collect({n: n, s: score}) AS hits0 }",
    );
    expect(c.text).toContain("CALL db.index.vector.queryNodes($p3, $p1, $p0)");
    expect(c.text).toContain("CALL db.index.vector.queryNodes($p4, $p1, $p0)");
    // With a where: max(10 × (skip + take), 100) candidates from each index.
    expect(Number(c.params.p1)).toBe(100);
    expect(c.params).toMatchObject({
      p0: [1, 0, 0],
      p2: "usArticleEmbedding",
      p3: "usAuthorEmbedding",
      p4: "usEditorEmbedding",
    });
  });

  it("compiles Memgraph's and FalkorDB's vector search", () => {
    const m = compileUnionFindSimilar(ctx("memgraph"), node("UsHit"), {
      vector: [1, 0, 0],
      take: 1,
      fields: { UsAuthor: "embedding" },
    })!;
    expect(m.text).toContain(
      "CALL { CALL vector_search.search($p2, $p1, $p0) YIELD node AS hit, similarity OPTIONAL MATCH (node) WHERE id(node) = id(hit) " +
        "WITH node, similarity AS score WITH node AS n, score WHERE (n IS NOT NULL) ",
    );
    const f = compileUnionFindSimilar(ctx("falkordb"), node("UsHit"), {
      vector: [1, 0, 0],
      take: 1,
      fields: { UsArticle: "embedding" },
    })!;
    expect(f.text).toContain(
      "CALL { CALL db.idx.vector.queryNodes($p2, $p3, $p1, $p0) YIELD node, score AS distance WITH node, 1.0 - distance / 2.0 AS score ",
    );
    expect(f.params).toMatchObject({ p2: "UsArticle", p3: "embedding" });
  });

  it("checks its arguments", () => {
    const op = (args: Record<string, unknown>) => () =>
      compileUnionFindSimilar(ctx(), node("UsHit"), { vector: [1, 0, 0], ...args });
    expect(op({})).toThrow("UsHit.findSimilar: take is required.");
    expect(op({ take: 1, k: 3 })).toThrow(
      'UsHit.findSimilar: unknown argument "k" (a union search is paged after fusion: use take (and skip)).',
    );
    expect(op({ take: 1, exact: true })).toThrow('unknown argument "exact"');
    expect(op({ take: 1, field: "embedding" })).toThrow('unknown argument "field"');
    expect(op({ take: 1, fields: { UsArticle: "title" } })).toThrow(
      'UsHit.findSimilar: fields.UsArticle: "title" is not a @vectorIndex field of UsArticle (embedding).',
    );
    expect(op({ take: 1, vector: [1, 0] })).toThrow(CyphraValidationError);
    expect(op({ take: 5, skip: 5, candidates: 9 })).toThrow(
      "UsHit.findSimilar: candidates must be at least skip + take (10).",
    );
    expect(() =>
      compileUnionFindSimilar(ctx(), node("UsParty"), {
        vector: [1, 0, 0],
        take: 1,
        fields: { UsPerson: "embedding" },
      }),
    ).toThrow(
      'fields.UsPerson: "embedding" is not a @vectorIndex field of UsPerson (it has none).',
    );
    expect(op({ take: 0 })()).toBeNull();
  });
});

describe("union search: engine", () => {
  it("runs one statement and decodes members, $score and $scores", async () => {
    const { calls, e } = engine("UsHit", () => [
      {
        row: { __labels: ["UsArticle"], __on_UsArticle: { title: "T" } },
        fused: 1 / 61,
        parts: [{ li: 0, score: 2.5, norm: 1, rank: 1 }],
      },
      {
        row: { __labels: ["UsEditor", "UsPerson"], __on_UsEditor: { email: "e@x" } },
        fused: 1 / 62,
        parts: [{ li: 2, score: 0.4, norm: 0, rank: 2 }],
      },
    ]);
    const rows = await e.search({
      query: "graph",
      indexes: ALL,
      scores: true,
      select: { $on: { UsArticle: { title: true }, UsEditor: { email: true } } },
    });
    expect(calls).toHaveLength(1);
    expect(rows).toEqual([
      {
        __typename: "UsArticle",
        title: "T",
        $score: 1 / 61,
        $scores: { usArticleText: { score: 2.5, normalized: 1, rank: 1 } },
      },
      {
        __typename: "UsEditor",
        email: "e@x",
        $score: 1 / 62,
        $scores: { usPersonAbout: { score: 0.4, normalized: 0, rank: 2 } },
      },
    ]);
    const plain = await e.findSimilar({ vector: [1, 0, 0], take: 1 });
    expect(plain[0]).not.toHaveProperty("$scores");
    expect(calls[1]!.text).toContain("db.index.vector.queryNodes");
    expect(await e.search({ query: "", indexes: ALL })).toEqual([]);
    expect(calls).toHaveLength(2);
    await expect(e.search("x" as never)).rejects.toThrow("search args must be an object.");
  });
});
