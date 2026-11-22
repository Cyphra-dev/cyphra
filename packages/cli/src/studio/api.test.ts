import { parseSchema, resolveSchema } from "@cyphra/schema";
import {
  CyphraValidationError,
  UniqueConstraintError,
  UnsupportedFeatureError,
} from "@cyphra/runtime";
import { describe, expect, it } from "vitest";
import { createStudioApi, errorResult, type StudioDb, type StudioDelegate } from "./api.js";
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

describe("studio on Memgraph", () => {
  const timed = resolveSchema(
    parseSchema(`
node Shop {
  id      String  @id
  name    String
  opensAt Time?
  open    LocalTime?
  ships   Shop[]  @relationship(type: "SHIPS", direction: OUT)
}

relationship Ships {
  type "SHIPS"
  from Shop
  to Shop
  at Time?
  note String?
}
`),
  );
  const info = { readOnly: false, connection: "bolt://x", version: "0.0.0" };
  const mgApi = (db: StudioDb) =>
    createStudioApi({
      schema: timed,
      db,
      meta: buildMeta(timed, { ...info, dialect: "memgraph" }),
      readOnly: false,
    });

  it("exposes the dialect and marks the fields Memgraph cannot store", () => {
    expect(buildMeta(timed, info).dialect).toBe("neo4j");
    const neo = buildMeta(timed, { ...info, dialect: "neo4j" });
    expect(JSON.stringify(neo)).not.toContain("unsupported");
    const mg = buildMeta(timed, { ...info, dialect: "memgraph" });
    expect(mg.dialect).toBe("memgraph");
    const fields = mg.nodes[0]!.fields;
    expect(fields.find((f) => f.name === "opensAt")).toMatchObject({
      unsupported: expect.stringMatching(/Memgraph has no zoned time type/),
    });
    expect(fields.find((f) => f.name === "open")).not.toHaveProperty("unsupported");
    expect(mg.relationships[0]!.properties.find((p) => p.name === "at")).toHaveProperty(
      "unsupported",
    );
  });

  it("refuses to write unsupported fields before the ORM runs", async () => {
    const { db, calls } = fakeDb();
    const a = mgApi(db);
    for (const path of ["/api/models/Shop/create", "/api/models/Shop/update"]) {
      const res = await a.handle("POST", path, {
        where: { id: "s1" },
        data: { id: "s1", name: "Corner", opensAt: "09:00:00+02:00" },
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: expect.stringMatching(/^Shop\.opensAt cannot be written on Memgraph/),
        unsupported: { feature: "Time values", dialect: "memgraph" },
        issues: [{ field: "opensAt", message: expect.stringMatching(/zoned time/) }],
      });
    }
    const edge = await a.handle("POST", "/api/relationships/Ships/update", {
      from: { id: "s1" },
      to: { id: "s2" },
      data: { at: "10:00:00Z" },
    });
    expect(edge.status).toBe(400);
    expect((edge.body as { error: string }).error).toMatch(/^Ships\.at cannot be written/);
    expect(calls.filter((c) => c.op !== "findUnique")).toEqual([]);

    // null clears the field, which Memgraph can do; other fields go through.
    await a.handle("POST", "/api/models/Shop/update", {
      where: { id: "s1" },
      data: { name: "Corner", opensAt: null },
    });
    expect(calls.at(-1)).toMatchObject({ op: "update", args: { data: { opensAt: null } } });
  });

  it("answers UnsupportedFeatureError and Memgraph client errors with 400", async () => {
    const { db } = fakeDb({
      findMany: () => {
        throw new UnsupportedFeatureError(
          "A Duration with months or years",
          "memgraph",
          "Use days instead of months.",
        );
      },
      cypher: () => {
        throw Object.assign(new Error("There is no procedure named 'db.index.fulltext.x'."), {
          code: "Memgraph.ClientError.MemgraphError.MemgraphError",
        });
      },
    });
    const a = mgApi(db);
    expect(await a.handle("POST", "/api/models/Shop/find", {})).toEqual({
      status: 400,
      body: {
        error:
          "A Duration with months or years is not supported on Memgraph: Use days instead of months.",
        unsupported: { feature: "A Duration with months or years", dialect: "memgraph" },
      },
    });
    const raw = await a.handle("POST", "/api/cypher", { query: "CALL db.index.fulltext.x()" });
    expect(raw.status).toBe(400);
    expect(
      errorResult(Object.assign(new Error("boom"), { code: "Memgraph.DatabaseError.X" })),
    ).toMatchObject({ status: 500 });
  });
});

