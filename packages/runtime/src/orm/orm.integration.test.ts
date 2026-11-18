import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
