import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Db } from "./__fixtures__/blog.gen.js";
import { CyphraValidationError, NotFoundError } from "./errors.js";
import {
  createClient as createVectorClient,
  type Db as VectorDb,
} from "./__fixtures__/vector.gen.js";
import {
  createClient as createSearchClient,
  type Db as SearchDb,
} from "./__fixtures__/search.gen.js";
import {
  TyRole,
  createClient as createTypesClient,
  type Db as TypesDb,
} from "./__fixtures__/types.gen.js";
import { createClient as createGeoClient, type Db as GeoDb } from "./__fixtures__/geo.gen.js";
import {
  createClient as createCompoundClient,
  type Db as CompoundDb,
} from "./__fixtures__/compound.gen.js";
import { escapeLucene } from "./fulltext.js";
import neo4j5 from "neo4j-driver-5";
import neo4j6 from "neo4j-driver-6";
import type { DriverLike } from "../client.js";
import type { CyphraEvent, ErrorEvent, QueryEvent, WarnEvent } from "../observability.js";

const hasNeo = Boolean(
  process.env.NEO4J_TEST_URI && process.env.NEO4J_TEST_USER && process.env.NEO4J_TEST_PASSWORD,
);

describe.skipIf(!hasNeo)("ORM client (Neo4j)", () => {
  let db: Db;

  beforeEach(async () => {
    db ??= createClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
    });
    await db.$cypher`MATCH (n) WHERE n:User OR n:Post DETACH DELETE n`;
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it("creates with defaults and reads back typed values", async () => {
    const u = await db.user.create({ data: { email: "a@x.io", age: 30, tags: ["admin", "dev"] } });
    expect(u.id).toMatch(/^[a-z][a-z0-9]{23}$/);
    expect(u.createdAt).toBeInstanceOf(Date);
    expect(u.age).toBe(30);
    expect(u.name).toBeNull();
    expect(u.tags).toEqual(["admin", "dev"]);

    // Int must be stored as an integer, not a float.
    const [row] = await db.$cypher<{ t: string }>`MATCH (u:User) RETURN valueType(u.age) AS t`;
    expect(row!.t).toBe("INTEGER NOT NULL");

    const found = await db.user.findUnique({ where: { email: "a@x.io" } });
    expect(found).toEqual(u);
    expect(await db.user.findUnique({ where: { email: "nobody@x.io" } })).toBeNull();
  });

  it("nested create + connect, include with filters, ordering and edge props", async () => {
    const bob = await db.user.create({ data: { email: "bob@x.io", name: "Bob" } });
    const alice = await db.user.create({
      data: {
        email: "alice@x.io",
        name: "Alice",
        posts: {
          create: [
            { title: "B post", published: true, views: 5 },
            { title: "A post", published: true, views: 50 },
            { title: "Draft" },
          ],
        },
        following: {
          connect: [{ email: "bob@x.io", $edge: { since: new Date("2024-01-02T03:04:05Z") } }],
        },
      },
      include: {
        posts: { where: { published: true }, orderBy: { title: "asc" } },
        following: true,
      },
    });
    expect(alice.posts.map((p) => p.title)).toEqual(["A post", "B post"]);
    expect(alice.following).toHaveLength(1);
    expect(alice.following[0]!.email).toBe("bob@x.io");
    expect(alice.following[0]!.$edge.since.toISOString()).toBe("2024-01-02T03:04:05.000Z");

    const bobWithFollowers = await db.user.findUniqueOrThrow({
      where: { id: bob.id },
      select: { name: true, followers: { select: { name: true } } },
    });
    expect(bobWithFollowers).toEqual({
      name: "Bob",
      followers: [{ name: "Alice", $edge: { since: new Date("2024-01-02T03:04:05Z") } }],
    });

    const post = await db.post.findFirst({
      where: { title: "Draft" },
      include: { author: { select: { email: true } } },
    });
    expect(post!.published).toBe(false);
    expect(post!.views).toBe(0);
    expect(post!.author).toEqual({ email: "alice@x.io" });
  });

  it("filters: scalar ops, lists, relation some/none/every, is/isNot, AND/OR/NOT", async () => {
    await db.user.create({
      data: {
        email: "a@x.io",
        age: 20,
        tags: ["admin"],
        posts: { create: [{ title: "p1", published: true }] },
      },
    });
    await db.user.create({
      data: {
        email: "b@y.io",
        age: 40,
        posts: { create: [{ title: "p2", published: true }, { title: "p3" }] },
      },
    });
    await db.user.create({ data: { email: "c@x.io" } });

    const emails = async (where: Parameters<Db["user"]["findMany"]>[0]) =>
      (await db.user.findMany({ ...where, orderBy: { email: "asc" } })).map((u) => u.email);

    expect(await emails({ where: { email: { endsWith: "@x.io" } } })).toEqual(["a@x.io", "c@x.io"]);
    expect(await emails({ where: { age: { gte: 30 } } })).toEqual(["b@y.io"]);
    expect(await emails({ where: { age: null } })).toEqual(["c@x.io"]);
    expect(await emails({ where: { age: { not: null } } })).toEqual(["a@x.io", "b@y.io"]);
    expect(await emails({ where: { age: { in: [20, 99] } } })).toEqual(["a@x.io"]);
    expect(await emails({ where: { tags: { has: "admin" } } })).toEqual(["a@x.io"]);
    expect(await emails({ where: { posts: { some: { published: false } } } })).toEqual(["b@y.io"]);
    expect(await emails({ where: { posts: { none: {} } } })).toEqual(["c@x.io"]);
    expect(await emails({ where: { posts: { every: { published: true } } } })).toEqual([
      "a@x.io",
      "c@x.io",
    ]);
    expect(
      await emails({ where: { OR: [{ age: 20 }, { age: 40 }], NOT: { email: "b@y.io" } } }),
    ).toEqual(["a@x.io"]);
    expect(await emails({ where: { OR: [] } })).toEqual([]);

    const authored = await db.post.findMany({
      where: { author: { is: { email: "b@y.io" } } },
      orderBy: { title: "desc" },
    });
    expect(authored.map((p) => p.title)).toEqual(["p3", "p2"]);
    expect(await db.post.count({ where: { author: null } })).toBe(0);
    expect(await db.post.count({ where: { author: { isNot: { email: "b@y.io" } } } })).toBe(1);

    const page = await db.user.findMany({ orderBy: { email: "asc" }, skip: 1, take: 1 });
    expect(page.map((u) => u.email)).toEqual(["b@y.io"]);
    expect(await db.user.count()).toBe(3);
  });

  it("orders by a scalar of a to-one related node", async () => {
    await db.user.create({
      data: { email: "b@x.io", posts: { create: [{ title: "b1" }, { title: "b2" }] } },
    });
    await db.user.create({ data: { email: "a@x.io", posts: { create: [{ title: "a1" }] } } });
    await db.post.create({ data: { title: "orphan" } });

    const titles = async (orderBy: unknown, take?: number) =>
      (
        await db.post.findMany({
          orderBy: orderBy as never,
          ...(take !== undefined ? { take } : {}),
        })
      ).map((p) => p.title);
    expect(await titles([{ author: { email: "asc" } }, { title: "asc" }])).toEqual([
      "a1",
      "b1",
      "b2",
      "orphan",
    ]);
    expect(await titles([{ author: { email: "desc" } }, { title: "desc" }])).toEqual([
      "orphan",
      "b2",
      "b1",
      "a1",
    ]);
    expect(await titles([{ author: { email: "asc" } }, { title: "asc" }], 2)).toEqual(["a1", "b1"]);
    // Nested: posts of a user loaded in author order (all the same author here).
    const users = await db.user.findMany({
      orderBy: { email: "asc" },
      include: { posts: { orderBy: [{ author: { email: "asc" } }, { title: "desc" }] } },
    });
    expect(users.map((u) => u.posts.map((p) => p.title))).toEqual([["a1"], ["b2", "b1"]]);
  });

  it("update: scalars, increments, null, to-one replace, disconnect, set", async () => {
    const a = await db.user.create({ data: { email: "a@x.io", name: "A", age: 1 } });
    const b = await db.user.create({ data: { email: "b@x.io" } });
    const c = await db.user.create({ data: { email: "c@x.io" } });
    const post = await db.post.create({ data: { title: "t", author: { connect: { id: a.id } } } });

    const updated = await db.user.update({
      where: { id: a.id },
      data: {
        age: { increment: 41 },
        name: null,
        following: { connect: [{ id: b.id }, { id: c.id }] },
      },
      include: { following: { orderBy: { email: "asc" } } },
    });
    expect(updated.age).toBe(42);
    expect(updated.name).toBeNull();
    expect(updated.following.map((u) => u.email)).toEqual(["b@x.io", "c@x.io"]);

    const afterDisconnect = await db.user.update({
      where: { id: a.id },
      data: { following: { disconnect: { id: b.id } } },
      select: { following: { select: { email: true } } },
    });
    expect(afterDisconnect.following.map((u) => u.email)).toEqual(["c@x.io"]);

    const afterSet = await db.user.update({
      where: { id: a.id },
      data: { following: { set: [{ id: b.id }] } },
      select: { following: { select: { email: true } } },
    });
    expect(afterSet.following.map((u) => u.email)).toEqual(["b@x.io"]);

    // To-one connect replaces the existing edge.
    const moved = await db.post.update({
      where: { id: post.id },
      data: { author: { connect: { id: b.id } } },
      include: { author: true },
    });
    expect(moved.author?.email).toBe("b@x.io");
    expect(await db.post.count({ where: { author: { is: { id: a.id } } } })).toBe(0);

    const orphan = await db.post.update({
      where: { id: post.id },
      data: { author: { disconnect: true } },
      include: { author: true },
    });
    expect(orphan.author).toBeNull();

    expect(
      await db.user.updateMany({ where: { email: { endsWith: "@x.io" } }, data: { age: 7 } }),
    ).toEqual({
      count: 3,
    });
  });

  it("upsert, delete, deleteMany, createMany", async () => {
    const first = await db.user.upsert({
      where: { email: "u@x.io" },
      create: { email: "u@x.io", name: "created" },
      update: { name: "updated" },
    });
    expect(first.name).toBe("created");
    const second = await db.user.upsert({
      where: { email: "u@x.io" },
      create: { email: "u@x.io", name: "created" },
      update: { name: "updated" },
    });
    expect(second).toMatchObject({ id: first.id, name: "updated" });

    expect(
      await db.user.createMany({ data: [{ email: "m1@x.io" }, { email: "m2@x.io", age: 3 }] }),
    ).toEqual({
      count: 2,
    });
    const deleted = await db.user.delete({ where: { email: "m1@x.io" } });
    expect(deleted.email).toBe("m1@x.io");
    await expect(db.user.delete({ where: { email: "m1@x.io" } })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await db.user.deleteMany({ where: { email: { startsWith: "m" } } })).toEqual({
      count: 1,
    });
    expect(await db.user.count()).toBe(1);
  });

  it('filters strings case-insensitively with mode: "insensitive"', async () => {
    await db.user.createMany({
      data: [{ email: "Alice@Example.com", name: "Alice" }, { email: "bob@example.com" }],
    });
    const emails = async (where: Parameters<typeof db.user.findMany>[0]) =>
      (await db.user.findMany({ ...where, orderBy: { email: "asc" } })).map((u) => u.email);
    expect(await emails({ where: { email: "alice@example.com" } })).toEqual([]);
    expect(
      await emails({ where: { email: { equals: "alice@EXAMPLE.com", mode: "insensitive" } } }),
    ).toEqual(["Alice@Example.com"]);
    expect(
      await emails({ where: { email: { in: ["ALICE@example.com"], mode: "insensitive" } } }),
    ).toEqual(["Alice@Example.com"]);
    expect(
      await emails({ where: { email: { endsWith: "@EXAMPLE.COM", mode: "insensitive" } } }),
    ).toEqual(["Alice@Example.com", "bob@example.com"]);
    expect(
      await emails({ where: { email: { not: "alice@example.com", mode: "insensitive" } } }),
    ).toEqual(["bob@example.com"]);
    expect(await emails({ where: { name: { contains: "LIC", mode: "insensitive" } } })).toEqual([
      "Alice@Example.com",
    ]);
  });

  it("rolls back nested writes and $transaction on failure", async () => {
    await expect(
      db.user.create({
        data: {
          email: "x@x.io",
          posts: { create: { title: "orphan?" } },
          following: { connect: { id: "missing" } },
        },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await db.user.count()).toBe(0);
    expect(await db.post.count()).toBe(0);

    await expect(
      db.$transaction(async (tx) => {
        await tx.user.create({ data: { email: "t1@x.io" } });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.user.count()).toBe(0);

    const n = await db.$transaction(async (tx) => {
      await tx.user.create({ data: { email: "t1@x.io" } });
      await tx.user.create({ data: { email: "t2@x.io" } });
      return tx.user.count();
    });
    expect(n).toBe(2);
  });

  it("validates input at runtime", async () => {
    // Bypass the types to simulate untyped callers.
    const loose = db.user as unknown as {
      findMany(a: unknown): Promise<unknown>;
      create(a: unknown): Promise<unknown>;
    };
    await expect(loose.findMany({ where: { "x` OR 1=1 //": 1 } })).rejects.toBeInstanceOf(
      CyphraValidationError,
    );
    await expect(loose.create({ data: { name: "no email" } })).rejects.toBeInstanceOf(
      CyphraValidationError,
    );
    await expect(loose.create({ data: { email: "a", age: 1.5 } })).rejects.toBeInstanceOf(
      CyphraValidationError,
    );
    await expect(
      (db.user as unknown as { findUnique(a: unknown): Promise<unknown> }).findUnique({
        where: { name: "x" },
      }),
    ).rejects.toBeInstanceOf(CyphraValidationError);
  });
});

/** Schema commands cannot share a transaction with data writes, so run them on their own. */
async function schemaCommand(db: Db, text: string): Promise<void> {
  await db.$client.withSession(async (s) => {
    await s.run(text);
  });
}

describe.skipIf(!hasNeo)("ORM write correctness (Neo4j)", () => {
  let db: Db;
  // Same names `cyphra db push` / migrations generate for @id / @unique.
  const constraints = {
    User_id_id: "FOR (n:User) REQUIRE n.id IS UNIQUE",
    User_email_unique: "FOR (n:User) REQUIRE n.email IS UNIQUE",
    Post_id_id: "FOR (n:Post) REQUIRE n.id IS UNIQUE",
  };

  beforeAll(async () => {
    db = createClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
    });
    await db.$cypher`MATCH (n) WHERE n:User OR n:Post DETACH DELETE n`;
    for (const [name, body] of Object.entries(constraints)) {
      await schemaCommand(db, `CREATE CONSTRAINT ${name} IF NOT EXISTS ${body}`);
    }
  });

  beforeEach(async () => {
    await db.$cypher`MATCH (n) WHERE n:User OR n:Post DETACH DELETE n`;
  });

  afterAll(async () => {
    if (!db) return;
    await db.$cypher`MATCH (n) WHERE n:User OR n:Post DETACH DELETE n`;
    for (const name of Object.keys(constraints)) {
      await schemaCommand(db, `DROP CONSTRAINT ${name} IF EXISTS`);
    }
    await db.$disconnect();
  });

  it("concurrent upserts of one new key create exactly one node, without errors", async () => {
    for (let run = 0; run < 5; run++) {
      await db.$cypher`MATCH (n:User) DETACH DELETE n`;
      const results = await Promise.allSettled(
        Array.from({ length: 15 }, (_, i) =>
          db.user.upsert({
            where: { email: "race@x.io" },
            create: { email: "race@x.io", age: 1, name: `creator ${i}` },
            update: { age: { increment: 1 } },
          }),
        ),
      );
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);
      expect(await db.user.count({ where: { email: "race@x.io" } })).toBe(1);
      const u = await db.user.findUniqueOrThrow({ where: { email: "race@x.io" } });
      expect(u.age).toBe(15); // one create + 14 increments, none lost
      const ids = new Set(results.map((r) => (r.status === "fulfilled" ? r.value.id : "")));
      expect(ids).toEqual(new Set([u.id]));
    }
  });

  it("upsert: select/include, nested writes per branch, extra where filters", async () => {
    const bob = await db.user.create({ data: { email: "bob@x.io" } });
    const created = await db.user.upsert({
      where: { email: "a@x.io" },
      create: { email: "a@x.io", following: { connect: { id: bob.id } } },
      update: { name: "updated", posts: { create: { title: "from update" } } },
      include: { following: { select: { email: true } }, posts: true },
    });
    expect(created.name).toBeNull();
    expect(created.id).toMatch(/^[a-z][a-z0-9]{23}$/);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.following.map((u) => u.email)).toEqual(["bob@x.io"]);
    expect(created.posts).toEqual([]);

    const updated = await db.user.upsert({
      where: { email: "a@x.io" },
      create: { email: "a@x.io", following: { connect: { id: bob.id } } },
      update: { name: "updated", posts: { create: { title: "from update" } } },
      select: { id: true, name: true, posts: { select: { title: true } } },
    });
    expect(updated).toEqual({ id: created.id, name: "updated", posts: [{ title: "from update" }] });

    // Extra filters: matched node must satisfy them, or nothing is written.
    await expect(
      db.user.upsert({
        where: { email: "a@x.io", name: "someone else" },
        create: { email: "a@x.io" },
        update: { age: 99 },
      }),
    ).rejects.toThrow(/does not match the rest of where/);
    expect((await db.user.findUniqueOrThrow({ where: { email: "a@x.io" } })).age).toBeNull();
    const ok = await db.user.upsert({
      where: { email: "a@x.io", name: "updated" },
      create: { email: "a@x.io" },
      update: { name: "again" },
    });
    expect(ok.name).toBe("again");
    expect(await db.user.count()).toBe(2);
  });

  it("connect is idempotent: one edge per pair, including concurrent connects", async () => {
    const a = await db.user.create({ data: { email: "a@x.io" } });
    const b = await db.user.create({
      data: { email: "b@x.io", following: { connect: { id: a.id } } },
    });
    const edges = async () => {
      const [row] = await db.$cypher<{ c: number }>`
        MATCH (:User {email: "b@x.io"})-[r:FOLLOWS]->(:User {email: "a@x.io"}) RETURN count(r) AS c`;
      return row!.c;
    };
    await db.user.update({ where: { id: b.id }, data: { following: { connect: { id: a.id } } } });
    await db.user.update({ where: { id: b.id }, data: { following: { connect: [{ id: a.id }] } } });
    await db.user.update({ where: { id: a.id }, data: { followers: { connect: { id: b.id } } } });
    expect(await edges()).toBe(1);

    await db.user.update({
      where: { id: b.id },
      data: { following: { disconnect: { id: a.id } } },
    });
    await Promise.all(
      Array.from({ length: 10 }, () =>
        db.user.update({ where: { id: b.id }, data: { following: { connect: { id: a.id } } } }),
      ),
    );
    expect(await edges()).toBe(1);

    // Typed edge: a reconnect keeps the original defaults unless $edge sets them.
    const [before] = await db.$cypher<{ since: Date }>`
      MATCH (:User {email: "b@x.io"})-[r:FOLLOWS]->() RETURN r.since AS since`;
    await db.user.update({ where: { id: b.id }, data: { following: { connect: { id: a.id } } } });
    const [kept] = await db.$cypher<{ since: Date }>`
      MATCH (:User {email: "b@x.io"})-[r:FOLLOWS]->() RETURN r.since AS since`;
    expect(kept!.since.getTime()).toBe(before!.since.getTime());
    const since = new Date("2020-05-06T07:08:09Z");
    const reloaded = await db.user.update({
      where: { id: b.id },
      data: { following: { connect: { id: a.id, $edge: { since } } } },
      include: { following: true },
    });
    expect(reloaded.following).toHaveLength(1);
    expect(reloaded.following[0]!.$edge.since.getTime()).toBe(since.getTime());

    // set: replaces edges, connecting an already-linked node keeps one edge.
    await db.user.update({ where: { id: b.id }, data: { following: { set: [{ id: a.id }] } } });
    expect(await edges()).toBe(1);

    // To-one: reconnect the same author keeps one edge; another author moves it.
    const post = await db.post.create({ data: { title: "t", author: { connect: { id: a.id } } } });
    await db.post.update({ where: { id: post.id }, data: { author: { connect: { id: a.id } } } });
    await db.post.update({ where: { id: post.id }, data: { author: { connect: { id: b.id } } } });
    const [authored] = await db.$cypher<{ c: number }>`
      MATCH (:Post)<-[r:AUTHORED]-(u:User) RETURN count(r) AS c`;
    expect(authored!.c).toBe(1);
    expect((await db.post.findFirst({ include: { author: true } }))!.author!.id).toBe(b.id);
  });

  it("connect from the many side moves a node whose inverse is to-one (Post.author)", async () => {
    const a = await db.user.create({ data: { email: "a@x.io" } });
    const b = await db.user.create({ data: { email: "b@x.io" } });
    const post = await db.post.create({
      data: { id: "p1", title: "t", author: { connect: { id: a.id } } },
    });
    const authorEdges = async () => {
      const [row] = await db.$cypher<{ c: number }>`
        MATCH (:Post {id: "p1"})<-[r:AUTHORED]-() RETURN count(r) AS c`;
      return row!.c;
    };
    const author = async () =>
      (await db.post.findUniqueOrThrow({ where: { id: post.id }, include: { author: true } }))
        .author?.email;

    await db.user.update({ where: { id: b.id }, data: { posts: { connect: { id: post.id } } } });
    expect([await authorEdges(), await author()]).toEqual([1, "b@x.io"]);
    // Reconnecting the current author keeps the edge.
    await db.user.update({ where: { id: b.id }, data: { posts: { connect: { id: post.id } } } });
    expect([await authorEdges(), await author()]).toEqual([1, "b@x.io"]);
    // set, nested create-connect and upsert all go through connect.
    await db.user.update({ where: { id: a.id }, data: { posts: { set: [{ id: post.id }] } } });
    expect([await authorEdges(), await author()]).toEqual([1, "a@x.io"]);
    await db.user.create({ data: { email: "c@x.io", posts: { connect: { id: post.id } } } });
    expect([await authorEdges(), await author()]).toEqual([1, "c@x.io"]);
    await db.user.upsert({
      where: { email: "a@x.io" },
      create: { email: "a@x.io" },
      update: { posts: { connect: [{ id: post.id }] } },
    });
    expect([await authorEdges(), await author()]).toEqual([1, "a@x.io"]);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: b.id }, include: { posts: true } })).posts,
    ).toEqual([]);

    // Concurrent connects of one post from different users: exactly one author edge.
    const users = await Promise.all(
      Array.from({ length: 8 }, (_, i) => db.user.create({ data: { email: `w${i}@x.io` } })),
    );
    for (const size of [2, 2, 2, 2, 2, 8, 8, 8, 8, 8]) {
      await Promise.all(
        users
          .slice(0, size)
          .map((u) =>
            db.user.update({ where: { id: u.id }, data: { posts: { connect: { id: post.id } } } }),
          ),
      );
      expect(await authorEdges()).toBe(1);
    }
  });

  it("to-one connect from the owning side: concurrent author changes leave one edge", async () => {
    const users = await Promise.all(
      Array.from({ length: 8 }, (_, i) => db.user.create({ data: { email: `o${i}@x.io` } })),
    );
    const post = await db.post.create({
      data: { id: "p1", title: "t", author: { connect: { id: users[0]!.id } } },
    });
    const authorEdges = async () => {
      const [row] = await db.$cypher<{ c: number }>`
        MATCH (:Post {id: "p1"})<-[r:AUTHORED]-() RETURN count(r) AS c`;
      return row!.c;
    };
    for (const size of [2, 2, 2, 2, 2, 8, 8, 8, 8, 8]) {
      await Promise.all(
        users
          .slice(0, size)
          .map((u) =>
            db.post.update({ where: { id: post.id }, data: { author: { connect: { id: u.id } } } }),
          ),
      );
      expect(await authorEdges()).toBe(1);
    }
    // Through upsert's update branch too.
    await Promise.all(
      users.map((u) =>
        db.post.upsert({
          where: { id: post.id },
          create: { id: post.id, title: "t" },
          update: { author: { connect: { id: u.id } } },
        }),
      ),
    );
    expect(await authorEdges()).toBe(1);
  });

  it.each(["America/New_York", "Asia/Kolkata", "UTC"])(
    "stores DateTime in UTC and filters by instant (process TZ=%s)",
    async (tz) => {
      const prevTz = process.env.TZ;
      process.env.TZ = tz;
      try {
        const at = new Date("2024-03-10T07:30:15.123Z");
        const u = await db.user.create({ data: { email: "t@x.io", createdAt: at } });
        const d = await db.user.create({ data: { email: "d@x.io" } }); // @default(now())
        expect(u.createdAt.getTime()).toBe(at.getTime());

        const stored = await db.$cypher<{ s: string; offset: string }>`
          MATCH (u:User) RETURN toString(u.createdAt) AS s, u.createdAt.offset AS offset
          ORDER BY u.email`;
        expect(stored.map((r) => r.offset)).toEqual(["Z", "Z"]);
        expect(stored[1]!.s).toBe("2024-03-10T07:30:15.123Z");

        const eq = await db.user.findMany({ where: { createdAt: at } });
        expect(eq.map((x) => x.email)).toEqual(["t@x.io"]);
        expect(await db.user.count({ where: { createdAt: { gte: at, lte: at } } })).toBe(1);
        expect(await db.user.count({ where: { createdAt: { in: [at] } } })).toBe(1);
        expect(await db.user.count({ where: { createdAt: d.createdAt } })).toBe(1);
        const [{ same }] = (await db.$cypher<{ same: boolean }>`
          MATCH (u:User {email: "t@x.io"})
          RETURN u.createdAt = datetime("2024-03-10T07:30:15.123Z") AS same`) as [
          { same: boolean },
        ];
        expect(same).toBe(true);
      } finally {
        if (prevTz === undefined) delete process.env.TZ;
        else process.env.TZ = prevTz;
      }
    },
  );

  it("string lt / lte / gt / gte filters (keyset pagination on a string tie-breaker)", async () => {
    for (const id of ["p1", "p2", "p3", "p4", "p5"]) {
      await db.post.create({ data: { id, title: `title ${id}`, published: true } });
    }
    expect(
      (
        await db.post.findMany({ where: { id: { gt: "p2", lte: "p4" } }, orderBy: { id: "asc" } })
      ).map((p) => p.id),
    ).toEqual(["p3", "p4"]);
    expect(await db.post.count({ where: { title: { lt: "title p3" } } })).toBe(2);
    expect(await db.post.count({ where: { title: { gte: "title p3" } } })).toBe(3);
    expect(await db.post.count({ where: { id: { not: { lt: "p5" } } } })).toBe(1);

    // Keyset pagination as in the docs: (createdAt DESC, id DESC), ties on createdAt.
    const t1 = new Date("2024-01-01T00:00:00Z");
    const t2 = new Date("2024-01-02T00:00:00Z");
    await db.user.createMany({
      data: ["u1", "u2", "u3", "u4", "u5"].map((id, i) => ({
        id,
        email: `${id}@x.io`,
        createdAt: i < 3 ? t1 : t2,
      })),
    });
    type Cursor = { createdAt: Date; id: string };
    const usersAfter = (after: Cursor | null) =>
      db.user.findMany({
        where: after
          ? {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }
          : {},
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 2,
      });
    const seen: string[] = [];
    let page = await usersAfter(null);
    while (page.length > 0) {
      seen.push(...page.map((u) => u.id));
      const last = page[page.length - 1]!;
      page = await usersAfter({ createdAt: last.createdAt, id: last.id });
    }
    expect(seen).toEqual(["u5", "u4", "u3", "u2", "u1"]);
  });
});

