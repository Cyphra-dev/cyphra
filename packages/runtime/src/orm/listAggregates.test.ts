import { describe, expect, it } from "vitest";
import neo4j from "neo4j-driver";
import { schemaModel } from "./__fixtures__/blog.gen.js";
import { schemaModel as searchSchema } from "./__fixtures__/search.gen.js";
import { CYPHER_NODE, cypherFragment as cypher } from "./cypherExpr.js";
import { ModelEngine, type Executor, type Runner } from "./engine.js";
import { CyphraValidationError } from "./errors.js";

type Call = { text: string; params: Record<string, unknown> };
type Row = Record<string, unknown>;

function engine(name: string, answer: () => Row[] = () => [], schema = schemaModel) {
  const calls: Call[] = [];
  const exec: Executor = async (text, params) => {
    calls.push({ text, params });
    return answer();
  };
  const runner: Runner = { read: (fn) => fn(exec), write: (fn) => fn(exec) };
  const model = schema.nodes.find((n) => n.name === name)!;
  return { calls, e: new ModelEngine(schema, model, runner, {}) };
}

describe("list aggregates (internal, compat.v7)", () => {
  it("projects relation aggregates over distinct nodes and edges, with list reductions", async () => {
    const values = { c: neo4j.int(2), e: neo4j.int(3), s: neo4j.int(40) };
    const { calls, e } = engine("User", () => [{ row: { id: "u1", agg: values } }]);
    const rows = await e.findMany({
      select: {
        id: true,
        agg: {
          $aggregate: {
            $relation: "posts",
            where: { published: true },
            values: {
              c: { count: "nodes" },
              e: { count: "edges" },
              s: { node: "views", fn: "sum" },
              a: { node: "views", fn: "avg" },
              l: { node: "title", fn: "longest" },
              t: { node: "title", fn: "shortest" },
            },
          },
        },
      },
    });
    const { text } = calls[0]!;
    expect(text).toContain(
      "`c`: COUNT { MATCH (n)-[r1:`AUTHORED`]->(m0:`Post`) WHERE m0.`published` = $p0 WITH DISTINCT m0 RETURN m0 }",
    );
    expect(text).toContain("WITH DISTINCT r1 RETURN r1 }");
    expect(text).toContain(
      "WITH DISTINCT m0 WHERE m0.`views` IS NOT NULL RETURN m0.`views` }] | reduce(acc = 0, x IN",
    );
    expect(text).toContain("toFloat(reduce(acc = 0, x IN");
    expect(text).toContain("ORDER BY size(m0.`title`) DESC RETURN m0.`title` }] | head(");
    expect(text).toContain("| last(");
    // Returned as the driver gives them: the caller decodes.
    expect(rows).toEqual([{ id: "u1", agg: values }]);
  });

  it("aggregates edge properties, filtered on the edge", async () => {
    const { calls, e } = engine("User", () => [{ row: { id: "u1", agg: {} } }]);
    await e.findMany({
      select: {
        id: true,
        agg: {
          $aggregate: {
            $relation: "following",
            where: { $edge: { since: { gte: new Date("2020-01-01T00:00:00Z") } } },
            values: { m: { edge: "since", fn: "min" } },
          },
        },
      },
    });
    expect(calls[0]!.text).toContain(
      "MATCH (n)-[r1:`FOLLOWS`]->(m0:`User`) WHERE r1.`since` >= $p0 WITH DISTINCT r1 WHERE r1.`since` IS NOT NULL RETURN r1.`since`",
    );
  });

  it("filters on relation aggregates: counts, distinct node values, string lengths, DateTime values", async () => {
    const { calls, e } = engine("User");
    await e.findMany({
      where: {
        $aggregate: [
          { relation: "posts", of: "count", distinct: true, op: "gte", value: 2 },
          { relation: "posts", of: "count", op: "lt", value: 5 },
          { relation: "posts", of: "node", field: "title", fn: "max", op: "gt", value: 3 },
          {
            relation: "posts",
            of: "node",
            field: "title",
            fn: "min",
            length: false,
            op: "eq",
            value: "a",
          },
          {
            relation: "following",
            of: "edge",
            field: "since",
            fn: "min",
            op: "lt",
            value: "2020-01-01T00:00:00Z",
          },
        ],
      },
    });
    const { text, params } = calls[0]!;
    expect(text).toContain(
      "COUNT { MATCH (n)-[r1:`AUTHORED`]->(n0:`Post`) WITH DISTINCT n0 RETURN n0 } >= $p0",
    );
    expect(text).toContain("COUNT { MATCH (n)-[r3:`AUTHORED`]->(n2:`Post`) } < $p1");
    expect(text).toContain("WITH n4 WHERE n4.`title` IS NOT NULL RETURN size(n4.`title`) }");
    expect(text).toContain("WHERE n7.`title` IS NOT NULL RETURN n7.`title` }");
    expect(text).toMatch(
      /r\d+\.`since` IS NOT NULL RETURN r\d+\.`since` }\] \| reduce\(.*\)\]\[0\] < datetime\(\$p4\)/,
    );
    expect(params).toMatchObject({ p0: 2, p1: 5, p2: 3, p3: "a", p4: "2020-01-01T00:00:00Z" });
  });

  it("adds root list aggregates to aggregate ($values)", async () => {
    const { calls, e } = engine("Post", () => [{ a0: neo4j.int(4), values1: { l: "abc" } }]);
    const out = await e.aggregate({
      where: { published: true },
      _count: true,
      $values: { l: { node: "title", fn: "longest" } },
    } as never);
    expect(calls[0]!.text).toMatch(
      /^MATCH \(n:`Post`\) WHERE n\.`published` = \$p0 WITH count\(n\) AS a0 RETURN a0, \{`l`: \[l\d+ IN \[COLLECT \{ MATCH \(v\d+:`Post`\) WHERE v\d+\.`published` = \$p\d+ WITH DISTINCT/,
    );
    expect(out).toEqual({ _count: 4, $values: { l: "abc" } });
    await expect(
      e.aggregate({ take: 2, $values: { l: { node: "title", fn: "longest" } } } as never),
    ).rejects.toThrow(CyphraValidationError);
    await expect(e.aggregate({ $values: { l: { count: "edges" } } } as never)).rejects.toThrow(
      CyphraValidationError,
    );
  });

  it("rejects malformed entries", async () => {
    const { e } = engine("User");
    await expect(
      e.findMany({ select: { a: { $aggregate: { $relation: "nope", values: {} } } } } as never),
    ).rejects.toThrow(CyphraValidationError);
    await expect(
      e.findMany({
        select: {
          a: { $aggregate: { $relation: "posts", values: { x: { node: "views", fn: "median" } } } },
        },
      } as never),
    ).rejects.toThrow(CyphraValidationError);
    await expect(
      e.findMany({
        where: { $aggregate: [{ relation: "posts", of: "count", op: "ne", value: 1 }] },
      } as never),
    ).rejects.toThrow(CyphraValidationError);
  });

  it("projects every node a Cypher expression returns with $labelTest: false", async () => {
    const { calls, e } = engine("User");
    await e.findMany({
      select: {
        id: true,
        rel: {
          $cypher: cypher`COLLECT { MATCH (${CYPHER_NODE})-->(x) RETURN x }`,
          $model: "Post",
          $many: true,
          $labelTest: false,
          select: { id: true },
        },
      },
    } as never);
    expect(calls[0]!.text).toMatch(
      /UNWIND \(COLLECT \{ MATCH \(n\)-->\(x\) RETURN x \}\) AS (m\d+) WITH \1 WHERE \1 IS NOT NULL/,
    );
  });
});

describe("search ordering (internal, compat.v7)", () => {
  it("orders by node fields and score, or keeps the index's order, and filters on a maximum score", async () => {
    const { calls, e } = engine("FtPost", () => [], searchSchema);
    await e.search({
      index: "ftPostSearch",
      query: "graph",
      $orderBy: [{ title: "asc" }, { $score: "desc" }],
      $maxScore: 3,
      take: 2,
      select: { id: true },
    } as never);
    expect(calls[0]!.text).toMatch(
      /YIELD node, score WITH node AS n, score WHERE score <= \$p\d+ WITH n, score ORDER BY n\.`title` ASC, score DESC LIMIT \$p\d+ RETURN n\{\.`id`\} AS row, score$/,
    );
    await e.search({
      index: "ftPostSearch",
      query: "graph",
      $orderBy: [],
      take: 2,
      select: {},
    } as never);
    // No ORDER BY, and no top-k cut-off (it applies to the best hits only).
    expect(calls[1]!.text).toMatch(
      /queryNodes\(\$p\d+, \$p\d+\) YIELD node, score WITH node AS n, score WITH n, score LIMIT \$p\d+ RETURN n\{\} AS row, score$/,
    );
    await expect(
      e.search({ index: "ftPostSearch", query: "graph", $orderBy: [{ $score: "up" }] } as never),
    ).rejects.toThrow(CyphraValidationError);
  });
});

describe("filters on the nodes of a Cypher expression (internal, compat.v7)", () => {
  it("some / none / single / all / first / absent of the non-null values, as nodes of a model", async () => {
    const { calls, e } = engine("User");
    const posts = cypher`COLLECT { MATCH (${CYPHER_NODE})-[:AUTHORED]->(p) RETURN p }`;
    const quantifiers = ["some", "none", "single", "all", "first", "absent"];
    await e.findMany({
      where: {
        $cypherNodes: quantifiers.map((quantifier) => ({
          expr: posts,
          model: "Post",
          quantifier,
          ...(quantifier === "absent" ? {} : { where: { published: true } }),
        })),
      },
    } as never);
    const text = calls[0]!.text;
    const rows = (x: string) =>
      `UNWIND (COLLECT { MATCH (n)-[:AUTHORED]->(p) RETURN p }) AS ${x} WITH ${x} WHERE ${x} IS NOT NULL`;
    expect(text).toContain(`EXISTS { ${rows("x0")} WITH x0 WHERE x0.\`published\` = $p0 }`);
    expect(text).toContain(`NOT EXISTS { ${rows("x1")} WITH x1 WHERE x1.\`published\` = $p1 }`);
    expect(text).toContain(`COUNT { ${rows("x2")} WITH x2 WHERE x2.\`published\` = $p2 } = 1`);
    expect(text).toContain(
      `COUNT { ${rows("x3")} WITH x3 WHERE x3.\`published\` = $p3 } = COUNT { ${rows("x3")} }`,
    );
    expect(text).toContain(
      `EXISTS { ${rows("x4")} WITH x4 LIMIT 1 WITH x4 WHERE x4.\`published\` = $p4 }`,
    );
    expect(text).toContain(`NOT EXISTS { ${rows("x5")} }`);
    await expect(
      e.findMany({
        where: { $cypherNodes: [{ expr: posts, model: "Post", quantifier: "most" }] },
      } as never),
    ).rejects.toThrow(CyphraValidationError);
  });
});
