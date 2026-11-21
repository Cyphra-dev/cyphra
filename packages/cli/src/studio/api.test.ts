import { parseSchema, resolveSchema } from "@cyphra/schema";
import { CyphraValidationError, UniqueConstraintError } from "@cyphra/runtime";
import { describe, expect, it } from "vitest";
import { createStudioApi, type StudioDb, type StudioDelegate } from "./api.js";
import { buildMeta, toWire } from "./values.js";

const schema = resolveSchema(
  parseSchema(`
enum Role {
  ADMIN
  READER
}

interface Person {
  id    String @id
  email String @unique
}

node User implements Person {
  role      Role     @default(READER)
  balance   BigInt?
  tags      String[]
  posts     Post[]   @relationship(type: "AUTHORED", direction: OUT, onDelete: Cascade)
  invoices  Invoice[] @relationship(type: "BILLED", direction: OUT, onDelete: Restrict)
  following User[]   @relationship(type: "FOLLOWS", direction: OUT)
}

node Post {
  id     String @id
  title  String @length(3, 100)
  author User?  @relationship(type: "AUTHORED", direction: IN)
}

node Invoice {
  id     String @id
  amount Int
}

node Slot {
  day  Int
  room String
  @@unique([day, room])
}

node Loose {
  note String?
}

relationship Follows {
  type "FOLLOWS"
  from User
  to User
  since DateTime?
}
`),
);

type Call = { model: string; op: string; args: Record<string, unknown> };

function fakeDb(
  overrides: Partial<Record<string, (args: Record<string, unknown>) => unknown>> = {},
) {
  const calls: Call[] = [];
  const cypher: { query: string; params: Record<string, unknown>; mode: string }[] = [];
  const delegate = (model: string): StudioDelegate => {
    const op =
      (name: string, fallback: unknown) =>
      async (args: Record<string, unknown>): Promise<never> => {
        calls.push({ model, op: name, args });
        const o = overrides[`${model}.${name}`] ?? overrides[name];
        return (o ? await o(args) : fallback) as never;
      };
    return {
      findMany: op("findMany", []),
      findUnique: op("findUnique", null),
      count: op("count", 0),
      create: op("create", { id: "new" }),
      update: op("update", { id: "u1" }),
      delete: op("delete", { id: "u1" }),
    };
  };
  const db: StudioDb = {
    delegate,
    async cypher(query, params, mode) {
      cypher.push({ query, params, mode });
      const o = overrides.cypher;
      return (o ? await o({ query, params, mode }) : []) as Record<string, unknown>[];
    },
  };
  return { db, calls, cypher };
}

function api(db: StudioDb, readOnly = false) {
  const meta = buildMeta(schema, { readOnly, connection: "bolt://x", version: "0.0.0" });
  return createStudioApi({ schema, db, meta, readOnly });
}

describe("studio meta", () => {
  it("describes models, keys, rules and relations without credentials", () => {
    const meta = buildMeta(schema, {
      readOnly: false,
      connection: "bolt://127.0.0.1:7687",
      version: "1.0.0",
    });
    const user = meta.nodes.find((n) => n.name === "User")!;
    expect(user.key).toEqual({ kind: "field", field: "id" });
    expect(user.interfaces).toEqual(["Person"]);
    expect(user.fields.find((f) => f.name === "role")).toMatchObject({
      type: "Enum",
      enumValues: ["ADMIN", "READER"],
      hasDefault: true,
    });
    expect(user.fields.find((f) => f.name === "posts")).toMatchObject({
      kind: "relation",
      many: true,
      onDelete: "Cascade",
    });
    expect(meta.nodes.find((n) => n.name === "Person")!.abstract).toBe(true);
    expect(meta.nodes.find((n) => n.name === "Slot")!.key).toEqual({
      kind: "compound",
      key: "day_room",
      fields: ["day", "room"],
    });
    expect(meta.nodes.find((n) => n.name === "Loose")!.key).toBeNull();
    expect(meta.nodes.find((n) => n.name === "Post")!.fields[1]).toMatchObject({
      rules: ["@length(3, 100)"],
    });
    expect(meta.relationships[0]).toMatchObject({ name: "Follows", via: "following" });
    expect(JSON.stringify(meta)).not.toMatch(/password/i);
  });
});

