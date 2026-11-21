import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient, type Db } from "./__fixtures__/blog.gen.js";
import { CyphraValidationError, NotFoundError } from "./errors.js";

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
      _sum: { views: 146, score: 4 },
      _avg: { views: 29.2, score: 2 },
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
    expect(users._avg.age).toBe(35);
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
      { published: true, _count: { _all: 3 }, _sum: { views: 140 }, _avg: { score: 2 } },
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
      agg: { _count: 2, _avg: { views: 3 } },
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
