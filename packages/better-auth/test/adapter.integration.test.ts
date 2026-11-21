/**
 * Adapter behaviour the conformance suite does not pin down for a graph: foreign keys as edges,
 * onDelete actions, unique foreign keys and race-safe consumeOne / incrementOne.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import type { CyphraClient } from "@cyphra/runtime";
import { cyphraAdapter } from "../src/index.js";
import { hasNeo4j, migrate, resetDatabase, run, testClient } from "./helpers.js";

type Row = { id: string; [key: string]: unknown };

const plugin = {
  id: "edges-test",
  schema: {
    note: {
      fields: {
        body: { type: "string", required: true },
        authorId: {
          type: "string",
          required: true,
          references: { model: "user", field: "id", onDelete: "restrict" },
        },
        reviewerId: {
          type: "string",
          required: false,
          references: { model: "user", field: "id", onDelete: "set null" },
        },
      },
    },
    profile: {
      fields: {
        userId: {
          type: "string",
          required: true,
          unique: true,
          references: { model: "user", field: "id" },
        },
      },
    },
    counter: {
      fields: {
        key: { type: "string", required: true, unique: true },
        remaining: { type: "number", required: true },
      },
    },
  },
} as const;

const options = {
  secret: "test-secret-that-is-long-enough-for-better-auth-tests",
  plugins: [plugin],
} satisfies Partial<BetterAuthOptions>;

describe.skipIf(!hasNeo4j)("cyphraAdapter (Neo4j)", () => {
  let client: CyphraClient;
  let adapter: Awaited<ReturnType<typeof adapterFor>>;

  async function adapterFor(c: CyphraClient) {
    const auth = betterAuth({ ...options, database: cyphraAdapter({ client: c }) });
    return (await auth.$context).adapter;
  }

  const createUser = (email: string) =>
    adapter.create<Row>({
      model: "user",
      data: { email, name: email, emailVerified: false },
    });
  const createSession = (userId: unknown, token: string) =>
    adapter.create<Row>({
      model: "session",
      data: { userId, token, expiresAt: new Date(Date.now() + 60_000), updatedAt: new Date() },
    });

  beforeAll(async () => {
    client = testClient();
    await migrate(client, options);
    adapter = await adapterFor(client);
  });

  beforeEach(async () => {
    await resetDatabase(client);
  });

  afterAll(async () => {
    await client?.close();
  });

  it("stores a foreign key as a HAS_* edge, not as a property", async () => {
    const user = await createUser("edge@example.com");
    const session = await createSession(user.id, "t1");
    expect(session.userId).toBe(user.id);

    const [rec] = await run(
      client,
      "MATCH (u:User)-[r:HAS_SESSION]->(s:Session) RETURN u.id AS user, keys(s) AS keys, s.expiresAt AS expiresAt",
    );
    expect(rec!.get("user")).toBe(user.id);
    expect(rec!.get("keys")).not.toContain("userId");
    // Dates are stored as Neo4j DateTime values, not strings.
    expect(typeof rec!.get("expiresAt")).toBe("object");

    const found = await adapter.findOne<Row>({
      model: "session",
      where: [{ field: "userId", value: user.id }],
    });
    expect(found).toMatchObject({ token: "t1", userId: user.id });
  });

  it("filters on foreign keys with eq, ne, in, not_in and null", async () => {
    const a = await createUser("a@example.com");
    const b = await createUser("b@example.com");
    await createSession(a.id, "ta");
    await createSession(b.id, "tb");
    await adapter.create({ model: "note", data: { body: "n1", authorId: a.id } });
    const tokens = async (where: Parameters<typeof adapter.findMany>[0]["where"]) =>
      (await adapter.findMany<Row>({ model: "session", where })).map((s) => s.token).sort();
    expect(await tokens([{ field: "userId", value: a.id }])).toEqual(["ta"]);
    expect(await tokens([{ field: "userId", operator: "ne", value: a.id }])).toEqual(["tb"]);
    expect(await tokens([{ field: "userId", operator: "in", value: [a.id, b.id] }])).toEqual([
      "ta",
      "tb",
    ]);
    expect(await tokens([{ field: "userId", operator: "not_in", value: [a.id] }])).toEqual(["tb"]);
    expect(
      await adapter.count({ model: "note", where: [{ field: "reviewerId", value: null }] }),
    ).toBe(1);
    expect(
      await adapter.count({
        model: "note",
        where: [{ field: "reviewerId", operator: "ne", value: null }],
      }),
    ).toBe(0);
  });

  it("moves the edge when a foreign key is updated, and removes it when set to null", async () => {
    const a = await createUser("a@example.com");
    const b = await createUser("b@example.com");
    const note = await adapter.create<Row>({
      model: "note",
      data: { body: "n", authorId: a.id, reviewerId: a.id },
    });
    const updated = await adapter.update<Row>({
      model: "note",
      where: [{ field: "id", value: note.id }],
      update: { authorId: b.id, reviewerId: null },
    });
    expect(updated).toMatchObject({ authorId: b.id, reviewerId: null });
    const [rec] = await run(
      client,
      "MATCH (n:Note) RETURN [(u:User)-[:HAS_NOTE_AUTHOR]->(n) | u.id] AS authors, [(u:User)-[:HAS_NOTE_REVIEWER]->(n) | u.id] AS reviewers",
    );
    expect(rec!.get("authors")).toEqual([b.id]);
    expect(rec!.get("reviewers")).toEqual([]);
  });

  it("applies onDelete: cascade, restrict and set null", async () => {
    const a = await createUser("a@example.com");
    const b = await createUser("b@example.com");
    await createSession(a.id, "t1");
    await createSession(a.id, "t2");
    await createSession(b.id, "t3");
    const note = await adapter.create<Row>({
      model: "note",
      data: { body: "n", authorId: b.id, reviewerId: a.id },
    });

    // Session.userId cascades (Better Auth's default); Note.reviewerId is set null.
    await adapter.delete({ model: "user", where: [{ field: "id", value: a.id }] });
    expect(await adapter.count({ model: "session" })).toBe(1);
    expect(
      await adapter.findOne<Row>({ model: "note", where: [{ field: "id", value: note.id }] }),
    ).toMatchObject({ authorId: b.id, reviewerId: null });

    // Note.authorId restricts: nothing is deleted, not even b's sessions.
    await expect(
      adapter.delete({ model: "user", where: [{ field: "id", value: b.id }] }),
    ).rejects.toThrow(/onDelete: "restrict"/);
    expect(await adapter.count({ model: "user" })).toBe(1);
    expect(await adapter.count({ model: "session" })).toBe(1);
  });

  it("enforces unique foreign keys", async () => {
    const a = await createUser("a@example.com");
    await adapter.create({ model: "profile", data: { userId: a.id } });
    await expect(adapter.create({ model: "profile", data: { userId: a.id } })).rejects.toThrow(
      /unique/,
    );
    expect(await adapter.count({ model: "profile" })).toBe(1);
  });

  it("fails like a foreign key constraint when the parent does not exist", async () => {
    await expect(createSession("missing-user", "t")).rejects.toThrow();
    expect(await adapter.count({ model: "session" })).toBe(0);
  });

  it("consumeOne: of N concurrent consumers exactly one gets the row", async () => {
    await adapter.create({
      model: "verification",
      data: { identifier: "race", value: "v", expiresAt: new Date(Date.now() + 60_000) },
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        adapter.consumeOne<Row>({
          model: "verification",
          where: [{ field: "identifier", value: "race" }],
        }),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.find((r) => r !== null)).toMatchObject({ identifier: "race", value: "v" });
    expect(await adapter.count({ model: "verification" })).toBe(0);
  });

  it("consumeOne deletes only one of several matching rows", async () => {
    for (const value of ["a", "b"]) {
      await adapter.create({
        model: "verification",
        data: { identifier: "dup", value, expiresAt: new Date(Date.now() + 60_000) },
      });
    }
    expect(
      await adapter.consumeOne({
        model: "verification",
        where: [{ field: "identifier", value: "dup" }],
      }),
    ).not.toBeNull();
    expect(await adapter.count({ model: "verification" })).toBe(1);
  });

  it("incrementOne: concurrent guarded decrements never go below the guard", async () => {
    await adapter.create({ model: "counter", data: { key: "k", remaining: 3 } });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        adapter.incrementOne<Row>({
          model: "counter",
          where: [
            { field: "key", value: "k" },
            { field: "remaining", operator: "gt", value: 0 },
          ],
          increment: { remaining: -1 },
        }),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(3);
    const [row] = await adapter.findMany<Row>({ model: "counter" });
    expect(row!.remaining).toBe(0);
  });
});
