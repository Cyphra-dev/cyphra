import { CyphraClient, createOrm } from "@cyphra/runtime";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStudioApi, type StudioApi } from "./api.js";
import { createStudioDb } from "./db.js";
import { buildMeta } from "./values.js";

/**
 * The studio API against Neo4j, through the real ORM. Every label and type is prefixed with
 * `Sd` / `SD_` and only those nodes are deleted, so the suite can share the test database.
 */
const enabled = Boolean(
  process.env.NEO4J_TEST_URI &&
  process.env.NEO4J_TEST_USER &&
  process.env.NEO4J_TEST_PASSWORD &&
  process.env.CYPHRA_TEST_DIALECT !== "memgraph",
);

const schema = resolveSchema(
  parseSchema(`
enum SdRole {
  ADMIN
  READER
}

interface SdPerson {
  id    String @id
  email String @unique @email
}

node SdUser implements SdPerson {
  name      String   @length(2, 40)
  role      SdRole   @default(READER)
  balance   BigInt   @default(0)
  tags      String[]
  settings  Json?
  born      Date?
  posts     SdPost[] @relationship(type: "SD_AUTHORED", direction: OUT, onDelete: Cascade)
  following SdUser[] @relationship(type: "SD_FOLLOWS", direction: OUT)
}

node SdPost {
  id       String       @id
  title    String       @length(3, 100)
  author   SdUser?      @relationship(type: "SD_AUTHORED", direction: IN)
  comments SdComment[]  @relationship(type: "SD_ON", direction: IN, onDelete: Cascade)
}

node SdComment {
  id   String  @id
  body String
  post SdPost? @relationship(type: "SD_ON", direction: OUT)
}

relationship SdFollows {
  type "SD_FOLLOWS"
  from SdUser
  to SdUser
  since DateTime?
  muted Boolean  @default(false)
}
`),
);

