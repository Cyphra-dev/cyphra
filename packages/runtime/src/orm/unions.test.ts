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

const HIT = "n:`Story` OR n:`Writer` OR n:`Editor`";
const ALL_SCALARS =
  "n{.`id`, .`title`, .`name`, .`rating`, .`email`, .`role`, `__labels`: labels(n)}";

describe("unions: reads", () => {
  it("matches a union by a label predicate and decodes each member", async () => {
    const { calls, e } = engine("SearchHit", () => [
      { row: { id: "1", title: "T", name: null, rating: null, __labels: ["Story"] } },
      { row: { id: "2", title: null, name: "N", rating: 3, __labels: ["Writer"] } },
      { row: { id: "3", email: "s@x", role: "editor", __labels: ["Editor", "Contributor"] } },
    ]);
    const rows = await e.findMany();
    expect(calls[0]!.text).toBe(`MATCH (n) WHERE ${HIT} RETURN ${ALL_SCALARS} AS row`);
    expect(rows).toEqual([
      { __typename: "Story", id: "1", title: "T" },
      { __typename: "Writer", id: "2", name: "N", rating: 3 },
      { __typename: "Editor", id: "3", email: "s@x", role: "editor" },
    ]);
  });

  it("filters with __typename and $on, sorts by __typename and counts", async () => {
    const { calls, e } = engine("SearchHit", () => [{ c: 2 }]);
    await e.findMany({
      where: {
        __typename: { not: "Editor" },
        $on: { Story: { title: { contains: "graph" } }, Writer: {} },
      },
      orderBy: { __typename: "desc" },
      take: 5,
    });
    expect(calls[0]!.text).toBe(
      `MATCH (n) WHERE (${HIT}) AND ((NOT (n:\`Editor\`)) AND ` +
        "(((n:`Story`) AND (n.`title` CONTAINS $p0)) OR (n:`Writer`))) " +
        "WITH n ORDER BY CASE WHEN n:`Story` THEN $p1 WHEN n:`Writer` THEN $p2 WHEN n:`Editor` THEN $p3 ELSE $p4 END DESC LIMIT $p5 " +
        `RETURN ${ALL_SCALARS} AS row ` +
        "ORDER BY CASE WHEN n:`Story` THEN $p6 WHEN n:`Writer` THEN $p7 WHEN n:`Editor` THEN $p8 ELSE $p9 END DESC",
    );
    expect(await e.count({ where: { $on: {} } })).toBe(2);
    expect(calls[1]!.text).toBe(`MATCH (n) WHERE (${HIT}) AND (false) RETURN count(n) AS c`);
  });

  it("selects per member with $on, always reporting __typename", async () => {
    const { calls, e } = engine("SearchHit", () => [
      {
        row: {
          __labels: ["Story"],
          __on_Story: { title: "T", remarks: [{ id: "n1", text: "x" }] },
        },
      },
      { row: { __labels: ["Writer"] } },
    ]);
    const rows = await e.findMany({ select: { $on: { Story: { title: true, remarks: true } } } });
    expect(calls[0]!.text).toBe(
      `MATCH (n) WHERE ${HIT} RETURN n{\`__labels\`: labels(n), \`__on_Story\`: CASE WHEN n:\`Story\` THEN n{.\`title\`, \`remarks\`: COLLECT { MATCH (n)-[r1:\`HAS_REMARK\`]->(m0:\`Remark\`) RETURN m0{.\`id\`, .\`text\`} }} END} AS row`,
    );
    expect(rows).toEqual([
      { __typename: "Story", title: "T", remarks: [{ id: "n1", text: "x" }] },
      { __typename: "Writer" },
    ]);
  });

  it("loads, filters and counts relations to a union", async () => {
    const { calls, e } = engine("Shelf", () => []);
    await e.findMany({
      where: { items: { some: { $on: { Writer: { rating: { gte: 4 } } } } } },
      include: { items: { where: { __typename: "Story" } }, _count: { select: { items: true } } },
    });
    const text = calls[0]!.text;
    expect(text).toContain(
      "EXISTS { MATCH (n)-[:`SHOWS`]->(m0) WHERE (m0:`Story` OR m0:`Writer` OR m0:`Editor`) AND ((m0:`Writer`) AND (m0.`rating` >= $p0)) }",
    );
    expect(text).toContain(
      "`items`: COLLECT { MATCH (n)-[r2:`SHOWS`]->(m1) WHERE (m1:`Story` OR m1:`Writer` OR m1:`Editor`) AND (m1:`Story`) RETURN m1{",
    );
    expect(text).toContain(
      "`_count`: {`items`: COUNT { MATCH (n)-[:`SHOWS`]->(m3) WHERE m3:`Story` OR m3:`Writer` OR m3:`Editor` }}",
    );
  });

  it("never mixes `|` label expressions with implementations' `:A:B`", async () => {
    // Neo4j rejects a clause with both `(n:Editor:Contributor)` and `(m:A|B)`: unions use predicates.
    const { calls, e } = engine("Marker", () => []);
    await e.findMany({ where: { subject: { is: { $on: { Editor: { role: "x" } } } } } });
    expect(calls[0]!.text).not.toMatch(/`\|`/);
  });

  it("traverses into a union", () => {
    const ctx = new QueryContext(schemaModel);
    const shelf = schemaModel.nodes.find((n) => n.name === "Shelf")!;
    const c = compileTraverse(ctx, shelf, { from: { id: "b" }, via: [{ rel: "items" }] }, 10);
    expect(c.text).toBe(
      "MATCH (s:`Shelf`) WHERE s.`id` = $p0 MATCH (s)((:`Shelf`)-[e0:`SHOWS`]->(t1) WHERE (t1:`Story` OR t1:`Writer` OR t1:`Editor`)){1,1}(n) " +
        `WHERE (n <> s) AND (${HIT}) WITH DISTINCT n RETURN ${ALL_SCALARS} AS row`,
    );
  });

  it.each([
    "findUnique",
    "findUniqueOrThrow",
    "aggregate",
    "groupBy",
    "traverse",
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
        `SearchHit.${op}: SearchHit is a union; it supports findMany, findFirst, count, search and findSimilar (${op} goes through one of its members: Story, Writer, Editor).`,
      ),
    );
    expect(calls).toEqual([]);
  });

  it("rejects fields and unknown members in where / select", async () => {
    const { e } = engine("SearchHit");
    await expect(e.findMany({ where: { title: "x" } })).rejects.toThrow(
      'Unknown field "SearchHit.title" in where.',
    );
    await expect(e.findMany({ where: { $on: { Remark: {} } } })).rejects.toThrow(
      "where.$on.Remark: not a member of SearchHit (Story, Writer, Editor).",
    );
    await expect(e.findMany({ select: { $on: { Remark: { id: true } } } })).rejects.toThrow(
      "select.$on.Remark: not a member of SearchHit (Story, Writer, Editor).",
    );
    await expect(e.findMany({ where: { __typename: "Remark" } })).rejects.toThrow(
      'expected "Story" | "Writer" | "Editor", got "Remark"',
    );
  });

  it("rejects $on in the where of a node", async () => {
    const { e } = engine("Story");
    await expect(e.findMany({ where: { $on: {} } })).rejects.toThrow(
      "where.$on: Story is not an interface or a union",
    );
  });
});

