/**
 * Compile-time tests for client extensions (`db.$extends`), checked by `tsc --noEmit` /
 * `pnpm typecheck`. The bodies never run against a database.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { Db } from "./__fixtures__/blog.gen.js";
import type { Db as InterfacesDb } from "./__fixtures__/interfaces.gen.js";
import type { Db as VectorDb } from "./__fixtures__/vector.gen.js";
import { getExtensionContext } from "./extensions.js";
import type { OrmClient, OrmTransactionClient } from "./client.js";
import type { BatchResult, Path } from "./types.js";

declare const db: Db;
declare const idb: InterfacesDb;
declare const vdb: VectorDb;

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  age: number | null;
  tags: string[];
  createdAt: Date;
};
type XUser = {
  id: string;
  email: string;
  name: string | null;
  age: number | null;
  tags: string[];
  createdAt: Date;
  fullName: string;
  isAdult: boolean;
};

const xdb = db.$extends({
  name: "blog",
  result: {
    user: {
      fullName: {
        needs: { name: true, email: true },
        compute(u) {
          expectTypeOf(u).toEqualTypeOf<{ name: string | null; email: string }>();
          return u.name ?? u.email;
        },
      },
      isAdult: { needs: { age: true }, compute: (u) => (u.age ?? 0) >= 18 },
    },
    post: { slug: { needs: { title: true }, compute: (p) => p.title.toLowerCase() } },
  },
  model: {
    user: {
      findByEmail(email: string) {
        return this.findUnique({ where: { email } });
      },
      async fullNameOf(email: string) {
        return (await this.findByEmail(email))?.fullName;
      },
    },
  },
  client: {
    $health() {
      return this.user.count();
    },
    region: "eu" as const,
  },
});

describe("computed fields", () => {
  it("adds computed fields to results without select", async () => {
    const users = await xdb.user.findMany();
    expectTypeOf(users).toEqualTypeOf<XUser[]>();
    const p = await xdb.post.findUniqueOrThrow({ where: { id: "p" } });
    expectTypeOf(p.slug).toEqualTypeOf<string>();
  });

  it("makes computed fields selectable and respects select", async () => {
    const u = await xdb.user.findFirst({ select: { id: true, fullName: true } });
    expectTypeOf(u).toEqualTypeOf<{ id: string; fullName: string } | null>();
    const v = await xdb.user.findFirst({ select: { fullName: false, email: true } });
    expectTypeOf(v).toEqualTypeOf<{ email: string } | null>();
  });

  it("applies on included, selected and nested relations", async () => {
    const _p = await xdb.post.findFirst({ include: { author: { include: { posts: true } } } });
    type Author = NonNullable<NonNullable<typeof _p>["author"]>;
    expectTypeOf<Author["fullName"]>().toEqualTypeOf<string>();
    expectTypeOf<Author["posts"][number]["slug"]>().toEqualTypeOf<string>();
    const s = await xdb.user.findMany({
      select: { posts: { select: { slug: true } }, following: { select: { fullName: true } } },
    });
    expectTypeOf(s).toEqualTypeOf<
      { posts: { slug: string }[]; following: { fullName: string; $edge: { since: Date } }[] }[]
    >();
  });

  it("applies on write results, traversals, paths and vector search", async () => {
    const c = await xdb.user.create({ data: { email: "a@example.com" } });
    expectTypeOf(c.fullName).toEqualTypeOf<string>();
    const d = await xdb.user.delete({ where: { id: "u" }, select: { isAdult: true } });
    expectTypeOf(d).toEqualTypeOf<{ isAdult: boolean }>();
    const t = await xdb.user.traverse({ from: { id: "u" }, via: "following", depth: { max: 2 } });
    expectTypeOf(t[0]!.fullName).toEqualTypeOf<string>();
    const sp = await xdb.user.shortestPath({
      from: { id: "a" },
      to: { id: "b" },
      via: "following",
      maxDepth: 3,
    });
    expectTypeOf(sp!.nodes[0]!.fullName).toEqualTypeOf<string>();
    const v = vdb.$extends({
      result: {
        vecChunk: { short: { needs: { text: true }, compute: (c) => c.text.slice(0, 10) } },
      },
    });
    const hits = await v.vecChunk.findSimilar({ field: "embedding", vector: [1, 0, 0], k: 3 });
    expectTypeOf(hits[0]!.short).toEqualTypeOf<string>();
    expectTypeOf(hits[0]!.$score).toEqualTypeOf<number>();
  });

  it("keeps computed fields out of filters, ordering, writes and aggregates", async () => {
    // @ts-expect-error — computed fields cannot be filtered on
    await xdb.user.findMany({ where: { fullName: "x" } });
    // @ts-expect-error — nor sorted by
    await xdb.user.findMany({ orderBy: { fullName: "asc" } });
    // @ts-expect-error — nor written
    await xdb.user.create({ data: { email: "a", fullName: "x" } });
    // @ts-expect-error — nor aggregated
    await xdb.user.aggregate({ _max: { fullName: true } });
    const counts = await xdb.user.count();
    expectTypeOf(counts).toEqualTypeOf<number>();
  });

  it("composes, can shadow a scalar, and leaves the original client unchanged", async () => {
    const ydb = xdb
      .$extends({
        result: { user: { name: { needs: { name: true }, compute: (u) => u.name ?? "" } } },
      })
      .$extends({ result: { $allModels: { kind: { compute: () => "node" as const } } } });
    const u = await ydb.user.findUniqueOrThrow({ where: { id: "u" } });
    expectTypeOf(u.name).toEqualTypeOf<string>();
    expectTypeOf(u.fullName).toEqualTypeOf<string>();
    expectTypeOf(u.kind).toEqualTypeOf<"node">();
    expectTypeOf((await ydb.post.findMany())[0]!.kind).toEqualTypeOf<"node">();
    const raw = await db.user.findMany();
    expectTypeOf(raw).toEqualTypeOf<UserRow[]>();
    // @ts-expect-error — the original client has no model methods
    db.user.findByEmail("a");
  });

  it("types interface results with the interface's and implementations' fields", async () => {
    const x = idb.$extends({
      result: {
        person: { initial: { needs: { name: true }, compute: (p) => p.name.charAt(0) } },
        employee: { yearly: { needs: { salary: true }, compute: (e) => e.salary * 12 } },
      },
    });
    const people = await x.person.findMany();
    const p = people[0]!;
    expectTypeOf(p.initial).toEqualTypeOf<string>();
    if (p.__typename === "Employee") expectTypeOf(p.yearly).toEqualTypeOf<number>();
    const sel = await x.person.findMany({ select: { initial: true } });
    expectTypeOf(sel[0]!.initial).toEqualTypeOf<string>();
    expectTypeOf(sel[0]!.__typename).toEqualTypeOf<"Employee" | "Customer">();
  });

  it("types compute's row from needs and rejects bad definitions", () => {
    db.$extends({
      result: {
        user: {
          x: {
            needs: { email: true },
            compute: (u) => {
              // @ts-expect-error — name is not in needs
              void u.name;
              return u.email;
            },
          },
        },
      },
    });
    // @ts-expect-error — unknown model
    db.$extends({ result: { nope: { a: { compute: () => 1 } } } });
    // @ts-expect-error — needs must be scalar fields of the model
    db.$extends({ result: { user: { a: { needs: { nope: true }, compute: () => 1 } } } });
  });
});

describe("query hooks", () => {
  it("types args, query and result per model and operation", () => {
    db.$extends({
      query: {
        user: {
          async create({ args, query, model, operation }) {
            expectTypeOf(model).toEqualTypeOf<"User">();
            expectTypeOf(operation).toEqualTypeOf<"create">();
            expectTypeOf(args.data.email).toEqualTypeOf<string>();
            const created = await query({ ...args, data: { ...args.data, name: "x" } });
            expectTypeOf(created.email).toEqualTypeOf<string>();
            return created;
          },
          count({ args, query }) {
            expectTypeOf(query).returns.toEqualTypeOf<Promise<number>>();
            return query(args);
          },
          deleteMany: async () => ({ count: 0 }) satisfies BatchResult,
          delete({ args, client }) {
            expectTypeOf(client.$cypher).toBeFunction();
            return client.user.update({ where: args.where, data: { name: null } });
          },
          async $allOperations({ operation, args, query }) {
            if (operation === "findMany")
              expectTypeOf(args.take).toEqualTypeOf<number | undefined>();
            return query(args);
          },
        },
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            expectTypeOf(model).toEqualTypeOf<"User" | "Post">();
            expectTypeOf(operation).toBeString();
            return query(args);
          },
          findMany: ({ args, query }) => query({ ...args, take: 10 }),
        },
      },
    });
    // @ts-expect-error — must return the operation's result
    db.$extends({ query: { user: { findFirst: async () => "nope" } } });
    // @ts-expect-error — unknown operation
    db.$extends({ query: { user: { explode: async () => null } } });
    // @ts-expect-error — interfaces have no create
    idb.$extends({ query: { person: { create: async ({ args, query }) => query(args) } } });
  });

  it("types shortestPath hooks with paths", () => {
    db.$extends({
      query: {
        user: {
          async shortestPath({ args, query }) {
            const p = await query(args);
            expectTypeOf(p).toEqualTypeOf<Path<UserRow> | null>();
            return p;
          },
        },
      },
    });
  });
});

describe("model methods and client members", () => {
  it("types custom model methods and this", async () => {
    const u = await xdb.user.findByEmail("a@example.com");
    expectTypeOf(u).toEqualTypeOf<XUser | null>();
    expectTypeOf(await xdb.user.fullNameOf("a")).toEqualTypeOf<string | undefined>();
    db.$extends({
      model: {
        user: {
          me() {
            expectTypeOf(this.$name).toEqualTypeOf<"User">();
            expectTypeOf(this.$parent.post.findMany).toBeFunction();
            const ctx = getExtensionContext(this);
            expectTypeOf(ctx.$name).toEqualTypeOf<"User">();
            // @ts-expect-error — not a method of the delegate
            this.nope();
            return this.count();
          },
        },
        $allModels: {
          async exists(where: object) {
            expectTypeOf(this.$name).toEqualTypeOf<"User" | "Post">();
            return (await this.count({ where })) > 0;
          },
        },
      },
    });
    const ext = db.$extends({
      model: {
        $allModels: {
          async exists(where: object) {
            return (await this.count({ where })) > 0;
          },
        },
      },
    });
    expectTypeOf(ext.post.exists).returns.toEqualTypeOf<Promise<boolean>>();
    expectTypeOf(ext.user.exists).returns.toEqualTypeOf<Promise<boolean>>();
    // @ts-expect-error — unknown model
    db.$extends({ model: { nope: { a() {} } } });
  });

  it("types client members", async () => {
    expectTypeOf(await xdb.$health()).toEqualTypeOf<number>();
    expectTypeOf(xdb.region).toEqualTypeOf<"eu">();
    const z = xdb.$extends({
      client: {
        $twice() {
          return this.$health().then((n) => n * 2);
        },
      },
    });
    expectTypeOf(z.$twice).returns.toEqualTypeOf<Promise<number>>();
    expectTypeOf(z.$health).returns.toEqualTypeOf<Promise<number>>();
  });

  it("accepts a reusable extension function", () => {
    const withPing = (c: Db) => c.$extends({ client: { $ping: () => "pong" as const } });
    const y = db.$extends(withPing);
    expectTypeOf(y.$ping()).toEqualTypeOf<"pong">();
  });
});

describe("$transaction on an extended client", () => {
  it("hands an extended transaction client", async () => {
    await xdb.$transaction(async (tx) => {
      const u = await tx.user.findUniqueOrThrow({ where: { id: "u" } });
      expectTypeOf(u.fullName).toEqualTypeOf<string>();
      const v = await tx.user.findByEmail("a");
      expectTypeOf(v?.fullName).toEqualTypeOf<string | undefined>();
      // @ts-expect-error — client members are not on the transaction client
      void tx.$health;
      // @ts-expect-error — no nested transactions
      void tx.$transaction;
    });
  });

  it("is assignable to the plain client types", () => {
    expectTypeOf(xdb).toMatchTypeOf<
      Pick<OrmClient<Record<string, never>>, "$cypher" | "$schema">
    >();
    type Tx = Parameters<Parameters<typeof xdb.$transaction>[0]>[0];
    expectTypeOf<Tx>().toHaveProperty("$cypher");
    expectTypeOf<OrmTransactionClient<Record<string, never>>>().toHaveProperty("$cypher");
  });
});