describe.skipIf(!enabled)("studio API (Neo4j)", () => {
  let client: CyphraClient;
  let api: StudioApi;
  let readOnly: StudioApi;

  const wipe = () =>
    client.withSession((s) =>
      s.run("MATCH (n) WHERE n:SdUser OR n:SdPost OR n:SdComment OR n:SdPerson DETACH DELETE n"),
    );
  const post = async (a: StudioApi, path: string, body: unknown) => a.handle("POST", path, body);
  const ok = async <T>(a: StudioApi, path: string, body: unknown): Promise<T> => {
    const res = await post(a, path, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as T;
  };

  beforeAll(async () => {
    client = new CyphraClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
    });
    await wipe();
    // Own constraint (dropped in afterAll) so duplicate emails raise a UniqueConstraintError.
    await client.withSession((s) =>
      s.run(
        "CREATE CONSTRAINT SdPerson_email_unique IF NOT EXISTS FOR (n:SdPerson) REQUIRE n.email IS UNIQUE",
      ),
    );
    const orm = createOrm(schema, { client }) as unknown as Record<string, unknown>;
    const db = createStudioDb(orm, client);
    const info = { connection: "bolt://test", version: "0.0.0" };
    api = createStudioApi({
      schema,
      db,
      meta: buildMeta(schema, { ...info, readOnly: false }),
      readOnly: false,
    });
    readOnly = createStudioApi({
      schema,
      db,
      meta: buildMeta(schema, { ...info, readOnly: true }),
      readOnly: true,
    });
  });

  afterAll(async () => {
    await wipe();
    await client.withSession((s) => s.run("DROP CONSTRAINT SdPerson_email_unique IF EXISTS"));
    await client.close();
  });

  it("creates records with typed values and reports validation issues", async () => {
    const created = await ok<{ row: Record<string, unknown> }>(api, "/api/models/SdUser/create", {
      data: {
        id: "u1",
        email: "ada@example.com",
        name: "Ada",
        role: "ADMIN",
        balance: "9007199254740993",
        tags: ["math", "engines"],
        settings: { theme: "dark" },
        born: "1815-12-10",
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
    await ok(api, "/api/models/SdUser/create", {
      data: { id: "u2", email: "alan@example.com", name: "Alan" },
    });

    const invalid = await post(api, "/api/models/SdUser/create", {
      data: { id: "u3", email: "not-an-email", name: "A" },
    });
    expect(invalid.status).toBe(400);
    expect(
      (invalid.body as { issues: { field: string }[] }).issues.map((i) => i.field).sort(),
    ).toEqual(["email", "name"]);

    const dup = await post(api, "/api/models/SdUser/create", {
      data: { id: "u4", email: "ada@example.com", name: "Again" },
    });
    expect(dup.status).toBe(409);
    expect((dup.body as { fields: string[] }).fields).toEqual(["email"]);
  });

  it("lists with filters, sort, paging, relation counts and to-one keys", async () => {
    for (const [id, title] of [
      ["p1", "Graphs"],
      ["p2", "Engines"],
      ["p3", "Notes"],
    ] as const) {
      await ok(api, "/api/models/SdPost/create", { data: { id, title } });
    }
    await client.withSession((s) =>
      s.run(
        `MATCH (u:SdUser {id: "u1"}), (p:SdPost) WHERE p.id IN ["p1", "p2"]
         CREATE (u)-[:SD_AUTHORED]->(p)
         WITH DISTINCT u MATCH (v:SdUser {id: "u2"}) CREATE (u)-[:SD_FOLLOWS {muted: false}]->(v)`,
      ),
    );
    await client.withSession((s) =>
      s.run(`MATCH (p:SdPost {id: "p1"}) CREATE (:SdComment {id: "c1", body: "hi"})-[:SD_ON]->(p)`),
    );

    const users = await ok<{ rows: Record<string, unknown>[]; total: number }>(
      api,
      "/api/models/SdUser/find",
      { orderBy: { posts: "desc" } },
    );
    expect(users.total).toBe(2);
    expect(users.rows[0]).toMatchObject({ id: "u1", _count: { posts: 2, following: 1 } });

    const filtered = await ok<{ rows: Record<string, unknown>[]; total: number }>(
      api,
      "/api/models/SdUser/find",
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
      "/api/models/SdPost/find",
      { orderBy: { title: "asc" }, skip: 1, take: 1 },
    );
    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ title: "Graphs", author: { id: "u1" } });

    // Interfaces: rows carry __typename.
    const people = await ok<{ rows: Record<string, unknown>[] }>(
      api,
      "/api/models/SdPerson/find",
      {},
    );
    expect(people.rows.map((r) => r.__typename)).toEqual(["SdUser", "SdUser"]);

    const counts = (await api.handle("GET", "/api/counts", undefined)).body as Record<
      string,
      number
    >;
    expect(counts).toMatchObject({ SdUser: 2, SdPost: 3, SdComment: 1, SdFollows: 1 });
  });

  it("follows relations and edits edge properties", async () => {
    const posts = await ok<{ rows: Record<string, unknown>[]; total: number }>(
      api,
      "/api/models/SdUser/related",
      { where: { id: "u1" }, relation: "posts", orderBy: { title: "asc" } },
    );
    expect(posts.total).toBe(2);
    expect(posts.rows.map((r) => r.title)).toEqual(["Engines", "Graphs"]);

    const following = await ok<{ rows: Record<string, unknown>[] }>(
      api,
      "/api/models/SdUser/related",
      { where: { id: "u1" }, relation: "following" },
    );
    expect(following.rows[0]).toMatchObject({ id: "u2", $edge: { muted: false } });

    await ok(api, "/api/relationships/SdFollows/update", {
      from: { id: "u1" },
      to: { id: "u2" },
      data: { muted: true, since: "2024-05-01T10:00:00Z" },
    });
    const edges = await ok<{
      rows: { from: unknown; to: unknown; properties: unknown }[];
      total: number;
    }>(api, "/api/relationships/SdFollows/find", { orderBy: { since: "desc" } });
    expect(edges.total).toBe(1);
    expect(edges.rows[0]).toEqual({
      from: { id: "u1" },
      to: { id: "u2" },
      properties: { muted: true, since: "2024-05-01T10:00:00.000Z" },
    });
  });

  it("updates records", async () => {
    const res = await ok<{ row: Record<string, unknown> }>(api, "/api/models/SdUser/update", {
      where: { id: "u2" },
      data: { name: "Alan Turing", tags: ["crypto"], settings: null },
    });
    expect(res.row).toMatchObject({ name: "Alan Turing", tags: ["crypto"], settings: null });
    const bad = await post(api, "/api/models/SdUser/update", {
      where: { id: "u2" },
      data: { name: "x" },
    });
    expect(bad.status).toBe(400);
    const missing = await post(api, "/api/models/SdUser/update", {
      where: { id: "nope" },
      data: { name: "Nobody" },
    });
    expect(missing.status).toBe(404);
  });

  it("previews and runs deletes with onDelete rules", async () => {
    const preview = await ok<{ effects: unknown[]; blocked: boolean }>(
      api,
      "/api/models/SdUser/delete-preview",
      { where: { id: "u1" } },
    );
    expect(preview).toEqual({
      effects: [
        { relation: "posts", target: "SdPost", rule: "Cascade", count: 2 },
        { relation: "following", target: "SdUser", rule: "SetNull", count: 1 },
      ],
      blocked: false,
    });
    await ok(api, "/api/models/SdUser/delete", { where: { id: "u1" } });
    const counts = (await api.handle("GET", "/api/counts", undefined)).body as Record<
      string,
      number
    >;
    // p1, p2 cascaded, and c1 through p1's own cascade.
    expect(counts).toMatchObject({ SdUser: 1, SdPost: 1, SdComment: 0, SdFollows: 0 });
  });

  it("runs raw Cypher: reads by default, writes only when asked and allowed", async () => {
    const read = await ok<{ columns: string[]; rows: Record<string, unknown>[] }>(
      api,
      "/api/cypher",
      { query: "MATCH (u:SdUser) RETURN u.id AS id, $n AS n, u", params: { n: 3 } },
    );
    expect(read.columns).toEqual(["id", "n", "u"]);
    expect(read.rows[0]).toMatchObject({
      id: "u2",
      n: 3,
      u: { $labels: expect.any(Array), id: "u2" },
    });

    const sneaky = await post(api, "/api/cypher", { query: "CREATE (:SdUser {id: 'x'}) RETURN 1" });
    expect(sneaky.status).toBe(400);
    expect((sneaky.body as { error: string }).error).toMatch(/read/i);

    expect(
      (await post(readOnly, "/api/cypher", { query: "CREATE (:SdUser {id: 'x'})", write: true }))
        .status,
    ).toBe(400);
    expect(
      (
        await post(readOnly, "/api/models/SdUser/update", {
          where: { id: "u2" },
          data: { name: "No" },
        })
      ).status,
    ).toBe(400);

    await ok(api, "/api/cypher", {
      query: "MATCH (u:SdUser {id: 'u2'}) SET u.name = 'Written' RETURN u.name AS name",
      write: true,
    });
    const after = await ok<{ rows: Record<string, unknown>[] }>(api, "/api/models/SdUser/find", {
      where: { id: "u2" },
    });
    expect(after.rows[0]!.name).toBe("Written");
  });
});
