import { CyphraClient, createOrm } from "@cyphra/runtime";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientForConfig } from "../clientFromEnv.js";
import { createStudioApi, type StudioApi } from "./api.js";
import { createStudioDb } from "./db.js";
import type { StudioMeta } from "./protocol.js";
import { buildMeta } from "./values.js";

/**
 * The studio API against Memgraph, through the real ORM with the dialect the CLI detects. Every
 * label and type is prefixed with `Smg` / `SMG_` and only those nodes are deleted, so the suite
 * can share the test database.
 */
const enabled = Boolean(
  process.env.NEO4J_TEST_URI &&
  process.env.NEO4J_TEST_USER &&
  process.env.NEO4J_TEST_PASSWORD &&
  process.env.CYPHRA_TEST_DIALECT === "memgraph",
);

const schema = resolveSchema(
  parseSchema(`
enum SmgRole {
  ADMIN
  READER
}

interface SmgPerson {
  id    String @id
  email String @unique @email
}

node SmgUser implements SmgPerson {
  name      String    @length(2, 40)
  role      SmgRole   @default(READER)
  balance   BigInt    @default(0)
  tags      String[]
  settings  Json?
  born      Date?
  opensAt   Time?
  wait      Duration?
  posts     SmgPost[] @relationship(type: "SMG_AUTHORED", direction: OUT, onDelete: Cascade)
  following SmgUser[] @relationship(type: "SMG_FOLLOWS", direction: OUT)
}

node SmgPost {
  id     String   @id
  title  String   @length(3, 100)
  author SmgUser? @relationship(type: "SMG_AUTHORED", direction: IN)
}

relationship SmgFollows {
  type "SMG_FOLLOWS"
  from SmgUser
  to SmgUser
  since DateTime?
  muted Boolean  @default(false)
}
`),
);

const CONSTRAINT = "CONSTRAINT ON (n:SmgPerson) ASSERT n.email IS UNIQUE";

