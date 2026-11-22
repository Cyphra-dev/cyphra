/**
 * Memgraph-only checks (run with `CYPHRA_TEST_DIALECT=memgraph`): text search through
 * `text_search.search_all`, the features Memgraph lacks (clear `UnsupportedFeatureError`s before
 * anything runs), errors Memgraph reports as transient that must not be retried, and dialect
 * detection. The shared suites (orm.integration.test.ts, …) cover everything else on Memgraph.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createClient as createSearchClient,
  type Db as SearchDb,
} from "./__fixtures__/search.gen.js";
import { createClient as createGeoClient } from "./__fixtures__/geo.gen.js";
import { createClient as createBlogClient } from "./__fixtures__/blog.gen.js";
import { onMemgraph, retryStorageAccess, testDialect } from "./__fixtures__/testDialect.js";
import { CyphraError, UnsupportedFeatureError } from "./errors.js";
import { CyphraClient } from "../client.js";
import { detectDialect } from "../dialect.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const hasMemgraph =
  onMemgraph &&
  Boolean(
    process.env.NEO4J_TEST_URI && process.env.NEO4J_TEST_USER && process.env.NEO4J_TEST_PASSWORD,
  );

const conn = () => ({
  uri: process.env.NEO4J_TEST_URI!,
  user: process.env.NEO4J_TEST_USER!,
  password: process.env.NEO4J_TEST_PASSWORD!,
});

describe.skipIf(!hasMemgraph)("Memgraph text search", () => {
  let db: SearchDb;
  // Schema statements: other suites' transactions can hold the storage (see retryStorageAccess).
  const run = (text: string) =>
    retryStorageAccess(() =>
      db.$client.withSession(async (s) => {
        await s.run(text);
      }),
    );

  beforeAll(async () => {
    db = createSearchClient({ ...conn(), dialect: testDialect });
    await db.$cypher`MATCH (n) WHERE n:FtAuthor OR n:FtPost DETACH DELETE n`;
    // What `cyphra push` creates for @@fulltext([title, body], name: "ftPostSearch") on Memgraph.
    await run("DROP TEXT INDEX ftPostSearch").catch(() => undefined);
    await run("CREATE TEXT INDEX ftPostSearch ON :`FtPost`(`title`, `body`)");
    // One transaction: Memgraph commits its text index once per write transaction.
    await db.$transaction(async (tx) => {
      await tx.ftAuthor.create({ data: { id: "ada", name: "Ada", country: "UK" } });
      await tx.ftAuthor.create({ data: { id: "bob", name: "Bob", country: "FR" } });
      const posts = [
        ["p1", "Graph databases", "Graphs everywhere. Graph graph graph.", "ada", true],
        ["p2", "Production notes", "Running graph workloads in production", "bob", true],
        ["p3", "C++ macros", "Macros (beta) and templates", "ada", false],
        ["p4", "Cooking", "Recipes and a graph of flavours", "ada", true],
      ] as const;
      for (const [id, title, body, author, published] of posts) {
        await tx.ftPost.create({
          data: { id, title, body, tags: [], published, author: { connect: { id: author } } },
        });
      }
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.$cypher`MATCH (n) WHERE n:FtAuthor OR n:FtPost DETACH DELETE n`;
    await run("DROP TEXT INDEX ftPostSearch").catch(() => undefined);
    await db.$disconnect();
  });

  const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

  it("ranks matches across the indexed fields, best first, with $score", async () => {
    const hits = await db.ftPost.search({ index: "ftPostSearch", query: "graph" });
    expect(ids(hits)[0]).toBe("p1");
    expect(ids(hits).sort()).toEqual(["p1", "p2", "p4"]);
    expect(hits.every((h) => h.$score > 0)).toBe(true);
    expect(hits.map((h) => h.$score)).toEqual([...hits.map((h) => h.$score)].sort((a, b) => b - a));
    expect(hits[0]).toMatchObject({ id: "p1", title: "Graph databases", published: true });
  });

  it("filters with where, pages, and drops results below minScore", async () => {
    const byBob = await db.ftPost.search({
      index: "ftPostSearch",
      query: "graph",
      where: { author: { is: { country: "FR" } } },
      select: { id: true, author: { select: { name: true } } },
    });
    expect(byBob).toEqual([{ id: "p2", author: { name: "Bob" }, $score: expect.any(Number) }]);
    const all = await db.ftPost.search({ index: "ftPostSearch", query: "graph" });
    const page = await db.ftPost.search({
      index: "ftPostSearch",
      query: "graph",
      skip: 1,
      take: 1,
    });
    expect(ids(page)).toEqual([all[1]!.id]);
    const strong = await db.ftPost.search({
      index: "ftPostSearch",
      query: "graph",
      minScore: all[0]!.$score,
    });
    expect(ids(strong)).toEqual(["p1"]);
  });

  it("supports boolean queries, terms and phrase modes", async () => {
    expect(
      ids(await db.ftPost.search({ index: "ftPostSearch", query: "graph AND production" })),
    ).toEqual(["p2"]);
    expect(
      ids(await db.ftPost.search({ index: "ftPostSearch", query: "C++ (beta", mode: "terms" })),
    ).toEqual(["p3"]);
    expect(
      ids(
        await db.ftPost.search({ index: "ftPostSearch", query: "graph databases", mode: "phrase" }),
      ),
    ).toEqual(["p1"]);
    expect(await db.ftPost.search({ index: "ftPostSearch", query: "  " })).toEqual([]);
  });

  it("skips nodes deleted since the index's last garbage collection", async () => {
    await db.ftPost.create({
      data: { id: "gone", title: "Ephemeral graph", tags: [], published: true },
    });
    await db.ftPost.delete({ where: { id: "gone" } });
    const hits = await db.ftPost.search({ index: "ftPostSearch", query: "ephemeral" });
    expect(hits).toEqual([]);
  });
});

describe.skipIf(!hasMemgraph)("Memgraph unsupported features and errors", () => {
  let geo: ReturnType<typeof createGeoClient>;
  let blog: ReturnType<typeof createBlogClient>;

  beforeAll(() => {
    geo = createGeoClient({ ...conn(), dialect: testDialect });
    blog = createBlogClient({ ...conn(), dialect: testDialect });
  });

  afterAll(async () => {
    if (!geo) return;
    await geo.$cypher`MATCH (n:GeoPlace) DETACH DELETE n`;
    await geo.$disconnect();
    await blog.$disconnect();
  });

  it("rejects Time values and month durations before running anything", async () => {
    const write = geo.geoPlace.create({
      data: { id: "t", name: "T", location: { latitude: 0, longitude: 0 }, slot: "10:00Z" },
    });
    await expect(write).rejects.toBeInstanceOf(UnsupportedFeatureError);
    await expect(write).rejects.toThrow(/is not supported on Memgraph/);
    await expect(
      geo.geoPlace.create({
        data: { id: "m", name: "M", location: { latitude: 0, longitude: 0 }, stay: "P1M" },
      }),
    ).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(await geo.geoPlace.count()).toBe(0);
  });

  it("does not retry errors Memgraph reports as transient but retrying cannot fix", async () => {
    const started = Date.now();
    await expect(blog.$cypher`RETURN duration(${"P1M"}) AS d`).rejects.toBeInstanceOf(CyphraError);
    // The driver would otherwise retry for 30 s.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("refuses the HTTP transport", () => {
    expect(() => new CyphraClient({ uri: "http://localhost:7444", dialect: "memgraph" })).toThrow(
      UnsupportedFeatureError,
    );
  });

  it("detects Memgraph from the Bolt server agent", async () => {
    expect(await detectDialect(blog.$client)).toBe("memgraph");
  });

  it("points at the dialect option when a Neo4j-dialect client talks to Memgraph", async () => {
    const neo = createBlogClient(conn());
    try {
      const err = await neo.user
        .traverse({ from: { email: "x@x.io" }, via: "following", depth: { max: 2 } })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CyphraError);
      expect((err as Error).message).toMatch(/dialect: "memgraph"/);
    } finally {
      await neo.$disconnect();
    }
  });
});
