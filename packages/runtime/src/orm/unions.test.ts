import { describe, expect, it } from "vitest";
import { schemaModel } from "./__fixtures__/unions.gen.js";
import { QueryContext } from "./compile.js";
import { ModelEngine, type Executor, type Runner } from "./engine.js";
import { CyphraValidationError } from "./errors.js";
import { hasDeleteRules } from "./onDelete.js";
import { compileTraverse } from "./traverse.js";

type Call = { text: string; params: Record<string, unknown> };

function engine(
  name: string,
  answer: (text: string, params: Record<string, unknown>) => Record<string, unknown>[] = () => [],
  dialect?: "memgraph" | "falkordb",
) {
  const calls: Call[] = [];
  const exec: Executor = async (text, params) => {
    calls.push({ text, params });
    return answer(text, params);
  };
  const runner: Runner = { read: (fn) => fn(exec), write: (fn) => fn(exec) };
  const node = schemaModel.nodes.find((n) => n.name === name)!;
  return { calls, e: new ModelEngine(schemaModel, node, runner, dialect ? { dialect } : {}) };
}

const HIT = "n:`Article` OR n:`Author` OR n:`Staff`";
const ALL_SCALARS =
  "n{.`id`, .`title`, .`name`, .`rating`, .`email`, .`role`, `__labels`: labels(n)}";