describe("unions: writes through relations", () => {
  const ok = () => [{ row: { id: "b", name: "B" }, c2: 1, c3: 1, c6: 1, c8: 1 }];

  it("creates per member (batched by member) and connects a named member", async () => {
    const { calls, e } = engine("Shelf", ok);
    await e.create({
      data: {
        name: "B",
        items: {
          create: [{ Story: { title: "a" } }, { Story: { title: "b" } }, { Writer: { name: "c" } }],
          connect: { Editor: { email: "s@x" } },
        },
      },
    });
    const { text, params } = calls[0]!;
    expect(text).toBe(
      "CREATE (n:`Shelf` $p0) WITH n " +
        "CALL { WITH n MATCH (b0:`Editor`:`Contributor`) WHERE b0.`email` = $p1 WITH n, b0 LIMIT 1 MERGE (n)-[r1:`SHOWS`]->(b0) RETURN count(r1) AS c2 } " +
        "FOREACH (x3 IN $p2 | CREATE (c4:`Story`) SET c4 = x3.p CREATE (n)-[:`SHOWS`]->(c4)) " +
        "FOREACH (x6 IN $p3 | CREATE (c7:`Writer`) SET c7 = x6.p CREATE (n)-[:`SHOWS`]->(c7)) " +
        "RETURN n{.`id`, .`name`} AS row, c2",
    );
    expect((params.p2 as { p: Record<string, unknown> }[]).map((x) => x.p.title)).toEqual([
      "a",
      "b",
    ]);
    expect((params.p3 as { p: Record<string, unknown> }[])[0]!.p.name).toBe("c");
  });

  it("disconnects and sets by member keys", async () => {
    const { calls, e } = engine("Shelf", ok);
    await e.update({
      where: { id: "b" },
      data: { items: { disconnect: { Writer: { name: "a" } }, set: [{ Story: { id: "1" } }] } },
    });
    const text = calls[0]!.text;
    expect(text).toContain(
      "MATCH (n)-[r1:`SHOWS`]->(b0) WHERE (b0:`Story` OR b0:`Writer` OR b0:`Editor`) AND (((b0:`Writer`) AND (b0.`name` = $p1))) DELETE r1",
    );
    expect(text).toContain(
      "MATCH (n)-[r4:`SHOWS`]->(b3) WHERE (b3:`Story` OR b3:`Writer` OR b3:`Editor`) AND (NOT (((b3:`Story`) AND (b3.`id` = $p2)))) DELETE r4",
    );
    expect(text).toContain("MATCH (b6:`Story`) WHERE b6.`id` = $p3");
  });

  it("replaces the edge of a to-one union relation and of its inverse", async () => {
    const { calls, e } = engine("Marker", () => [{ row: { id: "p", label: "l" }, c6: 1 }]);
    await e.create({ data: { label: "l", subject: { connect: { Story: { id: "a" } } } } });
    const text = calls[0]!.text;
    // Marker.subject: drop the edge to any other member.
    expect(text).toContain(
      "OPTIONAL MATCH (n)-[o3:`MARKS`]->(x2) WHERE (x2:`Story` OR x2:`Writer` OR x2:`Editor`) AND (x2 <> b0) DELETE o3",
    );
    // Story.marker (the to-one inverse): drop the story's edge from another marker.
    expect(text).toContain(
      "OPTIONAL MATCH (x4:`Marker`)-[o5:`MARKS`]->(b0) WHERE x4 <> n DELETE o5",
    );
  });

  it("keeps the inverse to-one union field consistent from the member's side", async () => {
    const { calls, e } = engine("Story", () => [{ row: { id: "a", title: "t" }, c6: 1 }]);
    await e.create({ data: { title: "t", marker: { connect: { id: "p" } } } });
    expect(calls[0]!.text).toContain(
      "OPTIONAL MATCH (x4)<-[o5:`MARKS`]-(b0) WHERE (x4:`Story` OR x4:`Writer` OR x4:`Editor`) AND (x4 <> n) DELETE o5",
    );
  });

  it.each([
    [{ connect: { id: "x" } }, "connect: SearchHit is a union; name the member of each item"],
    [{ connect: { Story: { id: "x" }, Writer: { id: "y" } } }, "got Story, Writer"],
    [{ create: { Remark: { text: "x" } } }, "(one of Story, Writer, Editor), got Remark"],
    [{ connect: { Story: { title: "x" } } }, "where must set at least one unique field (id)"],
  ])("rejects a relation write %j without exactly one member", async (items, message) => {
    const { calls, e } = engine("Shelf", ok);
    await expect(e.create({ data: { name: "B", items } })).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it("checks the validation rules of the member a nested create names", async () => {
    const { calls, e } = engine("Shelf", ok);
    await expect(
      e.create({ data: { name: "B", items: { create: { Story: { title: "x".repeat(201) } } } } }),
    ).rejects.toMatchObject({
      issues: [{ path: ["data", "items", "create", "Story", "title"] }],
    });
    expect(calls).toEqual([]);
  });

  it("cascades into a union with each member's own rules", () => {
    const shelf = schemaModel.nodes.find((n) => n.name === "Shelf")!;
    expect(hasDeleteRules(schemaModel, shelf)).toBe(true);
  });
});

describe("unions: typed edges and interface members", () => {
  it("sets $edge on the edge of each named member", async () => {
    const { calls, e } = engine("Shelf", () => [{ row: { id: "b", name: "B" }, c2: 1 }]);
    await e.create({
      data: {
        name: "B",
        picks: {
          create: { Story: { title: "a" }, $edge: { rank: 2 } },
          connect: { Writer: { name: "w" }, $edge: { note: "n" } },
        },
      },
    });
    const { text, params } = calls[0]!;
    expect(text).toContain(
      "MERGE (n)-[r1:`PICKS`]->(b0) ON CREATE SET r1 += $p2 ON MATCH SET r1 += $p3",
    );
    // A new edge gets the defaults with the given values; an existing one the given values.
    expect(String((params.p2 as { rank: unknown }).rank)).toBe("0");
    expect(params.p3).toEqual({ note: "n" });
    expect(text).toContain("CREATE (n)-[r5:`PICKS`]->(c4) SET r5 = x3.e");
    expect(String((params.p4 as { e: { rank: unknown } }[])[0]!.e.rank)).toBe("2");
    await expect(
      e.create({
        data: { name: "B", picks: { connect: { Writer: { name: "w" }, $edge: { rank: -1 } } } },
      }),
    ).rejects.toThrow(CyphraValidationError);
  });

  it("matches an interface member by its own label and filters through it with $on", async () => {
    const { calls, e } = engine("Party", () => []);
    await e.findMany({ where: { $on: { Contributor: { email: "e" }, Writer: {} } } });
    expect(calls[0]!.text).toContain(
      "MATCH (n) WHERE (n:`Contributor` OR n:`Writer`) AND (((n:`Contributor`) AND (n.`email` = $p0)) OR (n:`Writer`))",
    );
    await expect(e.findMany({ where: { $on: { Story: {} } } })).rejects.toThrow(
      "not a member of Party (Contributor, Editor, Reviewer, Writer)",
    );
  });

  it("connects through an interface member by its unique key", async () => {
    const { calls, e } = engine("Desk", () => [{ row: { id: "d", name: "D" }, c4: 1 }]);
    await e.create({
      data: { name: "D", owner: { connect: { Contributor: { email: "e" } } } },
    });
    // The to-one edge to any node of the union is replaced.
    expect(calls[0]!.text).toContain(
      "MATCH (b0:`Contributor`) WHERE b0.`email` = $p1 WITH n, b0 LIMIT 1 SET n.`__cyphraLock` = true",
    );
    expect(calls[0]!.text).toContain(
      "OPTIONAL MATCH (n)-[o3:`OWNS`]->(x2) WHERE (x2:`Contributor` OR x2:`Writer`) AND (x2 <> b0) DELETE o3",
    );
    await expect(
      e.create({ data: { name: "D", owner: { connect: { Story: { id: "s" } } } } }),
    ).rejects.toThrow("one of Contributor, Editor, Reviewer, Writer");
  });
});

describe("unions: dialects", () => {
  it("runs the same statements on Memgraph and FalkorDB", async () => {
    for (const dialect of ["memgraph", "falkordb"] as const) {
      const { calls, e } = engine("SearchHit", () => [], dialect);
      await e.findMany({ where: { __typename: "Writer" } });
      expect(calls[0]!.text).toBe(
        `MATCH (n) WHERE (${HIT}) AND (n:\`Writer\`) RETURN ${ALL_SCALARS} AS row`,
      );
    }
  });
});
