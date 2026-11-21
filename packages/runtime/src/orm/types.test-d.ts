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
});