describe("studio API", () => {
  it("lists records with relation counts, to-one keys, filters, sort and paging", async () => {
    const { db, calls } = fakeDb({
      "User.findMany": () => [{ id: "u1", balance: 9007199254740993n, _count: { posts: 2 } }],
      "User.count": () => 1,
    });
    const res = await api(db).handle("POST", "/api/models/User/find", {
      where: { balance: { gt: "9007199254740993" }, posts: { some: { title: "x" } } },
      orderBy: { posts: "desc" },
      skip: 10,
      take: 5,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      rows: [{ id: "u1", balance: "9007199254740993", _count: { posts: 2 } }],
      total: 1,
    });
    const find = calls.find((c) => c.op === "findMany")!.args;
    expect(find.where).toEqual({
      balance: { gt: 9007199254740993n },
      posts: { some: { title: "x" } },
    });
    expect(find.orderBy).toEqual([{ posts: { _count: "desc" } }]);
    expect(find).toMatchObject({ skip: 10, take: 5 });
    expect(find.include).toEqual({
      _count: { select: { posts: true, invoices: true, following: true } },
    });

    const posts = fakeDb();
    await api(posts.db).handle("POST", "/api/models/Post/find", {});
    expect(posts.calls[0]!.args.include).toEqual({ author: { select: { id: true } } });
  });

  it("validates paging and sort arguments", async () => {
    const { db } = fakeDb();
    const a = api(db);
    expect((await a.handle("POST", "/api/models/User/find", { take: 10_000 })).status).toBe(400);
    expect((await a.handle("POST", "/api/models/User/find", { skip: -1 })).status).toBe(400);
    expect(
      (await a.handle("POST", "/api/models/User/find", { orderBy: { id: "sideways" } })).status,
    ).toBe(400);
    expect((await a.handle("POST", "/api/models/Nope/find", {})).status).toBe(400);
  });

  it("creates and updates with decoded values", async () => {
    const { db, calls } = fakeDb();
    const a = api(db);
    expect(
      (
        await a.handle("POST", "/api/models/User/create", {
          data: { id: "u1", email: "a@b.c", balance: "12", tags: ["a"] },
        })
      ).status,
    ).toBe(200);
    expect(calls[0]!.args).toEqual({
      data: { id: "u1", email: "a@b.c", balance: 12n, tags: ["a"] },
    });
    await a.handle("POST", "/api/models/User/update", {
      where: { id: "u1" },
      data: { role: "ADMIN" },
    });
    expect(calls[1]!.args).toEqual({ where: { id: "u1" }, data: { role: "ADMIN" } });
    // Relations are not written through data.
    const bad = await a.handle("POST", "/api/models/User/update", {
      where: { id: "u1" },
      data: { posts: [] },
    });
    expect(bad.status).toBe(400);
    // An update needs a key.
    expect(
      (await a.handle("POST", "/api/models/User/update", { where: {}, data: {} })).status,
    ).toBe(400);
  });

  it("maps validation issues, uniqueness and missing records to HTTP errors", async () => {
    const issues = [
      {
        path: ["data", "title"],
        model: "Post",
        field: "title",
        rule: "length",
        message: "too short",
      },
    ];
    const { db } = fakeDb({
      "Post.create": () => {
        throw new CyphraValidationError("Invalid data", issues as never);
      },
      "User.create": () => {
        throw new UniqueConstraintError("dup", {
          model: "Person",
          fields: ["email"],
          code: "Neo.ClientError.Schema.ConstraintValidationFailed",
        });
      },
    });
    const a = api(db);
    expect(await a.handle("POST", "/api/models/Post/create", { data: { title: "x" } })).toEqual({
      status: 400,
      body: { error: "Invalid data", issues: [{ field: "title", message: "too short" }] },
    });
    expect(
      await a.handle("POST", "/api/models/User/create", { data: { email: "a@b.c" } }),
    ).toMatchObject({ status: 409, body: { fields: ["email"] } });
  });

  it("refuses writes in read-only mode and on interfaces", async () => {
    const { db, calls, cypher } = fakeDb();
    const ro = api(db, true);
    for (const op of ["create", "update", "delete"]) {
      const res = await ro.handle("POST", `/api/models/User/${op}`, {
        where: { id: "u1" },
        data: {},
      });
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toMatch(/read-only/);
    }
    expect(
      (await ro.handle("POST", "/api/cypher", { query: "CREATE (n)", write: true })).status,
    ).toBe(400);
    expect(
      (
        await ro.handle("POST", "/api/relationships/Follows/update", {
          from: { id: "a" },
          to: { id: "b" },
          data: {},
        })
      ).status,
    ).toBe(400);
    expect(calls.filter((c) => c.op !== "findMany")).toEqual([]);
    expect(cypher).toEqual([]);

    const rw = api(fakeDb().db);
    const res = await rw.handle("POST", "/api/models/Person/create", { data: {} });
    expect((res.body as { error: string }).error).toMatch(/interface/);
  });

  it("previews a delete with onDelete rules", async () => {
    const { db, calls } = fakeDb({
      "User.findUnique": () => ({ _count: { posts: 3, invoices: 1, following: 0 } }),
    });
    const res = await api(db).handle("POST", "/api/models/User/delete-preview", {
      where: { id: "u1" },
    });
    expect(res.body).toEqual({
      effects: [
        { relation: "posts", target: "Post", rule: "Cascade", count: 3 },
        { relation: "invoices", target: "Invoice", rule: "Restrict", count: 1 },
        { relation: "following", target: "User", rule: "SetNull", count: 0 },
      ],
      blocked: true,
    });
    expect(calls[0]!.args.select).toEqual({
      _count: { select: { posts: true, invoices: true, following: true } },
    });
    const missing = await api(fakeDb().db).handle("POST", "/api/models/User/delete-preview", {
      where: { id: "nope" },
    });
    expect(missing.status).toBe(404);
  });

  it("follows a relation of a record", async () => {
    const { db, calls } = fakeDb({
      "User.findUnique": () => ({
        id: "u1",
        posts: [{ id: "p1", author: { id: "u1" } }],
        _count: { posts: 7 },
      }),
    });
    const res = await api(db).handle("POST", "/api/models/User/related", {
      where: { id: "u1" },
      relation: "posts",
      skip: 0,
      take: 1,
      orderBy: { title: "asc" },
    });
    expect(res.body).toEqual({ rows: [{ id: "p1", author: { id: "u1" } }], total: 7 });
    expect(calls[0]!.args).toEqual({
      where: { id: "u1" },
      include: {
        posts: {
          include: { author: { select: { id: true } } },
          skip: 0,
          take: 1,
          orderBy: [{ title: "asc" }],
        },
        _count: { select: { posts: true } },
      },
    });
  });

  it("lists and updates edges of a relationship model", async () => {
    const { db, cypher, calls } = fakeDb({
      cypher: ({ query }) =>
        String(query).includes("count(r)")
          ? [{ total: 2 }]
          : [
              {
                from: { id: "a" },
                to: { id: "b" },
                properties: { since: "2024-01-01T10:00:00.123456789Z" },
              },
            ],
    });
    const a = api(db);
    const res = await a.handle("POST", "/api/relationships/Follows/find", {
      orderBy: { since: "desc" },
      take: 10,
    });
    expect(res.body).toEqual({
      rows: [
        {
          from: { id: "a" },
          to: { id: "b" },
          properties: { since: "2024-01-01T10:00:00.123Z" },
        },
      ],
      total: 2,
    });
    expect(cypher[0]!.query).toBe(
      "MATCH (a:`User`)-[r:`FOLLOWS`]->(b:`User`) RETURN a {.`id`} AS from, b {.`id`} AS to, properties(r) AS properties ORDER BY r.`since` DESC SKIP 0 LIMIT 10",
    );
    expect(cypher.every((c) => c.mode === "read")).toBe(true);
    // Only schema properties can be sorted on (no Cypher injection through orderBy).
    expect(
      (await a.handle("POST", "/api/relationships/Follows/find", { orderBy: { "x` DESC": "asc" } }))
        .status,
    ).toBe(400);

    await a.handle("POST", "/api/relationships/Follows/update", {
      from: { id: "a" },
      to: { id: "b" },
      data: { since: "2025-01-01T00:00:00Z" },
    });
    expect(calls.at(-1)).toEqual({
      model: "User",
      op: "update",
      args: {
        where: { id: "a" },
        data: { following: { connect: { id: "b", $edge: { since: "2025-01-01T00:00:00Z" } } } },
      },
    });
  });

  it("runs raw Cypher in a read transaction unless writes are asked for", async () => {
    const { db, cypher } = fakeDb({ cypher: () => [{ n: 1, big: 2n }] });
    const a = api(db);
    expect(await a.handle("POST", "/api/cypher", { query: "RETURN 1 AS n" })).toEqual({
      status: 200,
      body: { columns: ["n", "big"], rows: [{ n: 1, big: "2" }], truncated: false },
    });
    await a.handle("POST", "/api/cypher", { query: "CREATE (n)", write: true, params: { a: 1 } });
    expect(cypher.map((c) => c.mode)).toEqual(["read", "write"]);
    expect(cypher[1]!.params).toEqual({ a: 1 });
    expect((await a.handle("POST", "/api/cypher", { query: " " })).status).toBe(400);
  });

  it("answers counts per model and relationship model", async () => {
    const { db } = fakeDb({ count: () => 4, cypher: () => [{ total: 3 }] });
    const res = await api(db).handle("GET", "/api/counts", undefined);
    expect(res.body).toMatchObject({ User: 4, Post: 4, Follows: 3 });
  });

  it("routes: 404, 405 and body checks", async () => {
    const a = api(fakeDb().db);
    expect((await a.handle("GET", "/api/nope", undefined)).status).toBe(404);
    expect((await a.handle("GET", "/api/models/User/find", undefined)).status).toBe(405);
    expect((await a.handle("POST", "/api/models/User/find", [])).status).toBe(400);
    expect((await a.handle("GET", "/api/meta", undefined)).status).toBe(200);
  });
});

describe("toWire", () => {
  it("makes driver values JSON-friendly", () => {
    const int = (v: string) =>
      Object.assign(Object.create({ __isInteger__: true, toString: () => v }), {});
    expect(toWire(int("42"))).toBe(42);
    expect(toWire(int("9223372036854775807"))).toBe("9223372036854775807");
    expect(toWire(new Date("2024-01-01T00:00:00Z"))).toBe("2024-01-01T00:00:00.000Z");
    expect(toWire({ labels: ["A"], properties: { x: 1 }, elementId: "4:x:1" })).toEqual({
      $labels: ["A"],
      $elementId: "4:x:1",
      x: 1,
    });
    expect(toWire([1n, null, NaN])).toEqual(["1", null, "NaN"]);
  });
});
