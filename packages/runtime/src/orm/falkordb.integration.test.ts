/**
 * FalkorDB-only checks (run with `CYPHRA_TEST_DIALECT=falkordb` and `FALKORDB_TEST_URL`): the
 * transport's values, temporal values stored as ISO 8601 text, vector and full-text search through
 * FalkorDB's indexes, the features FalkorDB lacks (clear `UnsupportedFeatureError`s), and the
 * statement rewrite. The shared suites (orm.integration.test.ts, …) cover everything else.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { createOrm } from "./client.js";
import { CyphraValidationError, UniqueConstraintError, UnsupportedFeatureError } from "./errors.js";
import { CyphraClient } from "../client.js";
import { detectDialect } from "../dialect.js";
import { FalkorDBDriver, FalkorDBError } from "../falkordb/driver.js";
import { CypherNode, CypherPath, CypherRelationship, isInt } from "../cypher-values.js";
import { FALKORDB_TEST_GRAPH, onFalkorDB } from "./__fixtures__/testDialect.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const url = process.env.FALKORDB_TEST_URL;
const hasFalkorDB = onFalkorDB && Boolean(url);
const graph = `${FALKORDB_TEST_GRAPH}_fk`;

const schema = resolveSchema(
  parseSchema(`
    node FkEvent {
      id        String         @id
      at        DateTime
      day       Date?
      local     LocalDateTime?
      clock     LocalTime?
      zoned     Time?
      stay      Duration?
      count     Int?
      ratio     Float?
      big       BigInt?
      title     String?
      body      String?
      place     Point?
      embedding Vector(3)?     @vectorIndex(similarity: cosine)
      sketch    Vector(2)?     @vectorIndex(similarity: euclidean)
      links     FkEvent[]      @relationship(type: "FK_LINK", direction: OUT)
      @@fulltext([title, body], name: "fkEventSearch")
    }
  `),
);

type Delegate = Record<string, (args?: unknown) => Promise<unknown>>;
type Row = Record<string, unknown>;
type UntypedDb = {
  fkEvent: Delegate;
  $cypher<T = Row>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  $transaction<T>(fn: (tx: UntypedDb) => Promise<T>): Promise<T>;
  $client: CyphraClient;
  $disconnect(): Promise<void>;
};

describe.skipIf(!hasFalkorDB)("FalkorDB transport", () => {
  let client: CyphraClient;

  beforeAll(() => {
    client = new CyphraClient({ falkordb: { url: url!, graph } });
  });

  afterAll(async () => {
    await client?.close();
  });

  const one = async (text: string, params: Row = {}) =>
    client.withSession(async (s) => {
      const r = (await s.run(text, params)) as unknown as {
        records: { toObject(): Row }[];
      };
      return r.records.map((x) => x.toObject())[0]!;
    });

  it("has the falkordb dialect and transport", async () => {
    expect(client.dialect).toBe("falkordb");
    expect(client.transport).toBe("falkordb");
    expect(await detectDialect(client)).toBe("falkordb");
    expect(() => new CyphraClient({ dialect: "falkordb" } as never)).toThrow(CyphraValidationError);
    expect(
      () => new CyphraClient({ falkordb: { url: url!, graph }, dialect: "neo4j" } as never),
    ).toThrow(CyphraValidationError);
  });

  it("sends parameters as literals: integers stay integers, numbers are floats", async () => {
    const row = await one(
      "RETURN $i AS i, typeOf($i) AS ti, $f AS f, typeOf($f) AS tf, $s AS s, $l AS l, $m.k AS mk, $b AS b, $n AS n",
      {
        i: 42n,
        f: 2,
        s: 'quote " and \\ backslash\nnewline',
        l: [1.5, "x"],
        m: { k: true },
        b: false,
        n: null,
      },
    );
    expect(isInt(row.i)).toBe(true);
    expect(String(row.i)).toBe("42");
    expect(row.ti).toBe("Integer");
    expect(row.f).toBe(2);
    expect(row.tf).toBe("Float");
    expect(row.s).toBe('quote " and \\ backslash\nnewline');
    expect(row.l).toEqual([1.5, "x"]);
    expect(row.mk).toBe(true);
    expect(row.b).toBe(false);
    expect(row.n).toBeNull();
  });

  it("decodes nodes, relationships and paths", async () => {
    await one("CREATE (:FkT {name: 'a'})-[:FK_T {w: 1}]->(:FkT {name: 'b'})");
    const row = await one("MATCH p = (a:FkT)-[r:FK_T]->(b:FkT) RETURN a, r, p");
    expect(row.a).toBeInstanceOf(CypherNode);
    expect((row.a as CypherNode).labels).toEqual(["FkT"]);
    expect((row.a as CypherNode).properties).toEqual({ name: "a" });
    expect(row.r).toBeInstanceOf(CypherRelationship);
    expect((row.r as CypherRelationship).type).toBe("FK_T");
    expect((row.r as CypherRelationship).startNodeElementId).toBe((row.a as CypherNode).elementId);
    const p = row.p as CypherPath;
    expect(p).toBeInstanceOf(CypherPath);
    expect(p.length).toBe(1);
    expect(p.end.properties).toEqual({ name: "b" });
    await one("MATCH (n:FkT) DETACH DELETE n");
  });

  it("reports FalkorDB errors with a code, and unreachable servers", async () => {
    const err = await one("RETURN 1 +* 2").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FalkorDBError);
    expect((err as FalkorDBError).code).toBe("FalkorDB.Error");
    const down = new FalkorDBDriver({
      url: "redis://127.0.0.1:1",
      graph,
      connectOptions: { socket: { reconnectStrategy: false, connectTimeout: 500 } },
    });
    const e = await down.verifyConnectivity().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FalkorDBError);
    expect((e as FalkorDBError).code).toBe("FalkorDB.ConnectionError");
    await down.close();
  });
});

describe.skipIf(!hasFalkorDB)("FalkorDB ORM", () => {
  let db: UntypedDb;
  const run = (text: string) =>
    db.$client.withSession(async (s) => {
      await s.run(text).catch((e: unknown) => {
        if (!/already (indexed|exists)/i.test(String(e))) throw e;
      });
    });

  beforeAll(async () => {
    db = createOrm(schema, { falkordb: { url: url!, graph } }) as unknown as UntypedDb;
    await db.$cypher`MATCH (n) DETACH DELETE n`;
    // What `cyphra push` creates for the schema on FalkorDB.
    await run("GRAPH.CONSTRAINT CREATE UNIQUE NODE `FkEvent` PROPERTIES 1 `id`");
    await run(
      "CREATE VECTOR INDEX FOR (n:`FkEvent`) ON (n.`embedding`) OPTIONS {dimension: 3, similarityFunction: 'cosine'}",
    );
    await run(
      "CREATE VECTOR INDEX FOR (n:`FkEvent`) ON (n.`sketch`) OPTIONS {dimension: 2, similarityFunction: 'euclidean'}",
    );
    await run("CREATE FULLTEXT INDEX FOR (n:`FkEvent`) ON (n.`title`, n.`body`)");
  });

  beforeEach(async () => {
    await db.$cypher`MATCH (n:FkEvent) DETACH DELETE n`;
  });

  afterAll(async () => {
    if (!db) return;
    await db.$cypher`MATCH (n) DETACH DELETE n`;
    await db.$disconnect();
  });

  const ids = (rows: unknown) => (rows as { id: string }[]).map((r) => r.id);

  it("stores temporal values as ISO 8601 text and filters, sorts and aggregates them", async () => {
    const base = {
      day: new Date("2024-02-29T00:00:00Z"),
      local: "2024-03-10T07:30:15.123456789",
      clock: "07:30:15.5",
      zoned: "07:30:15+02:00",
      stay: "P1Y2M3DT4H5M6.5S",
    };
    await db.fkEvent.create({
      data: { id: "e1", at: new Date("2024-03-10T07:30:15.123Z"), ...base },
    });
    await db.fkEvent.create({ data: { id: "e2", at: new Date("2023-01-01T00:00:00Z") } });
    await db.fkEvent.create({ data: { id: "e3", at: new Date("2025-06-01T12:00:00.999Z") } });

    const e1 = (await db.fkEvent.findUnique({ where: { id: "e1" } })) as Row;
    expect((e1.at as Date).toISOString()).toBe("2024-03-10T07:30:15.123Z");
    expect((e1.day as Date).toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(e1).toMatchObject({
      local: "2024-03-10T07:30:15.123456789",
      clock: "07:30:15.5",
      zoned: "07:30:15+02:00",
      stay: "P1Y2M3DT4H5M6.5S",
    });
    const [raw] = await db.$cypher<{ at: string; t: string }>`
      MATCH (n:FkEvent {id: "e1"}) RETURN n.at AS at, typeOf(n.at) AS t`;
    expect(raw).toEqual({ at: "2024-03-10T07:30:15.123Z", t: "String" });

    const after = new Date("2024-01-01T00:00:00Z");
    expect(
      ids(await db.fkEvent.findMany({ where: { at: { gt: after } }, orderBy: { id: "asc" } })),
    ).toEqual(["e1", "e3"]);
    expect(ids(await db.fkEvent.findMany({ orderBy: { at: "desc" } }))).toEqual(["e3", "e1", "e2"]);
    expect(await db.fkEvent.count({ where: { at: new Date("2024-03-10T07:30:15.123Z") } })).toBe(1);
    const agg = (await db.fkEvent.aggregate({ _min: { at: true }, _max: { at: true } })) as {
      _min: { at: Date };
      _max: { at: Date };
    };
    expect(agg._min.at.toISOString()).toBe("2023-01-01T00:00:00.000Z");
    expect(agg._max.at.toISOString()).toBe("2025-06-01T12:00:00.999Z");
  });

  it("keeps Int, Float and BigInt types", async () => {
    await db.fkEvent.create({
      data: { id: "n1", at: new Date(), count: 3, ratio: 2, big: 2n ** 60n },
    });
    await db.fkEvent.update({
      where: { id: "n1" },
      data: { ratio: { multiply: 0.25 }, count: { increment: 1 } },
    });
    const [row] = await db.$cypher<{ c: string; r: string; b: string }>`
      MATCH (n:FkEvent {id: "n1"}) RETURN typeOf(n.count) AS c, typeOf(n.ratio) AS r, toString(n.big) AS b`;
    expect(row).toEqual({ c: "Integer", r: "Float", b: String(2n ** 60n) });
    expect(await db.fkEvent.findUnique({ where: { id: "n1" } })).toMatchObject({
      count: 4,
      ratio: 0.5,
      big: 2n ** 60n,
    });
  });

  it("stores vectors as FalkorDB vectors and searches them through the index or exactly", async () => {
    const vectors: [string, number[], number[]][] = [
      ["v1", [1, 0, 0], [0, 0]],
      ["v2", [0.9, 0.1, 0], [1, 0]],
      ["v3", [0, 1, 0], [3, 4]],
    ];
    for (const [id, embedding, sketch] of vectors) {
      await db.fkEvent.create({ data: { id, at: new Date(), embedding, sketch, title: id } });
    }
    await db.fkEvent.createMany({ data: [{ id: "v4", at: new Date(), embedding: [0, 0, 1] }] });
    const [t] = await db.$cypher<{
      t: string;
    }>`MATCH (n:FkEvent {id: "v4"}) RETURN typeOf(n.embedding) AS t`;
    expect(t!.t).toBe("Vectorf32");
    expect(((await db.fkEvent.findUnique({ where: { id: "v2" } })) as Row).embedding).toEqual([
      expect.closeTo(0.9, 5),
      expect.closeTo(0.1, 5),
      0,
    ]);

    const hits = (await db.fkEvent.findSimilar({
      field: "embedding",
      vector: [1, 0, 0],
      k: 2,
    })) as {
      id: string;
      $score: number;
    }[];
    expect(ids(hits)).toEqual(["v1", "v2"]);
    expect(hits[0]!.$score).toBeCloseTo(1, 4);
    const cos = 0.9 / Math.sqrt(0.82);
    expect(hits[1]!.$score).toBeCloseTo((1 + cos) / 2, 4);

    const exact = (await db.fkEvent.findSimilar({
      field: "embedding",
      vector: [1, 0, 0],
      k: 2,
      exact: true,
    })) as { $score: number }[];
    expect(exact.map((h) => h.$score)).toEqual(hits.map((h) => expect.closeTo(h.$score, 4)));

    const filtered = await db.fkEvent.findSimilar({
      field: "embedding",
      vector: [1, 0, 0],
      k: 1,
      where: { title: { not: "v1" } },
    });
    expect(ids(filtered)).toEqual(["v2"]);

    // Euclidean: 1 / (1 + d²), d the distance.
    const near = (await db.fkEvent.findSimilar({ field: "sketch", vector: [0, 0], k: 3 })) as {
      id: string;
      $score: number;
    }[];
    expect(ids(near)).toEqual(["v1", "v2", "v3"]);
    expect(near.map((h) => h.$score)).toEqual([1, 0.5, 1 / 26].map((x) => expect.closeTo(x, 4)));

    await db.fkEvent.update({ where: { id: "v3" }, data: { embedding: [1, 0, 0] } });
    expect(
      ids(await db.fkEvent.findSimilar({ field: "embedding", vector: [1, 0, 0], k: 2 })).sort(),
    ).toEqual(["v1", "v3"]);
  });

  it("searches the label's full-text index with RediSearch queries", async () => {
    const rows = [
      ["f1", "Graph databases", "Graphs everywhere. Graph graph graph."],
      ["f2", "Production notes", "Running graph workloads in production"],
      ["f3", "Cooking", "Recipes and a pinch of salt"],
    ];
    for (const [id, title, body] of rows) {
      await db.fkEvent.create({ data: { id, at: new Date(), title, body } });
    }
    const search = (query: string, mode?: string, extra: Row = {}) =>
      db.fkEvent.search({ index: "fkEventSearch", query, ...(mode ? { mode } : {}), ...extra });
    let hits: unknown[] = [];
    // The index is updated as nodes are written; retry briefly anyway.
    for (let i = 0; i < 20 && hits.length < 2; i++)
      hits = (await search("graph", "terms")) as unknown[];
    expect(ids(hits).sort()).toEqual(["f1", "f2"]);
    // FalkorDB 4.22 reports a score of 0 for full-text hits: a number, best first.
    const scores = (hits as { $score: number }[]).map((h) => h.$score);
    expect(scores.every((x) => typeof x === "number" && x >= 0)).toBe(true);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(ids(await search("salt pinch", "terms"))).toEqual(["f3"]);
    expect(ids(await search("graph workloads", "phrase"))).toEqual(["f2"]);
    expect(ids(await search("grap*", "lucene", { where: { id: { not: "f1" } } }))).toEqual(["f2"]);
    expect(await search("   ", "terms")).toEqual([]);
  });

  it("maps uniqueness violations to UniqueConstraintError with the fields", async () => {
    await db.fkEvent.create({ data: { id: "u1", at: new Date() } });
    const err = await db.fkEvent
      .create({ data: { id: "u1", at: new Date() } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UniqueConstraintError);
    expect(err).toMatchObject({
      model: "FkEvent",
      fields: ["id"],
      code: "FalkorDB.ConstraintViolation",
    });
    const many = await db.fkEvent
      .createMany({
        data: [
          { id: "u2", at: new Date() },
          { id: "u2", at: new Date() },
        ],
      })
      .catch((e: unknown) => e);
    expect(many).toMatchObject({ model: "FkEvent", fields: ["id"] });
    // One statement: nothing of the batch was written.
    expect(await db.fkEvent.count({ where: { id: "u2" } })).toBe(0);
  });

  it("refuses what FalkorDB cannot do, before running anything", async () => {
    await expect(db.$transaction(async () => 1)).rejects.toBeInstanceOf(UnsupportedFeatureError);
    const err = await db.fkEvent
      .create({ data: { id: "p1", at: new Date(), place: { longitude: 2.35, latitude: 48.85 } } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedFeatureError);
    expect((err as UnsupportedFeatureError).dialect).toBe("falkordb");
    expect(await db.fkEvent.count({ where: { id: "p1" } })).toBe(0);
  });

  it("runs relation filters, counts and includes through CALL subqueries", async () => {
    await db.fkEvent.create({
      data: {
        id: "r1",
        at: new Date(),
        links: {
          create: [
            { id: "r2", at: new Date(), title: "b" },
            { id: "r3", at: new Date(), title: "a" },
          ],
        },
      },
    });
    const row = (await db.fkEvent.findUnique({
      where: { id: "r1" },
      select: {
        id: true,
        links: { select: { id: true }, orderBy: { title: "asc" }, take: 1 },
        _count: { select: { links: true } },
      },
    })) as Row;
    expect(row).toEqual({ id: "r1", links: [{ id: "r3" }], _count: { links: 2 } });
    expect(ids(await db.fkEvent.findMany({ where: { links: { some: { title: "a" } } } }))).toEqual([
      "r1",
    ]);
    expect(
      ids(
        await db.fkEvent.findMany({
          where: { links: { none: {} }, id: { startsWith: "r" } },
          orderBy: { id: "asc" },
        }),
      ),
    ).toEqual(["r2", "r3"]);
  });
});