describe.skipIf(!hasNeo)("ORM aggregate / groupBy (Neo4j)", () => {
  let db: Db;

  beforeEach(async () => {
    db ??= createClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
    });
    await db.$cypher`MATCH (n) WHERE n:User OR n:Post DETACH DELETE n`;
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function seed() {
    await db.user.create({
      data: {
        email: "alice@x.io",
        name: "Alice",
        age: 30,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        posts: {
          create: [
            {
              title: "a1",
              published: true,
              views: 10,
              score: 1.5,
              publishedOn: new Date("2024-02-01"),
            },
            { title: "a2", published: true, views: 30, score: 2.5 },
            { title: "a3", views: 5 },
          ],
        },
      },
    });
    await db.user.create({
      data: {
        email: "bob@x.io",
        name: "Bob",
        createdAt: new Date("2023-06-15T12:30:45.123Z"),
        posts: {
          create: [
            { title: "b1", published: true, views: 100, publishedOn: new Date("2023-12-31") },
          ],
        },
      },
    });
    await db.user.create({
      data: { email: "carol@x.io", age: 40, createdAt: new Date("2025-03-01T08:00:00Z") },
    });
    await db.post.create({ data: { title: "orphan", views: 1 } });
  }

  it("aggregates with nulls ignored, typed numbers and UTC DateTime min/max", async () => {
    await seed();
    const posts = await db.post.aggregate({
      _count: { _all: true, score: true, publishedOn: true },
      _sum: { views: true, score: true },
      _avg: { views: true, score: true },
      _min: { views: true, title: true, publishedOn: true },
      _max: { views: true, title: true, publishedOn: true },
    });
    expect(posts).toEqual({
      _count: { _all: 5, score: 2, publishedOn: 2 },
      _sum: { views: 146, score: expect.closeTo(4, 9) },
      // Neo4j's avg() can be off in the last bit (29.199999999999996): compare floats closely.
      _avg: { views: expect.closeTo(29.2, 9), score: expect.closeTo(2, 9) },
      _min: { views: 1, title: "a1", publishedOn: new Date("2023-12-31T00:00:00.000Z") },
      _max: { views: 100, title: "orphan", publishedOn: new Date("2024-02-01T00:00:00.000Z") },
    });

    const users = await db.user.aggregate({
      _count: true,
      _avg: { age: true },
      _min: { createdAt: true },
      _max: { createdAt: true },
    });
    expect(users._count).toBe(3);
    expect(users._avg.age).toBeCloseTo(35, 9);
    expect(users._min.createdAt!.toISOString()).toBe("2023-06-15T12:30:45.123Z");
    expect(users._max.createdAt!.toISOString()).toBe("2025-03-01T08:00:00.000Z");
  });

  it("returns 0 counts and null aggregates on an empty set", async () => {
    await seed();
    const none = await db.post.aggregate({
      where: { title: "missing" },
      _count: { _all: true, views: true },
      _sum: { views: true },
      _avg: { views: true },
      _min: { publishedOn: true },
      _max: { title: true },
    });
    expect(none).toEqual({
      _count: { _all: 0, views: 0 },
      _sum: { views: null },
      _avg: { views: null },
      _min: { publishedOn: null },
      _max: { title: null },
    });
    // All-null values behave like an empty set for _sum.
    const nulls = await db.post.aggregate({
      where: { score: null },
      _sum: { score: true },
      _count: true,
    });
    expect(nulls).toEqual({ _count: 3, _sum: { score: null } });
  });

  it("filters with where (relations) and windows with orderBy / take", async () => {
    await seed();
    const alice = await db.post.aggregate({
      where: { author: { is: { email: "alice@x.io" } } },
      _sum: { views: true },
    });
    expect(alice._sum.views).toBe(45);
    const top2 = await db.post.aggregate({
      orderBy: { views: "desc" },
      take: 2,
      _sum: { views: true },
    });
    expect(top2._sum.views).toBe(130);
  });

  it("groupBy with having and orderBy on aggregates", async () => {
    await seed();
    const rows = await db.post.groupBy({
      by: ["published"],
      _count: { _all: true },
      _sum: { views: true },
      _avg: { score: true },
      orderBy: { _sum: { views: "desc" } },
    });
    expect(rows).toEqual([
      {
        published: true,
        _count: { _all: 3 },
        _sum: { views: 140 },
        _avg: { score: expect.closeTo(2, 9) },
      },
      { published: false, _count: { _all: 2 }, _sum: { views: 6 }, _avg: { score: null } },
    ]);

    const busy = await db.post.groupBy({
      by: "published",
      having: { views: { _avg: { gt: 10 } } },
      _count: true,
    });
    expect(busy).toEqual([{ published: true, _count: 3 }]);

    const byKey = await db.post.groupBy({
      by: ["published"],
      having: { published: false, id: { _count: { gte: 1 } } },
      _max: { views: true },
    });
    expect(byKey).toEqual([{ published: false, _max: { views: 5 } }]);

    const paged = await db.post.groupBy({
      by: ["title"],
      orderBy: [{ _max: { views: "desc" } }, { title: "asc" }],
      skip: 1,
      take: 2,
    });
    expect(paged).toEqual([{ title: "a2" }, { title: "a1" }]);
  });

  it("groupBy nullable keys and fields of a to-one relation", async () => {
    await seed();
    const byAge = await db.user.groupBy({ by: "age", _count: true, orderBy: { age: "asc" } });
    expect(byAge).toEqual([
      { age: 30, _count: 1 },
      { age: 40, _count: 1 },
      { age: null, _count: 1 },
    ]);

    const byAuthor = await db.post.groupBy({
      by: ["author.name", "author.email"],
      _count: { _all: true },
      _sum: { views: true },
      orderBy: { author: { name: "asc" } },
    });
    expect(byAuthor).toEqual([
      { author: { name: "Alice", email: "alice@x.io" }, _count: { _all: 3 }, _sum: { views: 45 } },
      { author: { name: "Bob", email: "bob@x.io" }, _count: { _all: 1 }, _sum: { views: 100 } },
      { author: { name: null, email: null }, _count: { _all: 1 }, _sum: { views: 1 } },
    ]);

    const named = await db.post.groupBy({
      by: ["author.name"],
      having: { author: { name: { not: null } }, views: { _sum: { gt: 50 } } },
    });
    expect(named).toEqual([{ author: { name: "Bob" } }]);

    expect(
      await db.post.groupBy({ by: ["published"], where: { title: "missing" }, _count: true }),
    ).toEqual([]);
  });

  it("works inside $transaction and sees uncommitted writes", async () => {
    const out = await db.$transaction(async (tx) => {
      await tx.post.createMany({
        data: [
          { title: "t1", views: 2 },
          { title: "t2", views: 4 },
        ],
      });
      const agg = await tx.post.aggregate({ _count: true, _avg: { views: true } });
      const groups = await tx.post.groupBy({
        by: ["views"],
        _count: true,
        orderBy: { views: "asc" },
      });
      return { agg, groups };
    });
    expect(out).toEqual({
      agg: { _count: 2, _avg: { views: expect.closeTo(3, 9) } },
      groups: [
        { views: 2, _count: 1 },
        { views: 4, _count: 1 },
      ],
    });
  });

  it("rejects invalid aggregates at runtime", async () => {
    const loose = db.post as unknown as {
      aggregate(a: unknown): Promise<unknown>;
      groupBy(a: unknown): Promise<unknown>;
    };
    await expect(loose.aggregate({ _sum: { title: true } })).rejects.toBeInstanceOf(
      CyphraValidationError,
    );
    await expect(loose.groupBy({ by: ["nope"] })).rejects.toBeInstanceOf(CyphraValidationError);
    await expect(
      loose.groupBy({ by: ["published"], orderBy: { title: "asc" } }),
    ).rejects.toBeInstanceOf(CyphraValidationError);
  });
});