describe("unions: reads", () => {
  it("matches a union by a label predicate and decodes each member", async () => {
    const { calls, e } = engine("SearchHit", () => [
      { row: { id: "1", title: "T", name: null, rating: null, __labels: ["Article"] } },
      { row: { id: "2", title: null, name: "N", rating: 3, __labels: ["Author"] } },
      { row: { id: "3", email: "s@x", role: "editor", __labels: ["Staff", "Member"] } },
    ]);
    const rows = await e.findMany();
    expect(calls[0]!.text).toBe(`MATCH (n) WHERE ${HIT} RETURN ${ALL_SCALARS} AS row`);
    expect(rows).toEqual([
      { __typename: "Article", id: "1", title: "T" },
      { __typename: "Author", id: "2", name: "N", rating: 3 },
      { __typename: "Staff", id: "3", email: "s@x", role: "editor" },
    ]);
  });

  it("filters with __typename and $on, sorts by __typename and counts", async () => {
    const { calls, e } = engine("SearchHit", () => [{ c: 2 }]);
    await e.findMany({
      where: {
        __typename: { not: "Staff" },
        $on: { Article: { title: { contains: "graph" } }, Author: {} },
      },
      orderBy: { __typename: "desc" },
      take: 5,
    });
    expect(calls[0]!.text).toBe(
      `MATCH (n) WHERE (${HIT}) AND ((NOT (n:\`Staff\`)) AND ` +
        "(((n:`Article`) AND (n.`title` CONTAINS $p0)) OR (n:`Author`))) " +
        "WITH n ORDER BY CASE WHEN n:`Article` THEN $p1 WHEN n:`Author` THEN $p2 WHEN n:`Staff` THEN $p3 ELSE $p4 END DESC LIMIT $p5 " +
        `RETURN ${ALL_SCALARS} AS row ` +
        "ORDER BY CASE WHEN n:`Article` THEN $p6 WHEN n:`Author` THEN $p7 WHEN n:`Staff` THEN $p8 ELSE $p9 END DESC",
    );
    expect(await e.count({ where: { $on: {} } })).toBe(2);
    expect(calls[1]!.text).toBe(`MATCH (n) WHERE (${HIT}) AND (false) RETURN count(n) AS c`);
  });

  it("selects per member with $on, always reporting __typename", async () => {
    const { calls, e } = engine("SearchHit", () => [
      {
        row: {
          __labels: ["Article"],
          __on_Article: { title: "T", notes: [{ id: "n1", text: "x" }] },
        },
      },
      { row: { __labels: ["Author"] } },
    ]);
    const rows = await e.findMany({ select: { $on: { Article: { title: true, notes: true } } } });
    expect(calls[0]!.text).toBe(
      `MATCH (n) WHERE ${HIT} RETURN n{\`__labels\`: labels(n), \`__on_Article\`: CASE WHEN n:\`Article\` THEN n{.\`title\`, \`notes\`: COLLECT { MATCH (n)-[r1:\`HAS_NOTE\`]->(m0:\`Note\`) RETURN m0{.\`id\`, .\`text\`} }} END} AS row`,
    );
    expect(rows).toEqual([
      { __typename: "Article", title: "T", notes: [{ id: "n1", text: "x" }] },
      { __typename: "Author" },
    ]);
  });

  it("loads, filters and counts relations to a union", async () => {
    const { calls, e } = engine("Board", () => []);
    await e.findMany({
      where: { items: { some: { $on: { Author: { rating: { gte: 4 } } } } } },
      include: { items: { where: { __typename: "Article" } }, _count: true },
    });
    const text = calls[0]!.text;
    expect(text).toContain(
      "EXISTS { MATCH (n)-[:`SHOWS`]->(m0) WHERE (m0:`Article` OR m0:`Author` OR m0:`Staff`) AND ((m0:`Author`) AND (m0.`rating` >= $p0)) }",
    );
    expect(text).toContain(
      "`items`: COLLECT { MATCH (n)-[r2:`SHOWS`]->(m1) WHERE (m1:`Article` OR m1:`Author` OR m1:`Staff`) AND (m1:`Article`) RETURN m1{",
    );
    expect(text).toContain(
      "`_count`: {`items`: COUNT { MATCH (n)-[:`SHOWS`]->(m3) WHERE m3:`Article` OR m3:`Author` OR m3:`Staff` }}",
    );
  });

  it("never mixes `|` label expressions with implementations' `:A:B`", async () => {
    // Neo4j rejects a clause with both `(n:Staff:Member)` and `(m:A|B)`: unions use predicates.
    const { calls, e } = engine("Pin", () => []);
    await e.findMany({ where: { subject: { is: { $on: { Staff: { role: "x" } } } } } });
    expect(calls[0]!.text).not.toMatch(/`\|`/);
  });

  it("traverses into a union", () => {
    const ctx = new QueryContext(schemaModel);
    const board = schemaModel.nodes.find((n) => n.name === "Board")!;
    const c = compileTraverse(ctx, board, { from: { id: "b" }, via: [{ rel: "items" }] }, 10);
    expect(c.text).toBe(
      "MATCH (s:`Board`) WHERE s.`id` = $p0 MATCH (s)((:`Board`)-[e0:`SHOWS`]->(t1) WHERE (t1:`Article` OR t1:`Author` OR t1:`Staff`)){1,1}(n) " +
        `WHERE (n <> s) AND (${HIT}) WITH DISTINCT n RETURN ${ALL_SCALARS} AS row`,
    );
  });

  it.each([
    "findUnique",
    "findUniqueOrThrow",
    "aggregate",
    "groupBy",
    "traverse",
    "search",
    "findSimilar",
    "create",
    "createMany",
    "update",
    "updateMany",
    "upsert",
    "delete",
    "deleteMany",
  ] as const)("rejects %s on a union", async (op) => {
    const { calls, e } = engine("SearchHit");
    const call = async () => (e[op] as (a: unknown) => Promise<unknown>)({ where: {} });
    await expect(call()).rejects.toThrow(
      new CyphraValidationError(
        `SearchHit.${op}: SearchHit is a union; it supports findMany, findFirst and count (${op} goes through one of its members: Article, Author, Staff).`,
      ),
    );
    expect(calls).toEqual([]);
  });

  it("rejects fields and unknown members in where / select", async () => {
    const { e } = engine("SearchHit");
    await expect(e.findMany({ where: { title: "x" } })).rejects.toThrow(
      'Unknown field "SearchHit.title" in where.',
    );
    await expect(e.findMany({ where: { $on: { Note: {} } } })).rejects.toThrow(
      "where.$on.Note: not a member of SearchHit (Article, Author, Staff).",
    );
    await expect(e.findMany({ select: { $on: { Note: { id: true } } } })).rejects.toThrow(
      "select.$on.Note: not a member of SearchHit (Article, Author, Staff).",
    );
    await expect(e.findMany({ where: { __typename: "Note" } })).rejects.toThrow(
      'expected "Article" | "Author" | "Staff", got "Note"',
    );
  });

  it("rejects $on in the where of a node", async () => {
    const { e } = engine("Article");
    await expect(e.findMany({ where: { $on: {} } })).rejects.toThrow(
      "where.$on: Article is not an interface or a union",
    );
  });
});

