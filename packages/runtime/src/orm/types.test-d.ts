/**
 * Compile-time tests for the ORM's inferred types (checked by `tsc --noEmit` / `pnpm typecheck`).
 * The runtime body never executes against a database.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { Db } from "./__fixtures__/blog.gen.js";

// Type-only test file: checked by `tsc` (pnpm typecheck), not executed by Vitest.

declare const db: Db;

describe("ORM types", () => {
  it("infers scalar payloads", async () => {
    const users = await db.user.findMany();
    expectTypeOf(users).toEqualTypeOf<
      {
        id: string;
        email: string;
        name: string | null;
        age: number | null;
        tags: string[];
        createdAt: Date;
      }[]
    >();
  });

  it("narrows with select and nests relations", async () => {
    const u = await db.user.findUnique({
      where: { email: "a@b.c" },
      select: { email: true, posts: { select: { title: true }, take: 3 } },
    });
    expectTypeOf(u).toEqualTypeOf<{ email: string; posts: { title: string }[] } | null>();
  });

  it("adds included relations, with $edge for typed edges and null for optional to-one", async () => {
    const _post = await db.post.findFirst({
      include: { author: { include: { following: true } } },
    });
    type Author = NonNullable<NonNullable<typeof _post>["author"]>;
    expectTypeOf<Author["email"]>().toEqualTypeOf<string>();
    expectTypeOf<Author["following"][number]["$edge"]>().toEqualTypeOf<{ since: Date }>();
    expectTypeOf<NonNullable<typeof _post>["author"]>().toBeNullable();
  });

  it("types create inputs (required fields, defaults optional, nested writes)", async () => {
    const created = await db.user.create({
      data: {
        email: "x@y.z",
        posts: { create: [{ title: "Hello" }], connect: { id: "p1" } },
        following: { connect: [{ email: "b@c.d", $edge: { since: new Date() } }] },
      },
    });
    expectTypeOf(created.id).toEqualTypeOf<string>();

    // @ts-expect-error — email is required
    await db.user.create({ data: { name: "no email" } });
    // @ts-expect-error — unknown field
    await db.user.create({ data: { email: "a", nope: 1 } });
    // @ts-expect-error — wrong scalar type
    await db.user.create({ data: { email: "a", age: "old" } });
  });

  it("requires a unique key in findUnique / update / delete", async () => {
    // @ts-expect-error — name is not unique
    await db.user.findUnique({ where: { name: "x" } });
    await db.user.update({ where: { id: "1" }, data: { age: { increment: 1 }, name: null } });
    // @ts-expect-error — string fields have no increment
    await db.user.update({ where: { id: "1" }, data: { email: { increment: 1 } } });
    await db.post.update({ where: { id: "1" }, data: { author: { disconnect: true } } });
  });

  it("types where filters", async () => {
    await db.user.findMany({
      where: {
        OR: [{ email: { endsWith: "@x.io" } }, { age: { gte: 18 } }],
        tags: { has: "admin" },
        posts: { some: { published: true } },
        createdAt: { lt: new Date() },
      },
      orderBy: [{ createdAt: "desc" }],
    });
    // Strings compare lexicographically (keyset pagination on a string tie-breaker).
    await db.user.findMany({
      where: { id: { lt: "m" }, email: { gte: "a", lte: "n", in: ["a"], notIn: ["b"] } },
    });
    await db.post.findMany({ where: { title: { gt: "A" }, author: { is: { id: { lt: "x" } } } } });
    // @ts-expect-error — string bounds take strings
    await db.user.findMany({ where: { email: { lt: 3 } } });
    // @ts-expect-error — booleans have no lt
    await db.post.findMany({ where: { published: { lt: true } } });
    // @ts-expect-error — numbers have no startsWith
    await db.user.findMany({ where: { age: { startsWith: "1" } } });
    await db.user.findMany({ where: { email: { equals: "A@X.io", mode: "insensitive" } } });
    // @ts-expect-error — mode is only for strings
    await db.user.findMany({ where: { age: { equals: 1, mode: "insensitive" } } });
    // @ts-expect-error — to-one relations use is/isNot, not some
    await db.post.findMany({ where: { author: { some: {} } } });
  });

  it("types aggregate results from the requested aggregates", async () => {
    const a = await db.post.aggregate({
      where: { published: true },
      _count: true,
      _sum: { views: true },
      _avg: { views: true, score: true },
      _min: { title: true, publishedOn: true },
      _max: { views: true },
    });
    expectTypeOf(a).toEqualTypeOf<{
      _count: number;
      _sum: { views: number | null };
      _avg: { views: number | null; score: number | null };
      _min: { title: string | null; publishedOn: Date | null };
      _max: { views: number | null };
    }>();

    const c = await db.user.aggregate({
      _count: { _all: true, age: true },
      _max: { createdAt: true },
    });
    expectTypeOf(c).toEqualTypeOf<{
      _count: { _all: number; age: number };
      _max: { createdAt: Date | null };
    }>();
    const _empty = await db.user.aggregate();
    expectTypeOf<keyof typeof _empty>().toEqualTypeOf<never>();

    // @ts-expect-error — _sum only on Int / Float fields
    await db.post.aggregate({ _sum: { title: true } });
    // @ts-expect-error — _avg only on numeric fields, even next to a valid one
    await db.post.aggregate({ _avg: { views: true, title: true } });
    // @ts-expect-error — no _min on booleans
    await db.post.aggregate({ _min: { published: true } });
    // @ts-expect-error — no _max on lists
    await db.user.aggregate({ _max: { tags: true } });
    // @ts-expect-error — unknown field in _count
    await db.user.aggregate({ _count: { _all: true, nope: true } });
    // @ts-expect-error — unknown field in where
    await db.user.aggregate({ where: { nope: 1 }, _count: true });
  });

  it("types groupBy keys, aggregates, having and orderBy", async () => {
    const rows = await db.post.groupBy({
      by: ["published", "author.name"],
      where: { views: { gte: 0 } },
      _count: { _all: true },
      _avg: { views: true },
      having: { views: { _avg: { gt: 10 } }, published: true, author: { name: { not: null } } },
      orderBy: [{ _count: { id: "desc" } }, { published: "asc" }, { author: { name: "asc" } }],
      take: 10,
    });
    expectTypeOf(rows).toEqualTypeOf<
      {
        published: boolean;
        author: { name: string | null };
        _count: { _all: number };
        _avg: { views: number | null };
      }[]
    >();

    const single = await db.user.groupBy({ by: "age", _max: { createdAt: true } });
    expectTypeOf(single).toEqualTypeOf<
      { age: number | null; _max: { createdAt: Date | null } }[]
    >();

    // @ts-expect-error — unknown by field
    await db.post.groupBy({ by: ["nope"] });
    // @ts-expect-error — only to-one relations can be grouped on
    await db.user.groupBy({ by: ["posts.title"] });
    // @ts-expect-error — orderBy on a field that is not in by
    await db.post.groupBy({ by: ["published"], orderBy: { title: "asc" } });
    // @ts-expect-error — plain having filter on a field that is not in by
    await db.post.groupBy({ by: ["published"], having: { title: "x" } });
    // @ts-expect-error — no _sum on strings in having
    await db.post.groupBy({ by: ["published"], having: { title: { _sum: { gt: 1 } } } });
    await db.post.groupBy({ by: ["published"], having: { title: { _count: { gt: 1 } } } });
  });
  it("types relation counts in select / include, at any depth", async () => {
    const all = await db.user.findMany({ include: { _count: true } });
    expectTypeOf(all[0]!._count).toEqualTypeOf<{
      posts: number;
      following: number;
      followers: number;
    }>();
    expectTypeOf(all[0]!.email).toEqualTypeOf<string>();

    const some = await db.user.findUniqueOrThrow({
      where: { id: "1" },
      select: {
        email: true,
        _count: { select: { posts: { where: { published: true } }, followers: true } },
      },
    });
    expectTypeOf(some).toEqualTypeOf<{
      email: string;
      _count: { posts: number; followers: number };
    }>();

    const nested = await db.post.findFirst({
      select: {
        title: true,
        author: { select: { name: true, _count: { select: { posts: true } } } },
      },
    });
    expectTypeOf(nested).toEqualTypeOf<{
      title: string;
      author: { name: string | null; _count: { posts: number } } | null;
    } | null>();

    const created = await db.user.create({
      data: { email: "c@d.e" },
      include: { posts: { include: { author: true } }, _count: { select: { following: true } } },
    });
    expectTypeOf(created._count).toEqualTypeOf<{ following: number }>();

    const _without = await db.user.findUniqueOrThrow({
      where: { id: "1" },
      include: { _count: false },
    });
    expectTypeOf<"_count" extends keyof typeof _without ? true : false>().toEqualTypeOf<false>();

    // @ts-expect-error — to-one relations cannot be counted
    await db.post.findMany({ include: { _count: { select: { author: true } } } });
    // @ts-expect-error — the count filter is typed by the related model
    await db.user.findMany({ include: { _count: { select: { posts: { where: { title: 1 } } } } } });
  });

  it("types orderBy on relation counts", async () => {
    await db.user.findMany({ orderBy: [{ posts: { _count: "desc" } }, { email: "asc" }] });
    await db.user.findMany({ include: { posts: { orderBy: { views: "desc" } } } });
    // @ts-expect-error — only to-many relations sort by count
    await db.post.findMany({ orderBy: { author: { _count: "asc" } } });
    // @ts-expect-error — direction must be asc / desc
    await db.user.findMany({ orderBy: { posts: { _count: "up" } } });
  });
});