describe.skipIf(!hasNeo)("ORM relation counts (Neo4j)", () => {
  let db: Db;

  beforeEach(async () => {
    db ??= createClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
    });
    await db.$cypher`MATCH (n) WHERE n:User OR n:Post DETACH DELETE n`;
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  /** alice: 3 posts (2 published), follows bob and carol; bob: 1 post, follows alice; carol: none. */
  async function seed() {
    await db.user.create({ data: { email: "carol@x.io", name: "Carol" } });
    await db.user.create({
      data: { email: "bob@x.io", name: "Bob", posts: { create: [{ title: "b1" }] } },
    });
    await db.user.create({
      data: {
        email: "alice@x.io",
        name: "Alice",
        posts: {
          create: [
            { title: "a1", published: true, views: 10 },
            { title: "a2", published: true, views: 1 },
            { title: "a3" },
          ],
        },
        following: { connect: [{ email: "bob@x.io" }, { email: "carol@x.io" }] },
      },
    });
    await db.user.update({
      where: { email: "bob@x.io" },
      data: { following: { connect: { email: "alice@x.io" } } },
    });
  }

  it("include: { _count: true } counts every to-many relation, in its direction", async () => {
    await seed();
    const users = await db.user.findMany({
      include: { _count: true },
      orderBy: { email: "asc" },
    });
    expect(users.map((u) => [u.email, u._count])).toEqual([
      ["alice@x.io", { posts: 3, following: 2, followers: 1 }],
      ["bob@x.io", { posts: 1, following: 1, followers: 1 }],
      ["carol@x.io", { posts: 0, following: 0, followers: 1 }],
    ]);
    expect(users[0]!.name).toBe("Alice");
  });

  it("_count.select with where (incl. nested relation filters), under select and nested", async () => {
    await seed();
    const alice = await db.user.findUniqueOrThrow({
      where: { email: "alice@x.io" },
      select: {
        name: true,
        _count: {
          select: {
            posts: { where: { published: true, views: { gt: 5 } } },
            following: { where: { posts: { some: {} } } },
          },
        },
      },
    });
    expect(alice).toEqual({ name: "Alice", _count: { posts: 1, following: 1 } });

    const posts = await db.post.findMany({
      where: { title: { in: ["a1", "b1"] } },
      orderBy: { title: "asc" },
      select: {
        title: true,
        author: {
          select: {
            email: true,
            _count: { select: { posts: true } },
            followers: { select: { email: true, _count: { select: { following: true } } } },
          },
        },
      },
    });
    expect(posts).toEqual([
      {
        title: "a1",
        author: {
          email: "alice@x.io",
          _count: { posts: 3 },
          followers: [{ email: "bob@x.io", _count: { following: 1 }, $edge: expect.anything() }],
        },
      },
      {
        title: "b1",
        author: {
          email: "bob@x.io",
          _count: { posts: 1 },
          followers: [{ email: "alice@x.io", _count: { following: 2 }, $edge: expect.anything() }],
        },
      },
    ]);
  });

  it("counts in write results and inside $transaction", async () => {
    await seed();
    const created = await db.user.create({
      data: { email: "dan@x.io", posts: { create: [{ title: "d1" }, { title: "d2" }] } },
      include: { _count: { select: { posts: true } } },
    });
    expect(created._count).toEqual({ posts: 2 });

    const updated = await db.user.update({
      where: { email: "dan@x.io" },
      data: { following: { connect: { email: "alice@x.io" } } },
      select: { _count: { select: { following: true } } },
    });
    expect(updated).toEqual({ _count: { following: 1 } });

    const upserted = await db.user.upsert({
      where: { email: "carol@x.io" },
      create: { email: "carol@x.io" },
      update: { name: "Caroline" },
      select: { name: true, _count: { select: { followers: true } } },
    });
    expect(upserted).toEqual({ name: "Caroline", _count: { followers: 1 } });

    const [counted, deleted] = await db.$transaction(async (tx) => [
      await tx.user.findFirst({
        where: { email: "alice@x.io" },
        select: { _count: { select: { followers: true } } },
      }),
      await tx.user.delete({
        where: { email: "dan@x.io" },
        select: { email: true, _count: { select: { posts: true } } },
      }),
    ]);
    expect(counted).toEqual({ _count: { followers: 2 } });
    expect(deleted).toEqual({ email: "dan@x.io", _count: { posts: 2 } });
  });

  it("orders by relation count (with paging and inside included relations)", async () => {
    await seed();
    const byPosts = await db.user.findMany({
      orderBy: [{ posts: { _count: "desc" } }, { email: "asc" }],
      select: { email: true },
    });
    expect(byPosts.map((u) => u.email)).toEqual(["alice@x.io", "bob@x.io", "carol@x.io"]);

    const top = await db.user.findMany({
      orderBy: [{ following: { _count: "asc" } }, { email: "asc" }],
      skip: 1,
      take: 1,
      select: { email: true },
    });
    expect(top.map((u) => u.email)).toEqual(["bob@x.io"]);

    const alice = await db.user.findUniqueOrThrow({
      where: { email: "alice@x.io" },
      select: {
        following: { orderBy: { posts: { _count: "desc" } }, select: { email: true } },
      },
    });
    expect(alice.following.map((u) => u.email)).toEqual(["bob@x.io", "carol@x.io"]);
  });

  it("rejects counting a to-one relation", async () => {
    const loose = db as unknown as {
      post: { findMany(args: unknown): Promise<unknown> };
    };
    await expect(
      loose.post.findMany({ include: { _count: { select: { author: true } } } }),
    ).rejects.toBeInstanceOf(CyphraValidationError);
    await expect(
      loose.post.findMany({ orderBy: { author: { _count: "asc" } } }),
    ).rejects.toBeInstanceOf(CyphraValidationError);
  });
});