describe("studio: unions", () => {
  const unions = resolveSchema(
    parseSchema(`
union Hit = Post | Author
node Post { id String @id  title String }
node Author { id String @id  name String }
`),
  );
  const unionApi = (db: StudioDb) =>
    createStudioApi({
      schema: unions,
      db,
      meta: buildMeta(unions, { readOnly: false, connection: "bolt://x", version: "0.0.0" }),
      readOnly: false,
    });

  it("lists a union through its delegate and refuses writes", async () => {
    const meta = buildMeta(unions, { readOnly: false, connection: "bolt://x", version: "0.0.0" });
    expect(meta.nodes.find((n) => n.name === "Hit")).toMatchObject({
      abstract: true,
      union: true,
      implementations: ["Post", "Author"],
      key: null,
    });
    const { db, calls } = fakeDb({
      "Hit.findMany": () => [{ __typename: "Post", id: "p", title: "T" }],
      "Hit.count": () => 1,
    });
    const res = await unionApi(db).handle("POST", "/api/models/Hit/find", {});
    expect(res.status).toBe(200);
    expect(calls.map((c) => `${c.model}.${c.op}`)).toEqual(["Hit.findMany", "Hit.count"]);
    const write = await unionApi(db).handle("POST", "/api/models/Hit/create", { data: {} });
    expect(write.status).toBe(400);
    expect(JSON.stringify(write.body)).toContain(
      "Hit is a union: write through one of its members.",
    );
  });
});

describe("studio: relations to a union", () => {
  const s = resolveSchema(
    parseSchema(`
union Hit = Post | Person
interface Person { id String @id  email String @unique }
node Writer implements Person { name String }
node Post { id String @id  title String }
node Board {
  id    String @id
  hits  Hit[]  @relationship(type: "PINS", direction: OUT)
  first Hit?   @relationship(type: "TOPS", direction: OUT)
}
relationship Pin {
  type "PINS"
  from Board
  to   Hit
  rank Int @default(0)
}
`),
  );
  const unionApi = (db: StudioDb, readOnly = false) =>
    createStudioApi({
      schema: s,
      db,
      meta: buildMeta(s, { readOnly, connection: "bolt://x", version: "0.0.0" }),
      readOnly,
    });

  it("describes the declared members of a union", () => {
    const meta = buildMeta(s, { readOnly: false, connection: "bolt://x", version: "0.0.0" });
    expect(meta.nodes.find((n) => n.name === "Hit")).toMatchObject({
      union: true,
      implementations: ["Post", "Writer"],
      members: ["Post", "Person"],
    });
    expect(meta.relationships[0]).toMatchObject({ from: "Board", to: "Hit", via: "hits" });
  });

  it("connects and disconnects by member and key, with edge properties", async () => {
    const { db, calls } = fakeDb();
    const a = unionApi(db);
    const link = await a.handle("POST", "/api/models/Board/connect", {
      where: { id: "b" },
      relation: "hits",
      member: "Person",
      key: { email: "e@x" },
      edge: { rank: 3 },
    });
    expect(link.status).toBe(200);
    expect(calls.at(-1)).toEqual({
      model: "Board",
      op: "update",
      args: {
        where: { id: "b" },
        data: { hits: { connect: { Person: { email: "e@x" }, $edge: { rank: 3 } } } },
      },
    });
    await a.handle("POST", "/api/models/Board/disconnect", {
      where: { id: "b" },
      relation: "hits",
      member: "Post",
      key: { id: "p" },
    });
    expect(calls.at(-1)!.args).toEqual({
      where: { id: "b" },
      data: { hits: { disconnect: { Post: { id: "p" } } } },
    });
    await a.handle("POST", "/api/models/Board/disconnect", {
      where: { id: "b" },
      relation: "first",
    });
    expect(calls.at(-1)!.args.data).toEqual({ first: { disconnect: true } });
    const missing = await a.handle("POST", "/api/models/Board/connect", {
      where: { id: "b" },
      relation: "hits",
      key: { id: "p" },
    });
    expect(missing.status).toBe(400);
    expect(JSON.stringify(missing.body)).toContain("name the member of the record to link");
    expect(
      (
        await a.handle("POST", "/api/models/Board/connect", {
          where: { id: "b" },
          relation: "first",
          member: "Post",
          key: { id: "p" },
          edge: { rank: 1 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await unionApi(db, true).handle("POST", "/api/models/Board/connect", {
          where: { id: "b" },
          relation: "hits",
          member: "Post",
          key: { id: "p" },
        })
      ).status,
    ).toBe(400);
  });

  it("lists the edges of a relationship model to a union with each end's member key", async () => {
    const { db, cypher, calls } = fakeDb({
      cypher: ({ query }) =>
        String(query).includes("count(r)")
          ? [{ total: 1 }]
          : [
              {
                from: { id: "b" },
                to: { __labels: ["Writer", "Person"], __props: { id: "w", email: "e", name: "N" } },
                properties: { rank: 2 },
              },
            ],
    });
    const a = unionApi(db);
    const res = await a.handle("POST", "/api/relationships/Pin/find", {});
    expect(res.body).toEqual({
      rows: [{ from: { id: "b" }, to: { __typename: "Writer", id: "w" }, properties: { rank: 2 } }],
      total: 1,
    });
    expect(cypher[0]!.query).toBe(
      "MATCH (a:`Board`)-[r:`PINS`]->(b) WHERE (b:`Post` OR b:`Person`) RETURN a {.`id`} AS from, {`__labels`: labels(b), `__props`: properties(b)} AS to, properties(r) AS properties SKIP 0 LIMIT 50",
    );
    await a.handle("POST", "/api/relationships/Pin/update", {
      from: { id: "b" },
      to: { id: "w" },
      toMember: "Writer",
      data: { rank: 5 },
    });
    expect(calls.at(-1)!.args.data).toEqual({
      hits: { connect: { Writer: { id: "w" }, $edge: { rank: 5 } } },
    });
  });
});