describe.skipIf(!enabled)("studio API (Memgraph)", () => {
  let client: CyphraClient;
  let api: StudioApi;
  let readOnly: StudioApi;
  let meta: StudioMeta;
  const saved: Record<string, string | undefined> = {};

  const wipe = () =>
    client.withSession((s) =>
      s.run("MATCH (n) WHERE n:SmgUser OR n:SmgPost OR n:SmgPerson DETACH DELETE n"),
    );
  const post = async (a: StudioApi, path: string, body: unknown) => a.handle("POST", path, body);
  const ok = async <T>(a: StudioApi, path: string, body: unknown): Promise<T> => {
    const res = await post(a, path, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as T;
  };

  beforeAll(async () => {
    for (const k of ["NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD", "NEO4J_DATABASE"]) {
      saved[k] = process.env[k];
    }
    process.env.NEO4J_URI = process.env.NEO4J_TEST_URI;
    process.env.NEO4J_USERNAME = process.env.NEO4J_TEST_USER;
    process.env.NEO4J_PASSWORD = process.env.NEO4J_TEST_PASSWORD;
    delete process.env.NEO4J_DATABASE;
    // As `cyphra studio` does: cyphra.json sets no dialect, so it is detected from the server.
    client = await clientForConfig({});
    await wipe();
    // Own constraint (dropped in afterAll) so duplicate emails raise a UniqueConstraintError.
    await client.withSession(async (s) => {
      await s.run(`DROP ${CONSTRAINT}`).catch(() => {});
      await s.run(`CREATE ${CONSTRAINT}`);
    });
    const orm = createOrm(schema, { client }) as unknown as Record<string, unknown>;
    const db = createStudioDb(orm, client);
    const info = { connection: "bolt://test", version: "0.0.0", dialect: client.dialect };
    meta = buildMeta(schema, { ...info, readOnly: false });
    api = createStudioApi({ schema, db, meta, readOnly: false });
    readOnly = createStudioApi({
      schema,
      db,
      meta: buildMeta(schema, { ...info, readOnly: true }),
      readOnly: true,
    });
  });

  afterAll(async () => {
    if (!client) return;
    await wipe();
    await client.withSession((s) => s.run(`DROP ${CONSTRAINT}`)).catch(() => {});
    await client.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("detects Memgraph and exposes it in the meta", async () => {
    expect(client.dialect).toBe("memgraph");
    expect((await api.handle("GET", "/api/meta", undefined)).body).toMatchObject({
      dialect: "memgraph",
    });
    const user = meta.nodes.find((n) => n.name === "SmgUser")!;
    expect(user.fields.find((f) => f.name === "opensAt")).toHaveProperty("unsupported");
    expect(user.fields.find((f) => f.name === "wait")).not.toHaveProperty("unsupported");
  });

  it("creates records with typed values and reports validation issues", async () => {
    const created = await ok<{ row: Record<string, unknown> }>(api, "/api/models/SmgUser/create", {
      data: {
        id: "u1",
        email: "ada@example.com",
        name: "Ada",
        role: "ADMIN",
        balance: "9007199254740993",
        tags: ["math", "engines"],
        settings: { theme: "dark" },
        born: "1815-12-10",
        wait: "PT1H30M",
      },
    });
    expect(created.row).toMatchObject({
      id: "u1",
      role: "ADMIN",
      balance: "9007199254740993",
      tags: ["math", "engines"],
      settings: { theme: "dark" },
      born: "1815-12-10T00:00:00.000Z",
    });
    await ok(api, "/api/models/SmgUser/create", {
      data: { id: "u2", email: "alan@example.com", name: "Alan" },
    });

    const invalid = await post(api, "/api/models/SmgUser/create", {
      data: { id: "u3", email: "not-an-email", name: "A" },
    });
    expect(invalid.status).toBe(400);

    const dup = await post(api, "/api/models/SmgUser/create", {
      data: { id: "u4", email: "ada@example.com", name: "Again" },
    });
    expect(dup.status).toBe(409);
    expect((dup.body as { fields: string[] }).fields).toEqual(["email"]);
  });

  it("refuses what Memgraph cannot store with a clear message", async () => {
    const time = await post(api, "/api/models/SmgUser/update", {
      where: { id: "u1" },
      data: { opensAt: "09:00:00+02:00" },
    });
    expect(time.status).toBe(400);
    expect(time.body).toMatchObject({
      error: expect.stringMatching(/^SmgUser\.opensAt cannot be written on Memgraph/),
      unsupported: { dialect: "memgraph" },
      issues: [{ field: "opensAt" }],
    });
    const months = await post(api, "/api/models/SmgUser/update", {
      where: { id: "u1" },
      data: { wait: "P1M" },
    });
    expect(months.status).toBe(400);
    expect(months.body).toMatchObject({
      error: expect.stringMatching(/not supported on Memgraph/),
      unsupported: { dialect: "memgraph" },
    });
    // A Time filter value is refused by the ORM before the statement runs.
    const filter = await post(api, "/api/models/SmgUser/find", {
      where: { opensAt: { gt: "08:00:00Z" } },
    });
    expect(filter.status).toBe(400);
    expect((filter.body as { unsupported?: unknown }).unsupported).toBeDefined();
  });

  it("lists with filters, sort, paging, relation counts and to-one keys", async () => {
    for (const [id, title] of [
      ["p1", "Graphs"],
      ["p2", "Engines"],
      ["p3", "Notes"],
    ] as const) {
      await ok(api, "/api/models/SmgPost/create", { data: { id, title } });
    }
    await client.withSession((s) =>
      s.run(
        `MATCH (u:SmgUser {id: "u1"}), (p:SmgPost) WHERE p.id IN ["p1", "p2"]
         CREATE (u)-[:SMG_AUTHORED]->(p)
         WITH DISTINCT u MATCH (v:SmgUser {id: "u2"}) CREATE (u)-[:SMG_FOLLOWS {muted: false}]->(v)`,
      ),
    );

    const users = await ok<{ rows: Record<string, unknown>[]; total: number }>(
      api,
      "/api/models/SmgUser/find",
      { orderBy: { posts: "desc" } },
    );
    expect(users.total).toBe(2);
    expect(users.rows[0]).toMatchObject({ id: "u1", _count: { posts: 2, following: 1 } });

    const filtered = await ok<{ rows: Record<string, unknown>[] }>(
      api,
      "/api/models/SmgUser/find",
      {
        where: {
          AND: [
            { balance: { gt: "9007199254740992" } },
            { name: { contains: "ad", mode: "insensitive" } },
          ],
        },
      },
    );
    expect(filtered.rows.map((r) => r.id)).toEqual(["u1"]);

    const page = await ok<{ rows: Record<string, unknown>[]; total: number }>(
      api,
      "/api/models/SmgPost/find",
      { orderBy: { title: "asc" }, skip: 1, take: 1 },
    );
    expect(page.total).toBe(3);
    expect(page.rows[0]).toMatchObject({ title: "Graphs", author: { id: "u1" } });

    const people = await ok<{ rows: Record<string, unknown>[] }>(
      api,
      "/api/models/SmgPerson/find",
      {},
    );
    expect(people.rows.map((r) => r.__typename)).toEqual(["SmgUser", "SmgUser"]);

    const counts = (await api.handle("GET", "/api/counts", undefined)).body as Record<
      string,
      number
    >;
    expect(counts).toMatchObject({ SmgUser: 2, SmgPost: 3, SmgFollows: 1 });
  });

  it("follows relations and edits edge properties", async () => {
    const posts = await ok<{ rows: Record<string, unknown>[]; total: number }>(
      api,
      "/api/models/SmgUser/related",
      { where: { id: "u1" }, relation: "posts", orderBy: { title: "asc" } },
    );
    expect(posts.total).toBe(2);
    expect(posts.rows.map((r) => r.title)).toEqual(["Engines", "Graphs"]);

    await ok(api, "/api/relationships/SmgFollows/update", {
      from: { id: "u1" },
      to: { id: "u2" },
      data: { muted: true, since: "2024-05-01T10:00:00Z" },
    });
    const edges = await ok<{ rows: unknown[]; total: number }>(
      api,
      "/api/relationships/SmgFollows/find",
      { orderBy: { since: "desc" } },
    );
    expect(edges.total).toBe(1);
    expect(edges.rows[0]).toEqual({
      from: { id: "u1" },
      to: { id: "u2" },
      properties: { muted: true, since: "2024-05-01T10:00:00.000Z" },
    });
  });

  it("previews and runs deletes with onDelete rules", async () => {
    const preview = await ok<{ effects: unknown[]; blocked: boolean }>(
      api,
      "/api/models/SmgUser/delete-preview",
      { where: { id: "u1" } },
    );
    expect(preview).toEqual({
      effects: [
        { relation: "posts", target: "SmgPost", rule: "Cascade", count: 2 },
        { relation: "following", target: "SmgUser", rule: "SetNull", count: 1 },
      ],
      blocked: false,
    });
    await ok(api, "/api/models/SmgUser/delete", { where: { id: "u1" } });
    const counts = (await api.handle("GET", "/api/counts", undefined)).body as Record<
      string,
      number
    >;
    expect(counts).toMatchObject({ SmgUser: 1, SmgPost: 1, SmgFollows: 0 });
  });

  it("runs raw Cypher: reads by default, Memgraph errors as 400 without retries", async () => {
    const read = await ok<{ columns: string[]; rows: Record<string, unknown>[] }>(
      api,
      "/api/cypher",
      { query: "MATCH (u:SmgUser) RETURN u.id AS id, $n AS n, u", params: { n: 3 } },
    );
    expect(read.columns).toEqual(["id", "n", "u"]);
    expect(read.rows[0]).toMatchObject({ id: "u2", n: 3, u: { id: "u2" } });

    const sneaky = await post(api, "/api/cypher", {
      query: "CREATE (:SmgUser {id: 'x'}) RETURN 1",
    });
    expect(sneaky.status).toBe(400);
    expect((sneaky.body as { error: string }).error).toMatch(/read/i);

    expect((await post(api, "/api/cypher", { query: "RETURN foo(" })).status).toBe(400);
    expect(
      (await post(api, "/api/cypher", { query: "CALL db.index.fulltext.queryNodes('a', 'b')" }))
        .status,
    ).toBe(400);
    // Reported as transient by Memgraph: answered at once, not retried for 30 s.
    const t0 = Date.now();
    const transient = await post(api, "/api/cypher", { query: 'RETURN duration("P1M") AS d' });
    expect(transient.status).toBe(400);
    expect(Date.now() - t0).toBeLessThan(5000);

    expect(
      (await post(readOnly, "/api/cypher", { query: "CREATE (:SmgUser {id: 'x'})", write: true }))
        .status,
    ).toBe(400);
    await ok(api, "/api/cypher", {
      query: "MATCH (u:SmgUser {id: 'u2'}) SET u.name = 'Written' RETURN u.name AS name",
      write: true,
    });
    const after = await ok<{ rows: Record<string, unknown>[] }>(api, "/api/models/SmgUser/find", {
      where: { id: "u2" },
    });
    expect(after.rows[0]!.name).toBe("Written");
  });
});