describe.skipIf(!hasNeo)("ORM traversals and paths (Neo4j)", () => {
  let db: Db;

  beforeEach(async () => {
    db ??= createClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
    });
    await db.$cypher`MATCH (n) WHERE n:User OR n:Post DETACH DELETE n`;
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const day = (s: string) => new Date(`${s}T00:00:00Z`);

  /**
   * FOLLOWS edges (with `since`): alice→bob (2024), alice→carol (2022), bob→carol (2024),
   * carol→alice (2023, a cycle), carol→dave (2025), dave→erin (2025). erin is 15, the others 30.
   */
  async function seed() {
    for (const name of ["alice", "bob", "carol", "dave", "erin"]) {
      await db.user.create({
        data: { email: `${name}@x.io`, name, age: name === "erin" ? 15 : 30 },
      });
    }
    const follow = async (from: string, to: string, since: string) =>
      db.user.update({
        where: { email: `${from}@x.io` },
        data: { following: { connect: { email: `${to}@x.io`, $edge: { since: day(since) } } } },
      });
    await follow("alice", "bob", "2024-01-01");
    await follow("alice", "carol", "2022-01-01");
    await follow("bob", "carol", "2024-06-01");
    await follow("carol", "alice", "2023-01-01");
    await follow("carol", "dave", "2025-01-01");
    await follow("dave", "erin", "2025-06-01");
  }

  const emails = (rows: { email: string }[]) => rows.map((r) => r.email.split("@")[0]);

  it("returns friends of friends once each, skipping cycles back to the start", async () => {
    await seed();
    const fof = await db.user.traverse({
      from: { email: "alice@x.io" },
      via: "following",
      depth: { max: 2 },
      orderBy: { email: "asc" },
    });
    expect(emails(fof)).toEqual(["bob", "carol", "dave"]);
    expect(fof[0]).toMatchObject({ name: "bob", age: 30, tags: [] });
    expect(fof[0]!.createdAt).toBeInstanceOf(Date);

    const exactlyTwo = await db.user.traverse({
      from: { email: "alice@x.io" },
      via: "following",
      depth: { min: 2, max: 2 },
      orderBy: { email: "asc" },
    });
    expect(emails(exactlyTwo)).toEqual(["carol", "dave"]);

    // The cycle alice→carol→alice does not loop: the deepest bound still terminates.
    const all = await db.user.traverse({
      from: { email: "alice@x.io" },
      via: "following",
      depth: { max: 10 },
      orderBy: { email: "asc" },
    });
    expect(emails(all)).toEqual(["bob", "carol", "dave", "erin"]);

    const withStart = await db.user.traverse({
      from: { email: "alice@x.io" },
      via: "following",
      depth: { min: 0, max: 1 },
      orderBy: { email: "asc" },
    });
    expect(emails(withStart)).toEqual(["alice", "bob", "carol"]);
  });

  it("keeps one result per path with distinct: false", async () => {
    await seed();
    const paths = await db.user.traverse({
      from: { email: "alice@x.io" },
      via: "following",
      depth: { max: 2 },
      distinct: false,
      orderBy: { email: "asc" },
    });
    // bob, carol (direct), carol (via bob), dave (via carol); alice via carol is a cycle.
    expect(emails(paths)).toEqual(["bob", "carol", "carol", "dave"]);
  });

  it("filters reached nodes and edges, pages and projects", async () => {
    await seed();
    const adults = await db.user.traverse({
      from: { email: "alice@x.io" },
      via: "following",
      depth: { max: 4 },
      where: { age: { gte: 18 } },
      orderBy: { email: "desc" },
      skip: 1,
      take: 2,
      select: { email: true, _count: { select: { followers: true } } },
    });
    expect(adults).toEqual([
      { email: "carol@x.io", _count: { followers: 2 } },
      { email: "bob@x.io", _count: { followers: 1 } },
    ]);

    // Only edges since 2024: alice→carol (2022) is not followed, so carol is two hops away.
    const recent = await db.user.traverse({
      from: { email: "alice@x.io" },
      via: "following",
      depth: { max: 2 },
      edgeWhere: { since: { gte: day("2024-01-01") } },
      orderBy: { email: "asc" },
    });
    expect(emails(recent)).toEqual(["bob", "carol"]);

    const included = await db.user.traverse({
      from: { email: "dave@x.io" },
      via: "following",
      depth: { max: 1 },
      include: { followers: { select: { email: true } } },
    });
    expect(included).toHaveLength(1);
    expect(included[0]!.followers).toEqual([
      { email: "dave@x.io", $edge: { since: day("2025-06-01") } },
    ]);
  });

  it("follows declared, reversed and undirected directions", async () => {
    await seed();
    const upstream = await db.user.traverse({
      from: { email: "dave@x.io" },
      via: "followers",
      depth: { max: 2 },
      orderBy: { email: "asc" },
    });
    expect(emails(upstream)).toEqual(["alice", "bob", "carol"]);

    const reversed = await db.user.traverse({
      from: { email: "dave@x.io" },
      via: "following",
      direction: "in",
      depth: { max: 2 },
      orderBy: { email: "asc" },
    });
    expect(emails(reversed)).toEqual(emails(upstream));

    const around = await db.user.traverse({
      from: { email: "erin@x.io" },
      via: ["following", "followers"],
      depth: { max: 2 },
      orderBy: { email: "asc" },
    });
    expect(emails(around)).toEqual(["carol", "dave"]);

    const both = await db.user.traverse({
      from: { email: "erin@x.io" },
      via: "following",
      direction: "both",
      depth: { max: 2 },
      orderBy: { email: "asc" },
    });
    expect(emails(both)).toEqual(["carol", "dave"]);
  });

  it("returns typed paths: nodes, edge types, directions and edge properties", async () => {
    await seed();
    const rows = await db.user.traverse({
      from: { email: "alice@x.io" },
      via: "following",
      depth: { max: 3 },
      where: { email: "dave@x.io" },
      select: { email: true },
      returnPaths: true,
    });
    expect(rows).toHaveLength(1);
    const { node, path } = rows[0]!;
    expect(node).toEqual({ email: "dave@x.io" });
    // The shortest of alice→carol→dave and alice→bob→carol→dave.
    expect(path.nodes.map((n) => n.name)).toEqual(["alice", "carol", "dave"]);
    expect(path.nodes[0]!.createdAt).toBeInstanceOf(Date);
    expect(path.edges).toEqual([
      { type: "FOLLOWS", direction: "out", properties: { since: day("2022-01-01") } },
      { type: "FOLLOWS", direction: "out", properties: { since: day("2025-01-01") } },
    ]);

    const every = await db.user.traverse({
      from: { email: "alice@x.io" },
      via: "following",
      depth: { max: 3 },
      where: { email: "dave@x.io" },
      distinct: false,
      returnPaths: true,
    });
    expect(every.map((r) => r.path.edges.length).sort()).toEqual([2, 3]);

    const back = await db.user.traverse({
      from: { email: "carol@x.io" },
      via: "followers",
      depth: { max: 1 },
      orderBy: { email: "asc" },
      returnPaths: true,
    });
    expect(back.map((r) => r.node.name)).toEqual(["alice", "bob"]);
    expect(back[1]!.path.nodes.map((n) => n.name)).toEqual(["carol", "bob"]);
    expect(back[1]!.path.edges).toEqual([
      { type: "FOLLOWS", direction: "in", properties: { since: day("2024-06-01") } },
    ]);

    const zero = await db.user.traverse({
      from: { email: "erin@x.io" },
      via: "following",
      depth: { min: 0, max: 1 },
      returnPaths: true,
    });
    expect(zero).toHaveLength(1);
    expect(zero[0]!.path.nodes.map((n) => n.name)).toEqual(["erin"]);
    expect(zero[0]!.path.edges).toEqual([]);
  });

  it("runs inside $transaction and sees its own writes", async () => {
    await seed();
    const reached = await db.$transaction(async (tx) => {
      await tx.user.create({
        data: { email: "frank@x.io", following: { connect: { email: "alice@x.io" } } },
      });
      return tx.user.traverse({
        from: { email: "frank@x.io" },
        via: "following",
        depth: { max: 2 },
        orderBy: { email: "asc" },
        select: { email: true },
      });
    });
    expect(emails(reached)).toEqual(["alice", "bob", "carol"]);
  });

  it("enforces depth bounds and the client's maxTraversalDepth", async () => {
    await seed();
    const loose = db as unknown as { user: { traverse(args: unknown): Promise<unknown> } };
    const base = { from: { email: "alice@x.io" }, via: "following" };
    await expect(loose.user.traverse({ ...base, depth: { min: 1 } })).rejects.toBeInstanceOf(
      CyphraValidationError,
    );
    await expect(loose.user.traverse({ ...base, depth: { max: 11 } })).rejects.toBeInstanceOf(
      CyphraValidationError,
    );
    await expect(
      loose.user.traverse({ ...base, via: "friends", depth: { max: 2 } }),
    ).rejects.toBeInstanceOf(CyphraValidationError);

    const capped = createClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
      maxTraversalDepth: 2,
    });
    try {
      await expect(
        capped.user.traverse({ ...base, via: "following", depth: { max: 3 } }),
      ).rejects.toThrow(/maxTraversalDepth/);
      const ok = await capped.user.traverse({ ...base, via: "following", depth: { max: 2 } });
      expect(ok).toHaveLength(3);
    } finally {
      await capped.$disconnect();
    }
  });
});

describe.skipIf(!hasNeo)("ORM shortest paths (Neo4j)", () => {
  let db: Db;

  beforeEach(async () => {
    db ??= createClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
    });
    await db.$cypher`MATCH (n) WHERE n:User OR n:Post DETACH DELETE n`;
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const day = (s: string) => new Date(`${s}T00:00:00Z`);
  const at = (name: string) => ({ email: `${name}@x.io` });
  const names = (path: { nodes: { name: string | null }[] } | null) =>
    path?.nodes.map((n) => n.name);

  /**
   * FOLLOWS edges (with `since`): alice→bob (2024), alice→carol (2022), bob→dave (2024),
   * carol→dave (2025), dave→erin (2025), erin→alice (2023). Two shortest alice→dave paths (via bob
   * and via carol); frank has no edges. carol is 15, the others 30.
   */
  async function seed() {
    for (const name of ["alice", "bob", "carol", "dave", "erin", "frank"]) {
      await db.user.create({ data: { ...at(name), name, age: name === "carol" ? 15 : 30 } });
    }
    const follow = async (from: string, to: string, since: string) =>
      db.user.update({
        where: at(from),
        data: { following: { connect: { ...at(to), $edge: { since: day(since) } } } },
      });
    await follow("alice", "bob", "2024-01-01");
    await follow("alice", "carol", "2022-01-01");
    await follow("bob", "dave", "2024-06-01");
    await follow("carol", "dave", "2025-01-01");
    await follow("dave", "erin", "2025-06-01");
    await follow("erin", "alice", "2023-01-01");
  }

  it("returns one typed shortest path, or null when there is none", async () => {
    await seed();
    const path = await db.user.shortestPath({
      from: at("alice"),
      to: at("erin"),
      via: "following",
      maxDepth: 5,
    });
    expect(path).not.toBeNull();
    expect(path!.nodes).toHaveLength(4);
    expect(path!.nodes[0]).toMatchObject({ name: "alice", age: 30, tags: [] });
    expect(path!.nodes[0]!.createdAt).toBeInstanceOf(Date);
    expect([
      ["alice", "bob", "dave", "erin"],
      ["alice", "carol", "dave", "erin"],
    ]).toContainEqual(names(path));
    expect(path!.edges.map((e) => [e.type, e.direction])).toEqual([
      ["FOLLOWS", "out"],
      ["FOLLOWS", "out"],
      ["FOLLOWS", "out"],
    ]);
    expect(path!.edges[2]!.properties).toEqual({ since: day("2025-06-01") });

    expect(
      await db.user.shortestPath({
        from: at("alice"),
        to: at("frank"),
        via: "following",
        maxDepth: 5,
      }),
    ).toBeNull();
    expect(
      await db.user.shortestPath({
        from: at("nobody"),
        to: at("bob"),
        via: "following",
        maxDepth: 5,
      }),
    ).toBeNull();
    expect(
      await db.user.allShortestPaths({
        from: at("alice"),
        to: at("frank"),
        via: "following",
        maxDepth: 5,
      }),
    ).toEqual([]);
  });

  it("joins a node to itself with a zero-hop path", async () => {
    await seed();
    const self = await db.user.shortestPath({
      from: at("bob"),
      to: at("bob"),
      via: "following",
      maxDepth: 3,
    });
    expect(names(self)).toEqual(["bob"]);
    expect(self!.edges).toEqual([]);
    const all = await db.user.allShortestPaths({
      from: at("bob"),
      to: at("bob"),
      via: "following",
      maxDepth: 3,
    });
    expect(all.map(names)).toEqual([["bob"]]);
  });

  it("returns every tied shortest path, capped by take", async () => {
    await seed();
    const all = await db.user.allShortestPaths({
      from: at("alice"),
      to: at("dave"),
      via: "following",
      maxDepth: 4,
    });
    expect(all.map(names).sort()).toEqual([
      ["alice", "bob", "dave"],
      ["alice", "carol", "dave"],
    ]);
    const one = await db.user.allShortestPaths({
      from: at("alice"),
      to: at("dave"),
      via: "following",
      maxDepth: 4,
      take: 1,
    });
    expect(one).toHaveLength(1);

    // Several end nodes: only the paths of the overall minimum length are kept.
    const nearest = await db.user.allShortestPaths({
      from: at("alice"),
      to: { email: { in: ["dave@x.io", "erin@x.io"] } },
      via: "following",
      maxDepth: 4,
    });
    expect(nearest.map((p) => p.nodes.at(-1)!.name)).toEqual(["dave", "dave"]);
    const first = await db.user.shortestPath({
      from: at("alice"),
      to: { email: { in: ["dave@x.io", "erin@x.io"] } },
      via: "following",
      maxDepth: 4,
    });
    expect(first!.nodes.at(-1)!.name).toBe("dave");
  });

  it("follows declared, reversed and undirected directions", async () => {
    await seed();
    const back = await db.user.shortestPath({
      from: at("alice"),
      to: at("erin"),
      via: "followers",
      maxDepth: 5,
    });
    expect(names(back)).toEqual(["alice", "erin"]);
    expect(back!.edges).toEqual([
      { type: "FOLLOWS", direction: "in", properties: { since: day("2023-01-01") } },
    ]);
    const reversed = await db.user.shortestPath({
      from: at("alice"),
      to: at("erin"),
      via: "following",
      direction: "in",
      maxDepth: 5,
    });
    expect(names(reversed)).toEqual(["alice", "erin"]);
    const both = await db.user.shortestPath({
      from: at("dave"),
      to: at("alice"),
      via: "following",
      direction: "both",
      maxDepth: 5,
    });
    expect(both!.edges).toHaveLength(2);
    // dave→erin→alice, or against the arrows through bob or carol: three tied paths.
    expect([
      ["out", "out"],
      ["in", "in"],
    ]).toContainEqual(both!.edges.map((e) => e.direction));
    const ties = await db.user.allShortestPaths({
      from: at("dave"),
      to: at("alice"),
      via: "following",
      direction: "both",
      maxDepth: 5,
    });
    expect(ties.map((p) => p.nodes[1]!.name).sort()).toEqual(["bob", "carol", "erin"]);
  });

  it("filters edges and intermediate nodes during the search", async () => {
    await seed();
    // Only edges since 2024: alice→carol (2022) is skipped, so the path goes through bob.
    const recent = await db.user.allShortestPaths({
      from: at("alice"),
      to: at("dave"),
      via: "following",
      maxDepth: 4,
      edgeWhere: { since: { gte: day("2024-01-01") } },
    });
    expect(recent.map(names)).toEqual([["alice", "bob", "dave"]]);

    // Adults only on the way: carol (15) cannot be an intermediate node.
    const adults = await db.user.allShortestPaths({
      from: at("alice"),
      to: at("dave"),
      via: "following",
      maxDepth: 4,
      where: { age: { gte: 18 } },
    });
    expect(adults.map(names)).toEqual([["alice", "bob", "dave"]]);

    // where does not apply to the end node.
    const toCarol = await db.user.shortestPath({
      from: at("alice"),
      to: at("carol"),
      via: "following",
      maxDepth: 4,
      where: { age: { gte: 18 } },
    });
    expect(names(toCarol)).toEqual(["alice", "carol"]);

    // Filters apply before the shortest path is picked: when they rule out the shortest path,
    // the next shortest one is returned (not null).
    await db.user.update({
      where: at("carol"),
      data: { following: { connect: { ...at("erin"), $edge: { since: day("2025-02-01") } } } },
    });
    const base = { from: at("alice"), to: at("erin"), via: "following" as const, maxDepth: 5 };
    expect(names(await db.user.shortestPath(base))).toEqual(["alice", "carol", "erin"]);
    expect(names(await db.user.shortestPath({ ...base, where: { age: { gte: 18 } } }))).toEqual([
      "alice",
      "bob",
      "dave",
      "erin",
    ]);
    expect(
      names(
        await db.user.shortestPath({ ...base, edgeWhere: { since: { gte: day("2024-01-01") } } }),
      ),
    ).toEqual(["alice", "bob", "dave", "erin"]);
    const viaRelation = await db.user.shortestPath({
      from: at("alice"),
      to: at("dave"),
      via: "following",
      maxDepth: 4,
      where: { following: { some: { name: "dave" } }, NOT: { name: "bob" } },
    });
    expect(names(viaRelation)).toEqual(["alice", "carol", "dave"]);
  });

  it("projects path nodes with select / include", async () => {
    await seed();
    const path = await db.user.shortestPath({
      from: at("alice"),
      to: at("erin"),
      via: "following",
      maxDepth: 5,
      edgeWhere: { since: { gte: day("2024-01-01") } },
      select: { email: true, _count: { select: { followers: true } } },
    });
    expect(path!.nodes).toEqual([
      { email: "alice@x.io", _count: { followers: 1 } },
      { email: "bob@x.io", _count: { followers: 1 } },
      { email: "dave@x.io", _count: { followers: 2 } },
      { email: "erin@x.io", _count: { followers: 1 } },
    ]);
    const included = await db.user.shortestPath({
      from: at("dave"),
      to: at("erin"),
      via: "following",
      maxDepth: 1,
      include: { following: { select: { email: true } } },
    });
    expect(included!.nodes.map((n) => n.following.map((f) => f.email))).toEqual([
      ["erin@x.io"],
      ["alice@x.io"],
    ]);
  });

  it("respects maxDepth and the client's maxTraversalDepth", async () => {
    await seed();
    const base = { from: at("alice"), to: at("erin"), via: "following" as const };
    expect(await db.user.shortestPath({ ...base, maxDepth: 2 })).toBeNull();
    expect(names(await db.user.shortestPath({ ...base, maxDepth: 3 }))).toHaveLength(4);

    const loose = db as unknown as { user: { shortestPath(args: unknown): Promise<unknown> } };
    await expect(loose.user.shortestPath({ ...base })).rejects.toBeInstanceOf(
      CyphraValidationError,
    );
    await expect(loose.user.shortestPath({ ...base, maxDepth: 11 })).rejects.toBeInstanceOf(
      CyphraValidationError,
    );
    await expect(
      loose.user.shortestPath({ ...base, via: "posts", maxDepth: 2 }),
    ).rejects.toBeInstanceOf(CyphraValidationError);

    const capped = createClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
      maxTraversalDepth: 2,
    });
    try {
      await expect(capped.user.allShortestPaths({ ...base, maxDepth: 3 })).rejects.toThrow(
        /maxTraversalDepth/,
      );
      expect(await capped.user.allShortestPaths({ ...base, maxDepth: 2 })).toEqual([]);
    } finally {
      await capped.$disconnect();
    }
  });

  it("runs inside $transaction and sees its own writes", async () => {
    await seed();
    const path = await db.$transaction(async (tx) => {
      await tx.user.update({
        where: at("alice"),
        data: { following: { connect: at("erin") } },
      });
      return tx.user.shortestPath({
        from: at("alice"),
        to: at("erin"),
        via: "following",
        maxDepth: 3,
        select: { name: true },
      });
    });
    expect(path!.nodes).toEqual([{ name: "alice" }, { name: "erin" }]);
    expect(path!.edges[0]!.properties.since).toBeInstanceOf(Date); // @default(now())
  });
});

