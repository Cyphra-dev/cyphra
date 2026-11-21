import neo4j from "neo4j-driver";
import { describe, expect, it } from "vitest";
import { schemaModel } from "./__fixtures__/search.gen.js";
import { ModelEngine, type Executor, type Runner } from "./engine.js";
import { CyphraValidationError } from "./errors.js";
import { escapeLucene } from "./fulltext.js";

type Call = { text: string; params: Record<string, unknown> };

function engine(model = "FtPost", answer: (call: Call) => Record<string, unknown>[] = () => []) {
  const calls: Call[] = [];
  const exec: Executor = async (text, params) => {
    const call = { text, params };
    calls.push(call);
    return answer(call);
  };
  const runner: Runner = { read: (fn) => fn(exec), write: (fn) => fn(exec) };
  const m = schemaModel.nodes.find((n) => n.name === model)!;
  return { calls, e: new ModelEngine(schemaModel, m, runner) };
}

const row = (id: string) => ({ id, title: id, body: null, tags: null, published: true });
const projection = "n{.`id`, .`title`, .`body`, .`tags`, .`published`}";

describe("escapeLucene", () => {
  it("escapes every special character and the boolean operators", () => {
    expect(escapeLucene('C++ (beta) AND "x"')).toBe('C\\+\\+ \\(beta\\) \\AND \\"x\\"');
    expect(escapeLucene("a && b || !c")).toBe("a \\&\\& b \\|\\| \\!c");
    expect(escapeLucene("{}[]^~*?:\\/-")).toBe("\\{\\}\\[\\]\\^\\~\\*\\?\\:\\\\\\/\\-");
    expect(escapeLucene("NOT OR and BRAND ORACLE")).toBe("\\NOT \\OR and BRAND ORACLE");
    expect(escapeLucene("plain words")).toBe("plain words");
  });
});

describe("search", () => {
  it("queries the index once and returns rows best first with $score", async () => {
    const { calls, e } = engine("FtPost", () => [
      { row: row("a"), score: 2.5 },
      { row: row("b"), score: 1.25 },
    ]);
    const out = await e.search({ index: "ftPostSearch", query: "graph*" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe(
      "CALL db.index.fulltext.queryNodes($p0, $p1) YIELD node, score WITH node AS n, score" +
        ` WITH n, score ORDER BY score DESC RETURN ${projection} AS row, score ORDER BY score DESC`,
    );
    expect(calls[0]!.params).toEqual({ p0: "ftPostSearch", p1: "graph*" });
    expect(out).toEqual([
      { ...row("a"), tags: [], $score: 2.5 },
      { ...row("b"), tags: [], $score: 1.25 },
    ]);
  });

  it("lets Lucene collect only skip + take hits when nothing filters", async () => {
    const { calls, e } = engine();
    await e.search({ index: "ftPostSearch", query: "graph", skip: 10, take: 5 });
    expect(calls[0]!.text).toBe(
      "CALL db.index.fulltext.queryNodes($p0, $p1, {limit: $p2}) YIELD node, score WITH node AS n, score" +
        ` WITH n, score ORDER BY score DESC SKIP $p3 LIMIT $p4 RETURN ${projection} AS row, score ORDER BY score DESC`,
    );
    expect(calls[0]!.params).toMatchObject({
      p2: neo4j.int(15),
      p3: neo4j.int(10),
      p4: neo4j.int(5),
    });
  });

  it("filters with where and minScore before paging", async () => {
    const { calls, e } = engine();
    await e.search({
      index: "ftPostSearch",
      query: "graph",
      where: { published: true, author: { is: { country: "FR" } } },
      minScore: 0.5,
      take: 2,
      select: { title: true },
    });
    const text = calls[0]!.text;
    expect(text).toMatch(
      /^CALL db\.index\.fulltext\.queryNodes\(\$p\d+, \$p\d+\) YIELD node, score/,
    );
    expect(text).toMatch(
      /WITH node AS n, score WHERE score >= \$p\d+ AND \(\(n\.`published` = \$p0\) AND /,
    );
    expect(text).toMatch(
      /WITH n, score ORDER BY score DESC LIMIT \$p\d+ RETURN n\{\.`title`\} AS row/,
    );
    expect(text).not.toContain("{limit:");
  });

  it("escapes the query in terms and phrase modes", async () => {
    const { calls, e } = engine();
    await e.search({ index: "ftPostSearch", query: "C++ AND (x)", mode: "terms" });
    await e.search({ index: "ftPostSearch", query: 'say "hi"', mode: "phrase" });
    await e.search({ index: "ftPostSearch", query: "title:x~", mode: "lucene" });
    expect(calls.map((c) => c.params.p1)).toEqual([
      "C\\+\\+ \\AND \\(x\\)",
      '"say \\"hi\\""',
      "title:x~",
    ]);
  });

  it("returns [] for a blank query or take: 0 without querying", async () => {
    const { calls, e } = engine();
    expect(await e.search({ index: "ftPostSearch", query: "   " })).toEqual([]);
    expect(await e.search({ index: "ftPostSearch", query: "x", take: 0 })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("validates its arguments", async () => {
    const { e, calls } = engine();
    const base = { index: "ftPostSearch", query: "x" };
    const fails = (args: Record<string, unknown>, msg: RegExp) =>
      expect(e.search({ ...base, ...args })).rejects.toThrow(msg);
    await fails(
      { index: undefined },
      /index is required \(ftPostSearch, ftPostTags, ftPostTitleEnglish\)/,
    );
    await fails({ index: "nope" }, /"nope" is not a full-text index of FtPost/);
    await fails({ query: 3 }, /query must be a string/);
    await fails({ mode: "regex" }, /mode must be lucene, terms, phrase/);
    await fails({ minScore: Number.NaN }, /minScore must be a finite number/);
    await fails({ take: -1 }, /take must be a non-negative integer/);
    await fails({ skip: 1.5 }, /skip must be a non-negative integer/);
    await fails({ orderBy: { title: "asc" } }, /unknown argument "orderBy"/);
    await fails({ where: { nope: 1 } }, /nope/);
    await expect(e.search({ ...base, mode: "x" })).rejects.toBeInstanceOf(CyphraValidationError);
    expect(calls).toHaveLength(0);

    const author = engine("FtAuthor").e;
    await expect(author.search({ index: "ftPostSearch", query: "x" })).rejects.toThrow(
      /FtAuthor has no @@fulltext index|declare one with @@fulltext/,
    );
  });
});