describe("unions: writes through relations", () => {
  const ok = () => [{ row: { id: "b", name: "B" }, c2: 1, c3: 1, c6: 1, c8: 1 }];

  it("creates per member (batched by member) and connects a named member", async () => {
    const { calls, e } = engine("Board", ok);
    await e.create({
      data: {
        name: "B",
        items: {
          create: [
            { Article: { title: "a" } },
            { Article: { title: "b" } },
            { Author: { name: "c" } },
          ],
          connect: { Staff: { email: "s@x" } },
        },
      },
    });
    const { text, params } = calls[0]!;
    expect(text).toBe(
      "CREATE (n:`Board` $p0) WITH n " +
        "CALL { WITH n MATCH (b0:`Staff`:`Member`) WHERE b0.`email` = $p1 WITH n, b0 LIMIT 1 MERGE (n)-[r1:`SHOWS`]->(b0) RETURN count(r1) AS c2 } " +
        "FOREACH (x3 IN $p2 | CREATE (c4:`Article`) SET c4 = x3.p CREATE (n)-[:`SHOWS`]->(c4)) " +
        "FOREACH (x6 IN $p3 | CREATE (c7:`Author`) SET c7 = x6.p CREATE (n)-[:`SHOWS`]->(c7)) " +
        "RETURN n{.`id`, .`name`} AS row, c2",
    );
    expect((params.p2 as { p: Record<string, unknown> }[]).map((x) => x.p.title)).toEqual([
      "a",
      "b",
    ]);
    expect((params.p3 as { p: Record<string, unknown> }[])[0]!.p.name).toBe("c");
  });

  it("disconnects and sets by member keys", async () => {
    const { calls, e } = engine("Board", ok);
    await e.update({
      where: { id: "b" },
      data: { items: { disconnect: { Author: { name: "a" } }, set: [{ Article: { id: "1" } }] } },
    });
    const text = calls[0]!.text;
    expect(text).toContain(
      "MATCH (n)-[r1:`SHOWS`]->(b0) WHERE (b0:`Article` OR b0:`Author` OR b0:`Staff`) AND (((b0:`Author`) AND (b0.`name` = $p1))) DELETE r1",
    );
    expect(text).toContain(
      "MATCH (n)-[r4:`SHOWS`]->(b3) WHERE (b3:`Article` OR b3:`Author` OR b3:`Staff`) AND (NOT (((b3:`Article`) AND (b3.`id` = $p2)))) DELETE r4",
    );
    expect(text).toContain("MATCH (b6:`Article`) WHERE b6.`id` = $p3");
  });

  it("replaces the edge of a to-one union relation and of its inverse", async () => {
    const { calls, e } = engine("Pin", () => [{ row: { id: "p", label: "l" }, c6: 1 }]);
    await e.create({ data: { label: "l", subject: { connect: { Article: { id: "a" } } } } });
    const text = calls[0]!.text;
    // Pin.subject: drop the edge to any other member.
    expect(text).toContain(
      "OPTIONAL MATCH (n)-[o3:`PINS`]->(x2) WHERE (x2:`Article` OR x2:`Author` OR x2:`Staff`) AND (x2 <> b0) DELETE o3",
    );
    // Article.pin (the to-one inverse): drop the article's edge from another pin.
    expect(text).toContain("OPTIONAL MATCH (x4:`Pin`)-[o5:`PINS`]->(b0) WHERE x4 <> n DELETE o5");
  });

  it("keeps the inverse to-one union field consistent from the member's side", async () => {
    const { calls, e } = engine("Article", () => [{ row: { id: "a", title: "t" }, c6: 1 }]);
    await e.create({ data: { title: "t", pin: { connect: { id: "p" } } } });
    expect(calls[0]!.text).toContain(
      "OPTIONAL MATCH (x4)<-[o5:`PINS`]-(b0) WHERE (x4:`Article` OR x4:`Author` OR x4:`Staff`) AND (x4 <> n) DELETE o5",
    );
  });

  it.each([
    [{ connect: { id: "x" } }, "connect: SearchHit is a union; name the member of each item"],
    [{ connect: { Article: { id: "x" }, Author: { id: "y" } } }, "got Article, Author"],
    [{ create: { Note: { text: "x" } } }, "(one of Article, Author, Staff), got Note"],
    [{ connect: { Article: { title: "x" } } }, "where must set at least one unique field (id)"],
  ])("rejects a relation write %j without exactly one member", async (items, message) => {
    const { calls, e } = engine("Board", ok);
    await expect(e.create({ data: { name: "B", items } })).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it("checks the validation rules of the member a nested create names", async () => {
    const { calls, e } = engine("Board", ok);
    await expect(
      e.create({ data: { name: "B", items: { create: { Article: { title: "x".repeat(201) } } } } }),
    ).rejects.toMatchObject({
      issues: [{ path: ["data", "items", "create", "Article", "title"] }],
    });
    expect(calls).toEqual([]);
  });

  it("cascades into a union with each member's own rules", () => {
    const board = schemaModel.nodes.find((n) => n.name === "Board")!;
    expect(hasDeleteRules(schemaModel, board)).toBe(true);
  });
});

describe("unions: dialects", () => {
  it("runs the same statements on Memgraph and FalkorDB", async () => {
    for (const dialect of ["memgraph", "falkordb"] as const) {
      const { calls, e } = engine("SearchHit", () => [], dialect);
      await e.findMany({ where: { __typename: "Author" } });
      expect(calls[0]!.text).toBe(
        `MATCH (n) WHERE (${HIT}) AND (n:\`Author\`) RETURN ${ALL_SCALARS} AS row`,
      );
    }
  });
});