describe.skipIf(!hasNeo)("ORM vector search (Neo4j)", () => {
  let db: VectorDb;

  // Same statements as `cyphra push` / migrations generate for __fixtures__/vector.cyphra.
  const ddl = [
    "CREATE VECTOR INDEX VecChunk_embedding_vector IF NOT EXISTS FOR (n:`VecChunk`) ON n.`embedding` OPTIONS {indexConfig: {`vector.dimensions`: 3, `vector.similarity_function`: 'cosine'}}",
    "CREATE VECTOR INDEX vec_chunk_sketch IF NOT EXISTS FOR (n:`VecChunk`) ON n.`sketch` OPTIONS {indexConfig: {`vector.dimensions`: 2, `vector.similarity_function`: 'euclidean', `vector.quantization.enabled`: false}}",
  ];

  const chunks = [
    { id: "c1", doc: "en", embedding: [1, 0, 0], sketch: [0, 0] },
    { id: "c2", doc: "en", embedding: [0.9, 0.1, 0], sketch: [1, 0] },
    { id: "c3", doc: "fr", embedding: [0, 1, 0], sketch: [3, 0] },
    { id: "c4", doc: "fr", embedding: [0.8, 0.2, 0.1], sketch: [2, 0] },
    { id: "c5", doc: "en", embedding: [0.1, 0.05, 1], sketch: [5, 5] },
    { id: "c6", doc: "fr", embedding: null, sketch: null },
  ];

  beforeAll(async () => {
    db = createVectorClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
    });
    await db.$client.withSession(async (s) => {
      for (const stmt of ddl) await s.run(stmt);
      await s.run("CALL db.awaitIndexes(120)");
    });
  });

  beforeEach(async () => {
    await db.$cypher`MATCH (n) WHERE n:VecDoc OR n:VecChunk DETACH DELETE n`;
    await db.vecDoc.create({ data: { id: "en", title: "English", lang: "en" } });
    await db.vecDoc.create({ data: { id: "fr", title: "French", lang: "fr" } });
    for (const [i, c] of chunks.entries()) {
      await db.vecChunk.create({
        data: {
          id: c.id,
          text: `chunk ${c.id}`,
          position: i,
          embedding: c.embedding,
          sketch: c.sketch,
          doc: { connect: { id: c.doc } },
        },
      });
    }
  });

  afterAll(async () => {
    if (!db) return;
    await db.$cypher`MATCH (n) WHERE n:VecDoc OR n:VecChunk DETACH DELETE n`;
    await db.$disconnect();
  });

  const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

  it("creates ONLINE vector indexes and stores vectors as LIST<FLOAT>", async () => {
    const indexes = await db.$cypher<{ name: string; state: string; options: unknown }>`
      SHOW VECTOR INDEXES YIELD name, state, options WHERE name IN ['VecChunk_embedding_vector', 'vec_chunk_sketch']
      RETURN name, state, options ORDER BY name`;
    expect(indexes.map((i) => [i.name, i.state])).toEqual([
      ["VecChunk_embedding_vector", "ONLINE"],
      ["vec_chunk_sketch", "ONLINE"],
    ]);
    const [row] = await db.$cypher<{ t: string }>`
      MATCH (c:VecChunk {id: 'c1'}) RETURN valueType(c.embedding) AS t`;
    expect(row!.t).toMatch(/^LIST<FLOAT/);
    const c1 = await db.vecChunk.findUniqueOrThrow({ where: { id: "c1" } });
    expect(c1.embedding).toEqual([1, 0, 0]);
    expect((await db.vecChunk.findUniqueOrThrow({ where: { id: "c6" } })).embedding).toBeNull();
  });

  it("returns the k nearest nodes, best first, with $score", async () => {
    const hits = await db.vecChunk.findSimilar({ field: "embedding", vector: [1, 0, 0], k: 3 });
    expect(ids(hits)).toEqual(["c1", "c2", "c4"]);
    // Cosine scores are (1 + cos) / 2 (approximate: the index quantizes vectors by default).
    expect(hits[0]!.$score).toBeCloseTo(1, 1);
    const cos = 0.8 / Math.sqrt(0.8 ** 2 + 0.2 ** 2 + 0.1 ** 2);
    expect(hits[2]!.$score).toBeCloseTo((1 + cos) / 2, 1);
    expect(hits.map((h) => h.$score)).toEqual([...hits.map((h) => h.$score)].sort((a, b) => b - a));
    expect(hits[0]).toMatchObject({
      id: "c1",
      text: "chunk c1",
      position: 0,
      embedding: [1, 0, 0],
    });

    // Nodes without an embedding are not in the index.
    const all = await db.vecChunk.findSimilar({ field: "embedding", vector: [1, 0, 0], k: 10 });
    expect(ids(all).sort()).toEqual(["c1", "c2", "c3", "c4", "c5"]);
  });

  it("filters with where and still returns k rows (widening the candidate set)", async () => {
    const fr = await db.vecChunk.findSimilar({
      field: "embedding",
      vector: [1, 0, 0],
      k: 2,
      where: { doc: { is: { lang: "fr" } } },
      candidates: 2, // the 2 nearest are English: forces a second, wider attempt
    });
    expect(ids(fr)).toEqual(["c4", "c3"]);

    // Bounded: never asks the index for more than maxCandidates neighbours.
    const bounded = await db.vecChunk.findSimilar({
      field: "embedding",
      vector: [1, 0, 0],
      k: 2,
      where: { doc: { is: { lang: "fr" } } },
      candidates: 2,
      maxCandidates: 3,
    });
    expect(ids(bounded)).toEqual(["c4"]);

    const scalarFilter = await db.vecChunk.findSimilar({
      field: "embedding",
      vector: [0, 1, 0],
      k: 2,
      where: { position: { gte: 3 } },
    });
    expect(ids(scalarFilter)).toEqual(["c4", "c5"]);
  });

  it("drops results below minScore", async () => {
    const hits = await db.vecChunk.findSimilar({
      field: "embedding",
      vector: [1, 0, 0],
      k: 5,
      minScore: 0.75,
    });
    expect(ids(hits)).toEqual(["c1", "c2", "c4"]);
    const filtered = await db.vecChunk.findSimilar({
      field: "embedding",
      vector: [1, 0, 0],
      k: 5,
      minScore: 0.75,
      where: { doc: { is: { lang: "en" } } },
      candidates: 5,
    });
    expect(ids(filtered)).toEqual(["c1", "c2"]);
  });

  it("includes related nodes (graph expansion) and honours select", async () => {
    const hits = await db.vecChunk.findSimilar({
      field: "embedding",
      vector: [0, 1, 0],
      k: 2,
      include: {
        doc: { include: { chunks: { select: { id: true }, orderBy: { position: "asc" } } } },
      },
    });
    expect(ids(hits)).toEqual(["c3", "c4"]);
    expect(hits[0]!.doc!.title).toBe("French");
    expect(hits[0]!.doc!.chunks.map((c) => c.id)).toEqual(["c3", "c4", "c6"]);

    const selected = await db.vecChunk.findSimilar({
      field: "embedding",
      vector: [0, 1, 0],
      k: 1,
      select: { text: true, doc: { select: { lang: true } } },
    });
    expect(selected).toEqual([
      { text: "chunk c3", doc: { lang: "fr" }, $score: expect.closeTo(1, 1) },
    ]);
  });

  it("exact: true scores the filtered nodes like the index does", async () => {
    const viaIndex = await db.vecChunk.findSimilar({ field: "embedding", vector: [1, 0, 0], k: 5 });
    const exact = await db.vecChunk.findSimilar({
      field: "embedding",
      vector: [1, 0, 0],
      k: 5,
      exact: true,
    });
    expect(ids(exact)).toEqual(ids(viaIndex));
    // Exact scores; the default (quantized) index is close but not identical.
    expect(exact[0]!.$score).toBeCloseTo(1, 6);
    exact.forEach((h, i) => expect(h.$score).toBeCloseTo(viaIndex[i]!.$score, 1));

    const fr = await db.vecChunk.findSimilar({
      field: "embedding",
      vector: [1, 0, 0],
      k: 5,
      exact: true,
      where: { doc: { is: { lang: "fr" } } },
      minScore: 0.6,
    });
    expect(ids(fr)).toEqual(["c4"]);
  });

  it("searches a euclidean index with a custom name", async () => {
    const hits = await db.vecChunk.findSimilar({ field: "sketch", vector: [0, 0], k: 3 });
    expect(ids(hits)).toEqual(["c1", "c2", "c4"]);
    expect(hits[0]!.$score).toBeCloseTo(1, 5);
    expect(hits[1]!.$score).toBeCloseTo(1 / (1 + 1), 5); // 1 / (1 + d²)
    const exact = await db.vecChunk.findSimilar({
      field: "sketch",
      vector: [0, 0],
      k: 3,
      exact: true,
    });
    exact.forEach((h, i) => expect(h.$score).toBeCloseTo(hits[i]!.$score, 5));
  });

  it("validates dimensions on writes and queries", async () => {
    await expect(
      db.vecChunk.findSimilar({ field: "embedding", vector: [1, 0], k: 1 }),
    ).rejects.toThrow(/3 dimensions, got 2/);
    await expect(
      db.vecChunk.create({ data: { id: "bad", text: "x", position: 9, embedding: [1, 2] } }),
    ).rejects.toBeInstanceOf(CyphraValidationError);
    await expect(
      db.vecChunk.update({ where: { id: "c1" }, data: { embedding: [1, Number.NaN, 0] } }),
    ).rejects.toThrow(/finite number/);
    await expect(
      // @ts-expect-error — raw has no @vectorIndex
      db.vecChunk.findSimilar({ field: "raw", vector: [1, 0, 0, 0], k: 1 }),
    ).rejects.toThrow(/no @vectorIndex/);
    await expect(
      db.vecChunk.findSimilar({ field: "embedding", vector: [1, 0, 0], k: 0 }),
    ).rejects.toThrow(/k must be a positive integer/);

    // Updates and null filters on vector fields.
    await db.vecChunk.update({ where: { id: "c6" }, data: { embedding: [0, 0.5, 0.5] } });
    await db.vecChunk.update({ where: { id: "c5" }, data: { embedding: null } });
    expect(ids(await db.vecChunk.findMany({ where: { embedding: null } }))).toEqual(["c5"]);
    expect(await db.vecChunk.count({ where: { embedding: { not: null } } })).toBe(5);
    const hits = await db.vecChunk.findSimilar({ field: "embedding", vector: [0, 0, 1], k: 1 });
    expect(ids(hits)).toEqual(["c6"]);
  });

  it("runs inside $transaction", async () => {
    const hits = await db.$transaction(async (tx) => {
      await tx.vecChunk.update({ where: { id: "c3" }, data: { text: "updated" } });
      return tx.vecChunk.findSimilar({
        field: "embedding",
        vector: [0, 1, 0],
        k: 1,
        where: { text: "updated" },
      });
    });
    expect(hits).toMatchObject([{ id: "c3", text: "updated" }]);

    // The vector index only holds committed data; exact: true also sees the transaction's writes.
    const [viaIndex, exact] = await db.$transaction(async (tx) => {
      await tx.vecChunk.create({
        data: { id: "new", text: "new", position: 9, embedding: [0.3, 0.3, 0.9] },
      });
      const args = { field: "embedding", vector: [0.3, 0.3, 0.9], k: 1 } as const;
      return [
        await tx.vecChunk.findSimilar(args),
        await tx.vecChunk.findSimilar({ ...args, exact: true }),
      ];
    });
    expect(ids(viaIndex)).not.toContain("new");
    expect(ids(exact)).toEqual(["new"]);
  });
});

describe.skipIf(!hasNeo)("ORM full-text search (Neo4j)", () => {
  let db: SearchDb;

  // Same statements as `cyphra push` / migrations generate for __fixtures__/search.cyphra.
  const ddl = [
    "CREATE FULLTEXT INDEX ftPostSearch IF NOT EXISTS FOR (n:`FtPost`) ON EACH [n.`title`, n.`body`] OPTIONS {indexConfig: {`fulltext.eventually_consistent`: false}}",
    "CREATE FULLTEXT INDEX ftPostTags IF NOT EXISTS FOR (n:`FtPost`) ON EACH [n.`tags`] OPTIONS {indexConfig: {`fulltext.analyzer`: 'keyword'}}",
    "CREATE FULLTEXT INDEX ftPostTitleEnglish IF NOT EXISTS FOR (n:`FtPost`) ON EACH [n.`title`] OPTIONS {indexConfig: {`fulltext.analyzer`: 'english'}}",
  ];

  const posts = [
    {
      id: "p1",
      title: "Graph databases",
      body: "Neo4j stores graphs. Graph graph graph.",
      tags: ["neo4j", "Graph DB"],
      published: true,
      author: "ada",
    },
    {
      id: "p2",
      title: "Running a graph in production",
      body: "Operations notes",
      tags: ["ops"],
      published: true,
      author: "bob",
    },
    {
      id: "p3",
      title: "C++ (beta) notes",
      body: "Templates AND macros",
      tags: ["cpp"],
      published: false,
      author: "bob",
    },
    {
      id: "p4",
      title: "Cooking",
      body: "A graph of recipes",
      tags: [],
      published: true,
      author: "ada",
    },
    { id: "p5", title: "Untitled", body: null, tags: [], published: true, author: "ada" },
  ];

  beforeAll(async () => {
    db = createSearchClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
    });
    await db.$client.withSession(async (s) => {
      for (const stmt of ddl) await s.run(stmt);
      await s.run("CALL db.awaitIndexes(120)");
    });
  });

  beforeEach(async () => {
    await db.$cypher`MATCH (n) WHERE n:FtAuthor OR n:FtPost DETACH DELETE n`;
    await db.ftAuthor.create({ data: { id: "ada", name: "Ada", country: "UK" } });
    await db.ftAuthor.create({ data: { id: "bob", name: "Bob", country: "FR" } });
    for (const p of posts) {
      const { author, ...data } = p;
      await db.ftPost.create({ data: { ...data, author: { connect: { id: author } } } });
    }
  });

  afterAll(async () => {
    if (!db) return;
    await db.$cypher`MATCH (n) WHERE n:FtAuthor OR n:FtPost DETACH DELETE n`;
    await db.$disconnect();
  });

  const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

  it("creates ONLINE full-text indexes", async () => {
    const indexes = await db.$cypher<{ name: string; state: string }>`
      SHOW FULLTEXT INDEXES YIELD name, state WHERE name STARTS WITH 'ftPost'
      RETURN name, state ORDER BY name`;
    expect(indexes).toEqual([
      { name: "ftPostSearch", state: "ONLINE" },
      { name: "ftPostTags", state: "ONLINE" },
      { name: "ftPostTitleEnglish", state: "ONLINE" },
    ]);
  });

  it("ranks matches across the indexed fields, best first, with $score", async () => {
    const hits = await db.ftPost.search({ index: "ftPostSearch", query: "graph" });
    // p1 mentions "graph" most often; p5 (no match) is absent.
    expect(ids(hits)[0]).toBe("p1");
    expect(ids(hits).sort()).toEqual(["p1", "p2", "p4"]);
    expect(hits.every((h) => h.$score > 0)).toBe(true);
    expect(hits.map((h) => h.$score)).toEqual([...hits.map((h) => h.$score)].sort((a, b) => b - a));
    expect(hits[0]).toMatchObject({
      id: "p1",
      title: "Graph databases",
      tags: ["neo4j", "Graph DB"],
      published: true,
    });
    // A boosted title match outranks body matches.
    const boosted = await db.ftPost.search({
      index: "ftPostSearch",
      query: "title:graph^10 OR graph",
    });
    expect(ids(boosted).slice(0, 2).sort()).toEqual(["p1", "p2"]);
  });

  it("filters with where after the index call and pages with skip / take", async () => {
    const byBob = await db.ftPost.search({
      index: "ftPostSearch",
      query: "graph OR notes",
      where: { author: { is: { country: "FR" } }, published: true },
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
    const filteredPage = await db.ftPost.search({
      index: "ftPostSearch",
      query: "graph",
      where: { author: { is: { id: "ada" } } },
      take: 1,
      skip: 1,
    });
    expect(ids(filteredPage)).toEqual(["p4"]);

    const top = all[0]!.$score;
    const strong = await db.ftPost.search({ index: "ftPostSearch", query: "graph", minScore: top });
    expect(ids(strong)).toEqual(["p1"]);
    expect(await db.ftPost.search({ index: "ftPostSearch", query: "graph", take: 0 })).toEqual([]);
  });

  it("passes Lucene syntax through and escapes user input", async () => {
    expect(ids(await db.ftPost.search({ index: "ftPostSearch", query: "prod*" }))).toEqual(["p2"]);
    expect(
      ids(
        await db.ftPost.search({
          index: "ftPostSearch",
          query: "title:cooking OR body:operations",
        }),
      ).sort(),
    ).toEqual(["p2", "p4"]);
    // Unbalanced syntax is a Lucene parse error in lucene mode…
    await expect(db.ftPost.search({ index: "ftPostSearch", query: "C++ (beta" })).rejects.toThrow();
    // …and plain words in terms / phrase mode or after escapeLucene.
    expect(
      ids(await db.ftPost.search({ index: "ftPostSearch", query: "C++ (beta", mode: "terms" })),
    ).toEqual(["p3"]);
    expect(
      ids(await db.ftPost.search({ index: "ftPostSearch", query: escapeLucene("(beta) AND") })),
    ).toEqual(["p3"]);
    // "AND" is a word here, not an operator: it matches p3's body, and only p3 has "macros".
    expect(
      ids(await db.ftPost.search({ index: "ftPostSearch", query: "macros AND", mode: "terms" })),
    ).toEqual(["p3"]);
    expect(
      ids(
        await db.ftPost.search({ index: "ftPostSearch", query: "graph databases", mode: "phrase" }),
      ),
    ).toEqual(["p1"]);
    expect(
      await db.ftPost.search({ index: "ftPostSearch", query: "databases graph", mode: "phrase" }),
    ).toEqual([]);
    expect(await db.ftPost.search({ index: "ftPostSearch", query: "  " })).toEqual([]);
  });

  it("follows each index's analyzer", async () => {
    // keyword: the whole value is one token, case-sensitive; String[] values are indexed each.
    const tag = (query: string) =>
      db.ftPost.search({ index: "ftPostTags", query, mode: "phrase" }).then(ids);
    expect(await tag("Graph DB")).toEqual(["p1"]);
    expect(await tag("graph db")).toEqual([]);
    expect(await tag("Graph")).toEqual([]);
    expect(await tag("ops")).toEqual(["p2"]);
    // english: stems ("running" ~ "run") and drops stop words; the default analyzer does neither.
    expect(ids(await db.ftPost.search({ index: "ftPostTitleEnglish", query: "run" }))).toEqual([
      "p2",
    ]);
    expect(await db.ftPost.search({ index: "ftPostSearch", query: "run" })).toEqual([]);
    expect(await db.ftPost.search({ index: "ftPostTitleEnglish", query: "a" })).toEqual([]);
  });

  it("runs inside $transaction and sees the transaction's own writes", async () => {
    const hits = await db.$transaction(async (tx) => {
      await tx.ftPost.create({
        data: { id: "new", title: "Fresh graph news", tags: [], published: true },
      });
      await tx.ftPost.update({ where: { id: "p4" }, data: { body: "Recipes only" } });
      return tx.ftPost.search({ index: "ftPostSearch", query: "graph", select: { id: true } });
    });
    // Full-text indexes that are not eventually consistent include uncommitted changes.
    expect(ids(hits)).toContain("new");
    expect(ids(hits)).not.toContain("p4");

    await expect(
      db.$transaction(async (tx) => {
        await tx.ftPost.create({
          data: { id: "gone", title: "Ephemeral graph", tags: [], published: true },
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(ids(await db.ftPost.search({ index: "ftPostSearch", query: "ephemeral" }))).toEqual([]);
  });

  it("validates arguments before querying", async () => {
    await expect(
      db.ftPost.search({ index: "nope" as "ftPostSearch", query: "x" }),
    ).rejects.toBeInstanceOf(CyphraValidationError);
  });
});

describe.skipIf(!hasNeo)("ORM enum / Json / BigInt (Neo4j)", () => {
  let db: TypesDb;
  const MAX = 2n ** 63n - 1n;
  const MIN = -(2n ** 63n);

  beforeAll(() => {
    db = createTypesClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
    });
  });

  beforeEach(async () => {
    await db.$cypher`MATCH (n:TyAccount) DETACH DELETE n`;
  });

  afterAll(async () => {
    if (db) {
      await db.$cypher`MATCH (n:TyAccount) DETACH DELETE n`;
      await db.$disconnect();
    }
  });

  it("applies enum, Json and BigInt defaults and stores each with its Cypher type", async () => {
    const a = await db.tyAccount.create({ data: { id: "a" } });
    expect(a).toEqual({
      id: "a",
      role: "VIEWER",
      roles: [],
      level: null,
      settings: null,
      prefs: { theme: "light" },
      balance: 0n,
      external: null,
      ids: [],
      score: null,
    });
    await db.tyAccount.update({
      where: { id: "a" },
      data: { roles: [TyRole.ADMIN], settings: { a: [1] }, external: MAX, ids: [MIN, 1n] },
    });
    const [types] = await db.$cypher<Record<string, string>>`
      MATCH (n:TyAccount {id: "a"})
      RETURN valueType(n.role) AS role, valueType(n.roles) AS roles,
        valueType(n.settings) AS settings, valueType(n.balance) AS balance,
        valueType(n.external) AS external, valueType(n.ids) AS ids, n.settings AS text`;
    expect(types).toEqual({
      role: "STRING NOT NULL",
      roles: "LIST<STRING NOT NULL> NOT NULL",
      settings: "STRING NOT NULL",
      balance: "INTEGER NOT NULL",
      external: "INTEGER NOT NULL",
      ids: "LIST<INTEGER NOT NULL> NOT NULL",
      text: '{"a":[1]}',
    });
  });

  it("round-trips the full 64-bit range, filters and sorts BigInt", async () => {
    const values = [MIN, -1n, 0n, 2n ** 53n + 1n, MAX];
    for (const [i, v] of values.entries()) {
      await db.tyAccount.create({ data: { id: `b${i}`, balance: v, external: v } });
    }
    const all = await db.tyAccount.findMany({
      orderBy: { balance: "desc" },
      select: { balance: true },
    });
    expect(all.map((r) => r.balance)).toEqual([...values].reverse());
    // Exact at the bounds: 2^63 - 1 and -2^63 are not representable as JS numbers.
    const [raw] = await db.$cypher<{ s: string }>`
      MATCH (n:TyAccount {id: "b4"}) RETURN toString(n.balance) AS s`;
    expect(raw!.s).toBe("9223372036854775807");
    expect((await db.tyAccount.findUniqueOrThrow({ where: { id: "b0" } })).external).toBe(MIN);

    const ids = async (where: Parameters<TypesDb["tyAccount"]["findMany"]>[0]) =>
      (await db.tyAccount.findMany({ ...where, orderBy: { id: "asc" } })).map((r) => r.id);
    expect(await ids({ where: { balance: { gt: 0n } } })).toEqual(["b3", "b4"]);
    expect(await ids({ where: { balance: { lt: -1n } } })).toEqual(["b0"]);
    expect(await ids({ where: { balance: { gte: 2n ** 53n + 1n, lte: MAX } } })).toEqual([
      "b3",
      "b4",
    ]);
    expect(await ids({ where: { external: { in: [MIN, MAX] } } })).toEqual(["b0", "b4"]);
    expect(await ids({ where: { external: { notIn: [MIN, MAX], not: 0n } } })).toEqual([
      "b1",
      "b3",
    ]);
    expect(await ids({ where: { balance: MAX } })).toEqual(["b4"]);

    await db.tyAccount.update({ where: { id: "b2" }, data: { balance: { increment: MAX } } });
    expect((await db.tyAccount.findUniqueOrThrow({ where: { id: "b2" } })).balance).toBe(MAX);
    await expect(db.tyAccount.create({ data: { id: "x", balance: MAX + 1n } })).rejects.toThrow(
      CyphraValidationError,
    );
  });

  it("aggregates BigInt: _sum as bigint, _avg as number, _min / _max exact", async () => {
    const big = 2n ** 61n;
    await db.tyAccount.createMany({
      data: [
        { id: "a", role: "ADMIN", balance: big, score: 1 },
        { id: "b", role: "ADMIN", balance: big - 1n, score: 2 },
        { id: "c", role: "EDITOR", balance: 3n },
      ],
    });
    const agg = await db.tyAccount.aggregate({
      _sum: { balance: true, score: true },
      _avg: { balance: true },
      _min: { balance: true },
      _max: { balance: true, external: true },
    });
    const avg = Number(2n * big + 2n) / 3;
    expect(Math.abs(agg._avg.balance! - avg) / avg).toBeLessThan(1e-12);
    expect(agg).toEqual({
      _sum: { balance: 2n * big + 2n, score: 3 },
      _avg: { balance: agg._avg.balance },
      _min: { balance: 3n },
      _max: { balance: big, external: null },
    });
    const groups = await db.tyAccount.groupBy({
      by: "role",
      _sum: { balance: true },
      having: { balance: { _sum: { gt: 10n } } },
      orderBy: { role: "asc" },
    });
    expect(groups).toEqual([{ role: "ADMIN", _sum: { balance: 2n * big - 1n } }]);

    // Past 2^63 - 1, Neo4j's sum() turns into a (rounded) float: reject it rather than round.
    await db.tyAccount.create({ data: { id: "d", balance: MAX } });
    await expect(db.tyAccount.aggregate({ _sum: { balance: true } })).rejects.toThrow(RangeError);
  });

  it("validates enum values on every write (nested, createMany, upsert, update, edges)", async () => {
    const bad = "OWNER" as TyRole;
    await expect(db.tyAccount.create({ data: { id: "x", role: bad } })).rejects.toThrow(
      /TyAccount\.role: expected one of "ADMIN", "EDITOR", "VIEWER"/,
    );
    await expect(db.tyAccount.create({ data: { id: "x", roles: ["ADMIN", bad] } })).rejects.toThrow(
      CyphraValidationError,
    );
    await expect(
      db.tyAccount.createMany({ data: [{ id: "x" }, { id: "y", role: bad }] }),
    ).rejects.toThrow(CyphraValidationError);
    await expect(
      db.tyAccount.create({
        data: { id: "x", friends: { create: { id: "y", role: bad } } },
      }),
    ).rejects.toThrow(CyphraValidationError);
    await expect(
      db.tyAccount.create({
        data: {
          id: "x",
          friends: { create: { id: "y", $edge: { level: "MEDIUM" as "LOW" } } },
        },
      }),
    ).rejects.toThrow(/TyKnows\.level/);
    await expect(
      db.tyAccount.upsert({ where: { id: "x" }, create: { id: "x", role: bad }, update: {} }),
    ).rejects.toThrow(CyphraValidationError);
    // Nothing was written by the rejected statements.
    expect(await db.tyAccount.count()).toBe(0);

    await db.tyAccount.create({ data: { id: "x", role: "ADMIN" } });
    await expect(db.tyAccount.update({ where: { id: "x" }, data: { role: bad } })).rejects.toThrow(
      CyphraValidationError,
    );
    await expect(db.tyAccount.updateMany({ data: { role: bad } })).rejects.toThrow(
      CyphraValidationError,
    );
    await expect(
      db.tyAccount.upsert({ where: { id: "x" }, create: { id: "x" }, update: { role: bad } }),
    ).rejects.toThrow(CyphraValidationError);
    expect((await db.tyAccount.findUniqueOrThrow({ where: { id: "x" } })).role).toBe("ADMIN");
  });

  it("filters enums and enum lists", async () => {
    await db.tyAccount.create({
      data: { id: "a", role: "ADMIN", roles: ["EDITOR"], level: "LOW" },
    });
    await db.tyAccount.create({ data: { id: "b", role: "EDITOR", roles: ["ADMIN", "VIEWER"] } });
    await db.tyAccount.create({ data: { id: "c" } });
    const ids = async (where: Parameters<TypesDb["tyAccount"]["findMany"]>[0]) =>
      (await db.tyAccount.findMany({ ...where, orderBy: { id: "asc" } })).map((r) => r.id);
    expect(await ids({ where: { role: TyRole.ADMIN } })).toEqual(["a"]);
    expect(await ids({ where: { role: { in: ["ADMIN", "EDITOR"] } } })).toEqual(["a", "b"]);
    expect(await ids({ where: { role: { notIn: ["ADMIN"] } } })).toEqual(["b", "c"]);
    expect(await ids({ where: { role: { not: "VIEWER" } } })).toEqual(["a", "b"]);
    expect(await ids({ where: { level: null } })).toEqual(["b", "c"]);
    expect(await ids({ where: { roles: { has: "ADMIN" } } })).toEqual(["b"]);
    expect(await ids({ where: { roles: { hasSome: ["EDITOR", "VIEWER"] } } })).toEqual(["a", "b"]);
    expect(await ids({ where: { roles: { isEmpty: true } } })).toEqual(["c"]);
    await expect(db.tyAccount.findMany({ where: { role: "NOPE" as TyRole } })).rejects.toThrow(
      CyphraValidationError,
    );
  });

  it("round-trips Json values and filters on whole-value equality", async () => {
    const settings = { nested: { list: [1, "two", null, true] }, n: 1.5, s: 'é"\\' };
    await db.tyAccount.create({ data: { id: "a", settings } });
    await db.tyAccount.create({ data: { id: "b", settings: [1, 2, 3] } });
    await db.tyAccount.create({ data: { id: "c", settings: "just a string" } });
    await db.tyAccount.create({ data: { id: "d", settings: 0 } });
    await db.tyAccount.create({ data: { id: "e" } });
    const byId = async (id: string) =>
      (await db.tyAccount.findUniqueOrThrow({ where: { id } })).settings;
    expect(await byId("a")).toEqual(settings);
    expect(await byId("b")).toEqual([1, 2, 3]);
    expect(await byId("c")).toBe("just a string");
    expect(await byId("d")).toBe(0);
    expect(await byId("e")).toBeNull();

    const ids = async (where: Parameters<TypesDb["tyAccount"]["findMany"]>[0]) =>
      (await db.tyAccount.findMany({ ...where, orderBy: { id: "asc" } })).map((r) => r.id);
    expect(await ids({ where: { settings: { equals: [1, 2, 3] } } })).toEqual(["b"]);
    expect(await ids({ where: { settings: { equals: settings } } })).toEqual(["a"]);
    expect(await ids({ where: { settings: null } })).toEqual(["e"]);
    expect(await ids({ where: { settings: { not: null } } })).toEqual(["a", "b", "c", "d"]);
    expect(await ids({ where: { settings: { not: 0 } } })).toEqual(["a", "b", "c"]);

    // An object update replaces the whole value (it is not a number update).
    await db.tyAccount.update({ where: { id: "a" }, data: { settings: { increment: 1 } } });
    expect(await byId("a")).toEqual({ increment: 1 });
    await db.tyAccount.update({ where: { id: "a" }, data: { settings: null } });
    expect(await byId("a")).toBeNull();
  });

  it("types edge properties: enum default, Json and BigInt", async () => {
    await db.tyAccount.create({
      data: {
        id: "a",
        friends: {
          create: [
            { id: "b", $edge: { meta: { via: "import" }, since: MAX } },
            { id: "c", $edge: { level: "HIGH" } },
          ],
        },
      },
    });
    const a = await db.tyAccount.findUniqueOrThrow({
      where: { id: "a" },
      include: { friends: { orderBy: { id: "asc" } } },
    });
    expect(a.friends.map((f) => f.$edge)).toEqual([
      { level: "LOW", meta: { via: "import" }, since: MAX },
      { level: "HIGH", meta: null, since: null },
    ]);
  });
});

describe.skipIf(!hasNeo)("ORM points and temporal types (Neo4j)", () => {
  let db: GeoDb;
  const PARIS = { longitude: 2.3522, latitude: 48.8566 };
  const LOUVRE = { longitude: 2.3376, latitude: 48.8606 }; // ~1.2 km from PARIS
  const EIFFEL = { longitude: 2.2945, latitude: 48.8584 }; // ~4.2 km
  const VERSAILLES = { longitude: 2.1204, latitude: 48.8049 }; // ~17.8 km
  const LYON = { longitude: 4.8357, latitude: 45.764 }; // ~392 km

  beforeAll(() => {
    db = createGeoClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
    });
  });

  beforeEach(async () => {
    await db.$cypher`MATCH (n:GeoPlace) DETACH DELETE n`;
  });

  afterAll(async () => {
    if (db) {
      await db.$cypher`MATCH (n:GeoPlace) DETACH DELETE n`;
      await db.$disconnect();
    }
  });

  async function seedPlaces() {
    const places = [
      { id: "louvre", name: "Louvre", location: LOUVRE, opens: "09:00", stay: "PT3H" },
      { id: "eiffel", name: "Eiffel", location: EIFFEL, opens: "09:30", stay: "PT2H" },
      { id: "versailles", name: "Versailles", location: VERSAILLES, opens: "09:00", stay: "P1D" },
      { id: "lyon", name: "Lyon", location: LYON, opens: "08:00", stay: "P2D" },
    ] as const;
    for (const p of places) await db.geoPlace.create({ data: p });
  }

  it("stores each type as its Neo4j type and reads back the JS values", async () => {
    const before = Date.now();
    const p = await db.geoPlace.create({
      data: {
        id: "a",
        name: "A",
        location: { ...PARIS, height: 35 },
        grid: { x: 1.5, y: -2 },
        route: [PARIS, LOUVRE],
        closes: "18:30:15.25",
        slot: "10:00:00+02:00",
        starts: "2024-05-01T10:30",
        stay: "PT90M",
        windows: ["P1D", "-PT5M"],
      },
    });
    expect(p).toMatchObject({
      location: { ...PARIS, height: 35 },
      grid: { x: 1.5, y: -2 },
      route: [PARIS, LOUVRE],
      opens: "09:00:00", // @default("09:00")
      closes: "18:30:15.25",
      slot: "10:00:00+02:00",
      starts: "2024-05-01T10:30:00",
      stay: "PT1H30M",
      windows: ["P1D", "-PT5M"],
    });
    // @default(now()): the current UTC wall-clock time.
    const seen = Date.parse(`${p.seen}Z`);
    expect(seen).toBeGreaterThanOrEqual(before - 1000);
    expect(seen).toBeLessThanOrEqual(Date.now() + 1000);

    const [types] = await db.$cypher<Record<string, string>>`
      MATCH (n:GeoPlace {id: "a"})
      RETURN valueType(n.location) AS location, n.location.srid AS srid, n.grid.srid AS gridSrid,
             valueType(n.route) AS route, valueType(n.opens) AS opens, valueType(n.slot) AS slot,
             valueType(n.seen) AS seen, valueType(n.stay) AS stay, valueType(n.windows) AS windows,
             toString(n.stay) AS stayText`;
    expect(types).toEqual({
      location: "POINT NOT NULL",
      srid: 4979,
      gridSrid: 7203,
      route: "LIST<POINT NOT NULL> NOT NULL",
      opens: "LOCAL TIME NOT NULL",
      slot: "ZONED TIME NOT NULL",
      seen: "LOCAL DATETIME NOT NULL",
      stay: "DURATION NOT NULL",
      windows: "LIST<DURATION NOT NULL> NOT NULL",
      stayText: "PT1H30M",
    });
    expect(await db.geoPlace.findUnique({ where: { id: "a" } })).toEqual(p);
  });

  it("finds places within 5 km, nearest first", async () => {
    await seedPlaces();
    const near = await db.geoPlace.findMany({
      where: { location: { distance: { from: PARIS, lt: 5000 } } },
      orderBy: { location: { distanceFrom: PARIS } },
      select: { name: true },
    });
    expect(near.map((p) => p.name)).toEqual(["Louvre", "Eiffel"]);

    const ring = await db.geoPlace.findMany({
      where: { location: { distance: { from: PARIS, gte: 2000, lte: 20_000 } } },
      orderBy: { location: { distanceFrom: PARIS, sort: "desc" } },
      select: { name: true },
    });
    expect(ring.map((p) => p.name)).toEqual(["Versailles", "Eiffel"]);

    const all = await db.geoPlace.findMany({
      orderBy: [{ location: { distanceFrom: LYON } }],
      take: 2,
      select: { id: true },
    });
    expect(all.map((p) => p.id)).toEqual(["lyon", "louvre"]);

    expect(await db.geoPlace.count({ where: { location: LOUVRE } })).toBe(1);
    expect(await db.geoPlace.count({ where: { location: { not: LOUVRE } } })).toBe(3);
  });

  it("filters with a bounding box (Paris area)", async () => {
    await seedPlaces();
    const inParis = await db.geoPlace.findMany({
      where: {
        location: {
          withinBBox: {
            lowerLeft: { longitude: 2.25, latitude: 48.81 },
            upperRight: { longitude: 2.42, latitude: 48.91 },
          },
        },
      },
      orderBy: { name: "asc" },
      select: { name: true },
    });
    expect(inParis.map((p) => p.name)).toEqual(["Eiffel", "Louvre"]);
  });

  it("filters Cartesian points by distance (2D and 3D)", async () => {
    const base = { name: "c", location: PARIS };
    await db.geoPlace.create({ data: { ...base, id: "c1", grid: { x: 0, y: 0 } } });
    await db.geoPlace.create({ data: { ...base, id: "c2", grid: { x: 3, y: 4 } } });
    await db.geoPlace.create({ data: { ...base, id: "c3", grid: { x: 3, y: 4, z: 12 } } });
    const within5 = await db.geoPlace.findMany({
      where: { grid: { distance: { from: { x: 0, y: 0 }, lte: 5 } } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    // A 3D point is not compared with a 2D one (point.distance is null).
    expect(within5.map((p) => p.id)).toEqual(["c1", "c2"]);
    const [far] = await db.geoPlace.findMany({
      where: { grid: { distance: { from: { x: 0, y: 0, z: 0 }, gt: 12 } } },
      select: { id: true, grid: true },
    });
    expect(far).toEqual({ id: "c3", grid: { x: 3, y: 4, z: 12 } });
  });

  it("filters and sorts ordered temporal fields, compares durations for equality", async () => {
    await seedPlaces();
    const early = await db.geoPlace.findMany({
      where: { opens: { lt: "09:15" } },
      orderBy: [{ opens: "asc" }, { name: "asc" }],
      select: { name: true, opens: true },
    });
    expect(early).toEqual([
      { name: "Lyon", opens: "08:00:00" },
      { name: "Louvre", opens: "09:00:00" },
      { name: "Versailles", opens: "09:00:00" },
    ]);
    expect(await db.geoPlace.count({ where: { opens: { in: ["09:30", "10:00"] } } })).toBe(1);
    // Durations compare by their months / days / seconds: "PT180M" is "PT3H", "P1D" is not "PT24H".
    expect(await db.geoPlace.count({ where: { stay: "PT180M" } })).toBe(1);
    expect(await db.geoPlace.count({ where: { stay: "PT24H" } })).toBe(0);
    expect(await db.geoPlace.count({ where: { stay: { in: ["P1D", "P2D"] } } })).toBe(2);
    expect(await db.geoPlace.count({ where: { stay: { not: "P1D" } } })).toBe(3);

    await db.geoPlace.update({
      where: { id: "louvre" },
      data: { starts: "2024-05-01T09:00", slot: "09:00:00Z" },
    });
    await db.geoPlace.update({
      where: { id: "eiffel" },
      data: { starts: "2024-06-01T09:00", slot: "11:00:00+01:00" },
    });
    const may = await db.geoPlace.findMany({
      where: { starts: { gte: "2024-05-01T00:00", lt: "2024-06-01T00:00" } },
      select: { id: true },
    });
    expect(may).toEqual([{ id: "louvre" }]);
    const bySlot = await db.geoPlace.findMany({
      where: { slot: { not: null } },
      orderBy: { slot: "desc" },
      select: { id: true },
    });
    // 11:00+01:00 is 10:00Z, after 09:00Z.
    expect(bySlot.map((p) => p.id)).toEqual(["eiffel", "louvre"]);
    expect(await db.geoPlace.count({ where: { slot: { gt: "09:30Z" } } })).toBe(1);
  });

  it("aggregates _min / _max of temporal fields and groups by them", async () => {
    await seedPlaces();
    const agg = await db.geoPlace.aggregate({
      _min: { opens: true },
      _max: { opens: true },
      _count: { stay: true },
    });
    expect(agg).toEqual({
      _min: { opens: "08:00:00" },
      _max: { opens: "09:30:00" },
      _count: { stay: 4 },
    });
    const groups = await db.geoPlace.groupBy({
      by: "opens",
      _count: true,
      orderBy: { opens: "asc" },
    });
    expect(groups).toEqual([
      { opens: "08:00:00", _count: 1 },
      { opens: "09:00:00", _count: 2 },
      { opens: "09:30:00", _count: 1 },
    ]);
  });

  it("writes and filters point and temporal edge properties", async () => {
    await seedPlaces();
    await db.geoPlace.update({
      where: { id: "louvre" },
      data: {
        visits: {
          connect: [
            { id: "eiffel", $edge: { at: EIFFEL, when: "2024-05-01T12:00", took: "PT20M" } },
            { id: "lyon", $edge: { at: LYON, took: "PT2H" } },
          ],
        },
      },
    });
    const louvre = await db.geoPlace.findUniqueOrThrow({
      where: { id: "louvre" },
      include: { visits: { orderBy: { name: "asc" } } },
    });
    expect(louvre.visits.map((v) => [v.name, v.$edge])).toEqual([
      ["Eiffel", { at: EIFFEL, when: "2024-05-01T12:00:00", took: "PT20M" }],
      ["Lyon", { at: LYON, when: null, took: "PT2H" }],
    ]);
    const reached = await db.geoPlace.traverse({
      from: { id: "louvre" },
      via: "visits",
      depth: { max: 1 },
      edgeWhere: { at: { distance: { from: PARIS, lt: 10_000 } }, took: { not: "PT2H" } },
      select: { id: true },
    });
    expect(reached).toEqual([{ id: "eiffel" }]);
  });

  it("updates point and temporal fields (update, updateMany, upsert)", async () => {
    await seedPlaces();
    const moved = await db.geoPlace.update({
      where: { id: "louvre" },
      data: { location: { ...LOUVRE, height: 10 }, grid: { x: 1, y: 1 }, stay: "PT4H" },
    });
    expect(moved).toMatchObject({
      location: { ...LOUVRE, height: 10 },
      grid: { x: 1, y: 1 },
      stay: "PT4H",
    });
    const { count } = await db.geoPlace.updateMany({
      where: { location: { distance: { from: PARIS, lt: 5000 } } },
      data: { closes: "18:00", grid: null },
    });
    expect(count).toBe(1); // the Louvre is now a 3D point: no distance to the 2D PARIS
    const up = await db.geoPlace.upsert({
      where: { id: "new" },
      create: { id: "new", name: "New", location: PARIS, slot: "07:00Z" },
      update: { location: LYON },
    });
    expect(up).toMatchObject({ location: PARIS, slot: "07:00:00Z", opens: "09:00:00" });
    const again = await db.geoPlace.upsert({
      where: { id: "new" },
      create: { id: "new", name: "New", location: PARIS },
      update: { location: LYON },
    });
    expect(again.location).toEqual(LYON);
  });

  it("rejects invalid values before querying", async () => {
    await expect(
      db.geoPlace.create({
        data: { id: "x", name: "x", location: { longitude: 0, latitude: 95 } },
      }),
    ).rejects.toThrow(CyphraValidationError);
    await expect(
      db.geoPlace.findMany({ where: { stay: { gt: "PT1H" } } as never }),
    ).rejects.toThrow(/durations have no total order/);
    await expect(
      db.geoPlace.create({
        data: { id: "x", name: "x", location: PARIS, slot: "10:00" as never },
      }),
    ).rejects.toThrow(/expected Time/);
  });
});

describe.skipIf(!hasNeo)("ORM logging and missing-index warnings (Neo4j)", () => {
  type DriverModule = {
    driver(uri: string, auth: unknown): DriverLike;
    auth: { basic(user: string, password: string): unknown };
  };
  const majors: [string, DriverModule][] = [
    ["5", neo4j5 as unknown as DriverModule],
    ["6", neo4j6 as unknown as DriverModule],
  ];
  const conn = () => ({
    uri: process.env.NEO4J_TEST_URI!,
    user: process.env.NEO4J_TEST_USER!,
    password: process.env.NEO4J_TEST_PASSWORD!,
  });
  let admin: Db;

  beforeAll(async () => {
    admin = createClient(conn());
    await admin.$cypher`MATCH (n) WHERE n:User OR n:Post DETACH DELETE n`;
    await schemaCommand(
      admin,
      "CREATE INDEX obs_post_views IF NOT EXISTS FOR (n:Post) ON (n.views)",
    );
    await schemaCommand(admin, "CALL db.awaitIndexes(60)");
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.$cypher`MATCH (n) WHERE n:User OR n:Post DETACH DELETE n`;
    await schemaCommand(admin, "DROP INDEX obs_post_views IF EXISTS");
    await admin.$disconnect();
  });

  // `{ driver }` is a Bolt driver: not run when the suite targets the HTTP transport.
  const overHttp = /^https?:\/\//i.test(process.env.NEO4J_TEST_URI ?? "");
  for (const [major, mod] of majors) {
    it.skipIf(overHttp)(`reports durations, rows and errors (neo4j-driver ${major})`, async () => {
      const { uri, user, password } = conn();
      const driver = mod.driver(uri, mod.auth.basic(user, password));
      const events: CyphraEvent[] = [];
      const db = createClient({ driver, log: (e) => events.push(e) });
      try {
        await db.$cypher`MATCH (n) WHERE n:User OR n:Post DETACH DELETE n`;
        await db.post.createMany({ data: [{ title: "a" }, { title: "b" }, { title: "c" }] });
        events.length = 0;

        const posts = await db.post.findMany({ where: { published: false } });
        expect(posts).toHaveLength(3);
        const q = events.find((e): e is QueryEvent => e.type === "query")!;
        expect(q).toMatchObject({
          model: "Post",
          operation: "findMany",
          rows: 3,
          transaction: false,
          database: "neo4j",
          params: { p0: "<boolean>" },
        });
        expect(q.durationMs).toBeGreaterThan(0);

        events.length = 0;
        await expect(db.$cypher`RETURN ${1} +* 2`).rejects.toThrow();
        const err = events.find((e): e is ErrorEvent => e.type === "error")!;
        expect(err.code).toBe("Neo.ClientError.Statement.SyntaxError");
        expect(err.operation).toBe("$cypher");
        expect(err.params).toEqual({ p0: "<number>" });
      } finally {
        await db.$disconnect();
        await driver.close();
      }
    });
  }

  it("warns once about a filtered property without an index, not about indexed ones", async () => {
    const warns: WarnEvent[] = [];
    const db = createClient({ ...conn(), warnMissingIndexes: true });
    db.$on("warn", (e) => warns.push(e));
    try {
      await db.post.create({ data: { title: "Hello", views: 3 } });
      await db.post.findMany({ where: { title: "Hello" } });
      await db.post.findMany({ where: { title: "Hello" } }); // same statement: no second EXPLAIN
      await db.post.findMany({ where: { title: { startsWith: "He" } } }); // same property
      await db.post.findMany({ where: { views: 3 } }); // indexed (obs_post_views)
      await db.post.findMany({ where: { id: "nope" } }); // @id without its constraint
      await db.user.findMany({ where: { posts: { some: { title: "Hello" } } } }); // expanded node
      await db.$client.instrumentation.flush();

      // Post.id is @id, but this block does not create its constraint.
      expect(warns.map((w) => `${w.label}.${w.property}`).sort()).toEqual([
        "Post.id",
        "Post.title",
      ]);
      const title = warns.find((w) => w.property === "title")!;
      expect(title).toMatchObject({
        type: "warn",
        kind: "missing-index",
        label: "Post",
        property: "title",
        model: "Post",
        operation: "findMany",
      });
      expect(title.message).toBe(
        "Post.title is filtered without an index (label scan + filter): add @index to Post.title in your schema.",
      );
      expect(warns.find((w) => w.property === "id")!.message).toMatch(
        /declared @id but the database has no index on Post\.id\. Apply your migrations/,
      );
    } finally {
      await db.$disconnect();
    }
  });

  it("does not EXPLAIN anything by default", async () => {
    const db = createClient(conn());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await db.post.findMany({ where: { title: "Hello" } });
      await db.$client.instrumentation.flush();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await db.$disconnect();
    }
  });
});

describe.skipIf(!hasNeo)("ORM composite unique keys (Neo4j)", () => {
  let db: CompoundDb;

  // Same statements as `cyphra push` / migrations generate for __fixtures__/compound.cyphra.
  const ddl = [
    "CREATE CONSTRAINT Member_tenantId_email_unique IF NOT EXISTS FOR (n:`Member`) REQUIRE (n.`tenantId`, n.`email`) IS UNIQUE",
    "CREATE RANGE INDEX Member_tenantId_joinedOn_idx IF NOT EXISTS FOR (n:`Member`) ON (n.`tenantId`, n.`joinedOn`)",
    "CREATE CONSTRAINT dayRoom IF NOT EXISTS FOR (n:`Slot`) REQUIRE (n.`day`, n.`room`) IS UNIQUE",
  ];
  const wipe = () => db.$cypher`MATCH (n) WHERE n:Tenant OR n:Member OR n:Slot DETACH DELETE n`;

  beforeAll(async () => {
    db = createCompoundClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
    });
    await db.$client.withSession(async (s) => {
      for (const stmt of ddl) await s.run(stmt);
      await s.run("CALL db.awaitIndexes(120)");
    });
  });

  beforeEach(async () => {
    await wipe();
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  it("rejects a duplicate composite key with a constraint error (Community)", async () => {
    await db.member.create({ data: { tenantId: "t1", email: "a@x.io", joinedOn: 1 } });
    // Same email in another tenant, same tenant with another email: both fine.
    await db.member.create({ data: { tenantId: "t2", email: "a@x.io", joinedOn: 1 } });
    await db.member.create({ data: { tenantId: "t1", email: "b@x.io", joinedOn: 1 } });
    await expect(
      db.member.create({ data: { tenantId: "t1", email: "a@x.io", joinedOn: 2 } }),
    ).rejects.toMatchObject({ code: "Neo.ClientError.Schema.ConstraintValidationFailed" });
    expect(await db.member.count()).toBe(3);
  });

  it("finds, updates and deletes by a composite key", async () => {
    await db.member.create({ data: { tenantId: "t1", email: "a@x.io", joinedOn: 1 } });
    await db.member.create({ data: { tenantId: "t2", email: "a@x.io", joinedOn: 2 } });
    const key = { tenantId_email: { tenantId: "t2", email: "a@x.io" } };
    const m = await db.member.findUnique({ where: key, select: { joinedOn: true } });
    expect(m).toEqual({ joinedOn: 2 });
    expect(
      await db.member.findUnique({
        where: { tenantId_email: { tenantId: "t3", email: "a@x.io" } },
      }),
    ).toBeNull();
    const updated = await db.member.update({ where: key, data: { role: "admin" } });
    expect(updated).toMatchObject({ tenantId: "t2", role: "admin" });
    await expect(
      db.member.findUniqueOrThrow({ where: { ...key, role: "member" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await db.member.delete({ where: key });
    expect(await db.member.findMany({ select: { tenantId: true } })).toEqual([{ tenantId: "t1" }]);
  });

  it("upserts by a composite key (custom name, model without @id)", async () => {
    const created = await db.slot.upsert({
      where: { dayRoom: { day: 1, room: "A" } },
      create: { day: 1, room: "A", label: "standup" },
      update: { label: "retro" },
    });
    expect(created).toEqual({ day: 1, room: "A", label: "standup" });
    const again = await db.slot.upsert({
      where: { dayRoom: { day: 1, room: "A" } },
      create: { day: 1, room: "A", label: "standup" },
      update: { label: "retro" },
    });
    expect(again).toEqual({ day: 1, room: "A", label: "retro" });
    await db.slot.upsert({
      where: { dayRoom: { day: 1, room: "B" } },
      create: { day: 1, room: "B" },
      update: {},
    });
    expect(await db.slot.count()).toBe(2);
    // Concurrent upserts on one key yield a single node (MERGE + the composite constraint).
    await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        db.slot.upsert({
          where: { dayRoom: { day: 2, room: "C" } },
          create: { day: 2, room: "C" },
          update: {},
        }),
      ),
    );
    expect(await db.slot.count({ where: { day: 2 } })).toBe(1);
  });

  it("connects by a composite key", async () => {
    await db.member.create({ data: { tenantId: "acme", email: "a@x.io", joinedOn: 1 } });
    const t = await db.tenant.create({
      data: {
        slug: "acme",
        members: { connect: { tenantId_email: { tenantId: "acme", email: "a@x.io" } } },
      },
      include: { members: { select: { email: true } } },
    });
    expect(t.members).toEqual([{ email: "a@x.io" }]);
    await db.tenant.update({
      where: { slug: "acme" },
      data: {
        members: { disconnect: { tenantId_email: { tenantId: "acme", email: "a@x.io" } } },
      },
    });
    expect(
      await db.member.findUniqueOrThrow({
        where: { tenantId_email: { tenantId: "acme", email: "a@x.io" } },
        include: { tenant: true },
      }),
    ).toMatchObject({ tenant: null });
  });
});
