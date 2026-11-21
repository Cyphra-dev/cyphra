/**
 * Compile-time tests for the ORM's inferred types (checked by `tsc --noEmit` / `pnpm typecheck`).
 * The runtime body never executes against a database.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { CyphraTypeMap, Db } from "./__fixtures__/blog.gen.js";
import type { Db as VectorDb } from "./__fixtures__/vector.gen.js";
import type { Db as SearchDb } from "./__fixtures__/search.gen.js";
import { TyRole, type Db as TypesDb } from "./__fixtures__/types.gen.js";
import type { JsonValue } from "../index.js";
import type { ModelPath, Path, PathEdge, SelfRelations, ShortestPathResult } from "./types.js";

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

  it("types traverse results, args and paths", async () => {
    type UserScalars = {
      id: string;
      email: string;
      name: string | null;
      age: number | null;
      tags: string[];
      createdAt: Date;
    };

    const reached = await db.user.traverse({
      from: { id: "u1" },
      via: "following",
      depth: { max: 3 },
      where: { age: { gte: 18 } },
      edgeWhere: { since: { gte: new Date("2024-01-01") } },
      orderBy: { email: "asc" },
      take: 10,
    });
    expectTypeOf(reached).toEqualTypeOf<UserScalars[]>();

    const picked = await db.user.traverse({
      from: { email: "a@b.c" },
      via: ["following", "followers"],
      direction: "both",
      depth: { min: 2, max: 2 },
      distinct: false,
      select: { email: true, _count: { select: { posts: true } } },
    });
    expectTypeOf(picked).toEqualTypeOf<{ email: string; _count: { posts: number } }[]>();

    const _withPaths = await db.user.traverse({
      from: { id: "u1" },
      via: "following",
      depth: { max: 2 },
      include: { posts: true },
      returnPaths: true,
    });
    type Row = (typeof _withPaths)[number];
    expectTypeOf<Row["node"]["posts"][number]["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Row["path"]["nodes"]>().toEqualTypeOf<UserScalars[]>();
    expectTypeOf<Row["path"]["edges"][number]>().toEqualTypeOf<{
      type: string;
      direction: "out" | "in";
      properties: { since: Date };
    }>();
    expectTypeOf<Row["path"]>().toEqualTypeOf<ModelPath<CyphraTypeMap, "User", "following">>();

    const noPaths = await db.user.traverse({
      from: {},
      via: "followers",
      depth: { max: 1 },
      returnPaths: false,
    });
    expectTypeOf(noPaths).toEqualTypeOf<UserScalars[]>();

    // @ts-expect-error — depth.max is required
    await db.user.traverse({ from: { id: "u1" }, via: "following", depth: { min: 1 } });
    // @ts-expect-error — depth is required
    await db.user.traverse({ from: { id: "u1" }, via: "following" });
    // @ts-expect-error — unknown relation
    await db.user.traverse({ from: { id: "u1" }, via: "friends", depth: { max: 2 } });
    // @ts-expect-error — posts leads to Post, not back to User
    await db.user.traverse({ from: { id: "u1" }, via: "posts", depth: { max: 2 } });
    // @ts-expect-error — Post has no relation back to Post
    await db.post.traverse({ from: { id: "p1" }, via: "author", depth: { max: 2 } });
    await db.user.traverse({
      from: { id: "u1" },
      via: "following",
      depth: { max: 2 },
      // @ts-expect-error — edge filters are typed by the relationship model
      edgeWhere: { since: "yesterday" },
    });
    await db.user.traverse({
      from: { id: "u1" },
      via: "following",
      depth: { max: 2 },
      // @ts-expect-error — unknown edge property
      edgeWhere: { weight: 1 },
    });
    // @ts-expect-error — unknown direction
    await db.user.traverse({ from: {}, via: "following", direction: "up", depth: { max: 2 } });
    // @ts-expect-error — where is typed by the model
    await db.user.traverse({ from: {}, via: "following", depth: { max: 2 }, where: { age: "x" } });
  });

  it("types shortest paths", async () => {
    const path = await db.user.shortestPath({
      from: { id: "u1" },
      to: { email: "b@x.io" },
      via: "following",
      maxDepth: 4,
      where: { age: { gte: 18 } },
      edgeWhere: { since: { gte: new Date("2024-01-01") } },
    });
    expectTypeOf(path).toEqualTypeOf<ModelPath<CyphraTypeMap, "User", "following"> | null>();
    expectTypeOf(path!.edges[0]!.properties.since).toEqualTypeOf<Date>();

    const _picked = await db.user.allShortestPaths({
      from: { id: "u1" },
      to: { id: "u2" },
      via: ["following", "followers"],
      direction: "both",
      maxDepth: 3,
      take: 5,
      select: { email: true, _count: { select: { posts: true } } },
    });
    expectTypeOf<(typeof _picked)[number]["nodes"]>().toEqualTypeOf<
      { email: string; _count: { posts: number } }[]
    >();
    expectTypeOf<(typeof _picked)[number]["edges"][number]["properties"]>().toEqualTypeOf<{
      since: Date;
    }>();

    const _included = await db.user.shortestPath({
      from: { id: "u1" },
      to: { id: "u2" },
      via: "following",
      maxDepth: 2,
      include: { posts: true },
    });
    expectTypeOf<
      NonNullable<typeof _included>["nodes"][number]["posts"][number]["title"]
    >().toEqualTypeOf<string>();
    expectTypeOf<NonNullable<typeof _included>>().toMatchTypeOf<
      ShortestPathResult<CyphraTypeMap, "User", "following", { email: string }>
    >();

    // @ts-expect-error — maxDepth is required
    await db.user.shortestPath({ from: { id: "u1" }, to: { id: "u2" }, via: "following" });
    // @ts-expect-error — to is required
    await db.user.shortestPath({ from: { id: "u1" }, via: "following", maxDepth: 2 });
    // @ts-expect-error — posts leads to Post, not back to User
    await db.user.shortestPath({ from: {}, to: {}, via: "posts", maxDepth: 2 });
    // @ts-expect-error — Post has no relation back to Post
    await db.post.allShortestPaths({ from: {}, to: {}, via: "author", maxDepth: 2 });
    // @ts-expect-error — take is for allShortestPaths
    await db.user.shortestPath({ from: {}, to: {}, via: "following", maxDepth: 2, take: 1 });
    await db.user.shortestPath({
      from: {},
      to: {},
      via: "following",
      maxDepth: 2,
      // @ts-expect-error — edge filters are typed by the relationship model
      edgeWhere: { since: "yesterday" },
    });
    await db.user.shortestPath({
      from: {},
      to: {},
      via: "following",
      maxDepth: 2,
      // @ts-expect-error — where is typed by the model
      where: { age: "x" },
    });
    await db.user.shortestPath({
      from: {},
      to: {},
      via: "following",
      maxDepth: 2,
      // @ts-expect-error — depth is a traverse option
      depth: { max: 2 },
    });
  });

  it("types paths generically (for traversals and shortest paths)", () => {
    expectTypeOf<Path["edges"][number]>().toEqualTypeOf<PathEdge>();
    expectTypeOf<
      ModelPath<CyphraTypeMap, "User", "following" | "followers">["edges"][number]["properties"]
    >().toEqualTypeOf<{ since: Date }>();
    expectTypeOf<SelfRelations<CyphraTypeMap, "User">>().toEqualTypeOf<"following" | "followers">();
    expectTypeOf<SelfRelations<CyphraTypeMap, "Post">>().toEqualTypeOf<never>();
  });
});

declare const vdb: VectorDb;

describe("ORM vector search types", () => {
  it("types findSimilar results with $score and honours select / include", async () => {
    const hits = await vdb.vecChunk.findSimilar({ field: "embedding", vector: [1, 0, 0], k: 3 });
    expectTypeOf(hits).toEqualTypeOf<
      {
        id: string;
        text: string;
        position: number;
        embedding: number[] | null;
        sketch: number[] | null;
        raw: number[] | null;
        $score: number;
      }[]
    >();

    const selected = await vdb.vecChunk.findSimilar({
      field: "sketch",
      vector: [0, 0],
      k: 1,
      where: { doc: { is: { lang: "fr" } }, embedding: { not: null } },
      minScore: 0.5,
      candidates: 50,
      maxCandidates: 1000,
      select: { text: true, doc: { select: { title: true } } },
    });
    expectTypeOf(selected).toEqualTypeOf<
      { text: string; doc: { title: string } | null; $score: number }[]
    >();

    const _included = await vdb.vecChunk.findSimilar({
      field: "embedding",
      vector: [1, 0, 0],
      k: 1,
      exact: true,
      include: { doc: { include: { chunks: true } } },
    });
    type Doc = NonNullable<(typeof _included)[number]["doc"]>;
    expectTypeOf<Doc["chunks"][number]["embedding"]>().toEqualTypeOf<number[] | null>();
  });

  it("restricts findSimilar to models and fields with a vector index", async () => {
    // @ts-expect-error — raw is a Vector without @vectorIndex
    await vdb.vecChunk.findSimilar({ field: "raw", vector: [1, 0, 0, 0], k: 1 });
    // @ts-expect-error — text is not a vector
    await vdb.vecChunk.findSimilar({ field: "text", vector: [1], k: 1 });
    // @ts-expect-error — k is required
    await vdb.vecChunk.findSimilar({ field: "embedding", vector: [1, 0, 0] });
    // @ts-expect-error — VecDoc has no vector field
    await vdb.vecDoc.findSimilar({ field: "embedding", vector: [1, 0, 0], k: 1 });
    // @ts-expect-error — nor do the blog models
    await db.user.findSimilar({ field: "tags", vector: [1], k: 1 });
  });

  it("types vector fields as number[] and only filters them on null", async () => {
    await vdb.vecChunk.create({
      data: { id: "c", text: "t", position: 0, embedding: [0.1, 0.2, 0.3] },
    });
    await vdb.vecChunk.update({ where: { id: "c" }, data: { embedding: null } });
    await vdb.vecChunk.findMany({ where: { embedding: null, sketch: { equals: null } } });
    // @ts-expect-error — vectors are not compared element-wise
    await vdb.vecChunk.findMany({ where: { embedding: { has: 1 } } });
    // @ts-expect-error — vectors cannot be sorted
    await vdb.vecChunk.findMany({ orderBy: { embedding: "asc" } });
    // @ts-expect-error — a vector is an array of numbers
    await vdb.vecChunk.create({ data: { id: "c", text: "t", position: 0, embedding: ["x"] } });
  });
});

declare const sdb: SearchDb;

describe("ORM full-text search types", () => {
  it("types search results with $score and honours select / include", async () => {
    const hits = await sdb.ftPost.search({ index: "ftPostSearch", query: "graph" });
    expectTypeOf(hits).toEqualTypeOf<
      {
        id: string;
        title: string;
        body: string | null;
        tags: string[];
        published: boolean;
        $score: number;
      }[]
    >();

    const selected = await sdb.ftPost.search({
      index: "ftPostTags",
      query: "neo4j",
      mode: "terms",
      where: { published: true, author: { is: { country: "FR" } } },
      minScore: 0.1,
      skip: 0,
      take: 10,
      select: { title: true, author: { select: { name: true } } },
    });
    expectTypeOf(selected).toEqualTypeOf<
      { title: string; author: { name: string } | null; $score: number }[]
    >();

    const _included = await sdb.ftPost.search({
      index: "ftPostTitleEnglish",
      query: "graphs",
      mode: "phrase",
      include: { author: { include: { posts: true } } },
    });
    type Author = NonNullable<(typeof _included)[number]["author"]>;
    expectTypeOf<Author["posts"][number]["tags"]>().toEqualTypeOf<string[]>();
  });

  it("restricts search to models with @@fulltext and to their index names", async () => {
    // @ts-expect-error — not an index of FtPost
    await sdb.ftPost.search({ index: "postSearch", query: "x" });
    // @ts-expect-error — query is required
    await sdb.ftPost.search({ index: "ftPostSearch" });
    // @ts-expect-error — unknown mode
    await sdb.ftPost.search({ index: "ftPostSearch", query: "x", mode: "regex" });
    // @ts-expect-error — FtAuthor has no full-text index
    await sdb.ftAuthor.search({ index: "ftPostSearch", query: "x" });
    // @ts-expect-error — nor do the blog models
    await db.post.search({ index: "x", query: "x" });
  });

  it("works on the transaction client", async () => {
    const out = await sdb.$transaction((tx) =>
      tx.ftPost.search({ index: "ftPostSearch", query: "x", select: { id: true } }),
    );
    expectTypeOf(out).toEqualTypeOf<{ id: string; $score: number }[]>();
  });
});

declare const tdb: TypesDb;

describe("ORM enum / Json / BigInt types", () => {
  it("types enum fields as the union, Json as JsonValue and BigInt as bigint", async () => {
    const a = await tdb.tyAccount.findUniqueOrThrow({ where: { id: "a" } });
    expectTypeOf(a.role).toEqualTypeOf<"ADMIN" | "EDITOR" | "VIEWER">();
    expectTypeOf(a.roles).toEqualTypeOf<("ADMIN" | "EDITOR" | "VIEWER")[]>();
    expectTypeOf(a.level).toEqualTypeOf<"LOW" | "HIGH" | null>();
    expectTypeOf(a.settings).toEqualTypeOf<JsonValue | null>();
    expectTypeOf(a.prefs).toEqualTypeOf<JsonValue>();
    expectTypeOf(a.balance).toEqualTypeOf<bigint>();
    expectTypeOf(a.external).toEqualTypeOf<bigint | null>();
    expectTypeOf(a.ids).toEqualTypeOf<bigint[]>();
    expectTypeOf(TyRole.ADMIN).toEqualTypeOf<"ADMIN">();

    const withEdges = await tdb.tyAccount.findMany({ include: { friends: true } });
    expectTypeOf(withEdges[0]!.friends[0]!.$edge.since).toEqualTypeOf<bigint | null>();
    expectTypeOf(withEdges[0]!.friends[0]!.$edge.level).toEqualTypeOf<"LOW" | "HIGH">();
  });

  it("accepts enum values, any JSON and bigints on write", async () => {
    await tdb.tyAccount.create({
      data: {
        id: "a",
        role: TyRole.ADMIN,
        roles: ["EDITOR", "VIEWER"],
        settings: { nested: [1, "two", null, { ok: true }] },
        balance: 2n ** 63n - 1n,
        ids: [1n, -2n],
        friends: { create: { id: "b", $edge: { level: "HIGH", meta: [1, 2], since: 5n } } },
      },
    });
    await tdb.tyAccount.createMany({ data: [{ id: "c", role: "EDITOR", settings: "text" }] });
    await tdb.tyAccount.update({
      where: { id: "a" },
      data: { balance: { increment: 10n }, settings: { replaced: true }, level: null },
    });
    await tdb.tyAccount.upsert({
      where: { id: "a" },
      create: { id: "a", role: "VIEWER" },
      update: { role: "EDITOR" },
    });
    // @ts-expect-error — not a TyRole value
    await tdb.tyAccount.create({ data: { id: "x", role: "OWNER" } });
    // @ts-expect-error — enum lists hold enum values
    await tdb.tyAccount.create({ data: { id: "x", roles: ["OWNER"] } });
    // @ts-expect-error — BigInt fields take a bigint, not a number
    await tdb.tyAccount.create({ data: { id: "x", balance: 1 } });
    // @ts-expect-error — increments of a BigInt are bigints
    await tdb.tyAccount.update({ where: { id: "a" }, data: { balance: { increment: 1 } } });
    // @ts-expect-error — a Date is not a JSON value
    await tdb.tyAccount.create({ data: { id: "x", settings: new Date() } });
  });

  it("filters enums by value, Json by equality only, BigInt by range", async () => {
    await tdb.tyAccount.findMany({
      where: {
        role: "ADMIN",
        level: { in: ["LOW"], not: null },
        roles: { has: "EDITOR", hasSome: ["ADMIN"] },
        settings: { equals: { a: 1 } },
        prefs: { not: null },
        balance: { gt: 0n, lte: 2n ** 62n, in: [1n, 2n], notIn: [3n] },
        external: null,
        friends: { some: { role: { notIn: ["VIEWER"] } } },
      },
      orderBy: [{ balance: "desc" }, { role: "asc" }],
    });
    await tdb.tyAccount.findMany({ where: { settings: null, role: { equals: TyRole.EDITOR } } });
    // @ts-expect-error — not a TyRole value
    await tdb.tyAccount.findMany({ where: { role: "OWNER" } });
    // @ts-expect-error — enums have no string operators
    await tdb.tyAccount.findMany({ where: { role: { contains: "AD" } } });
    // @ts-expect-error — enums have no range operators
    await tdb.tyAccount.findMany({ where: { role: { gt: "ADMIN" } } });
    // @ts-expect-error — Json filters take { equals } / { not } (no bare value)
    await tdb.tyAccount.findMany({ where: { settings: "x" } });
    // @ts-expect-error — no deep Json queries
    await tdb.tyAccount.findMany({ where: { settings: { path: ["a"] } } });
    // @ts-expect-error — Json fields cannot be sorted
    await tdb.tyAccount.findMany({ orderBy: { settings: "asc" } });
    // @ts-expect-error — BigInt filters take bigints
    await tdb.tyAccount.findMany({ where: { balance: { gt: 1 } } });
  });

  it("aggregates BigInt fields: _sum is a bigint, _avg a number", async () => {
    const agg = await tdb.tyAccount.aggregate({
      _sum: { balance: true, score: true },
      _avg: { balance: true },
      _min: { balance: true, role: true },
      _max: { external: true },
    });
    expectTypeOf(agg).toEqualTypeOf<{
      _sum: { balance: bigint | null; score: number | null };
      _avg: { balance: number | null };
      _min: { balance: bigint | null; role: "ADMIN" | "EDITOR" | "VIEWER" | null };
      _max: { external: bigint | null };
    }>();
    const groups = await tdb.tyAccount.groupBy({
      by: "role",
      _sum: { balance: true },
      having: { balance: { _sum: { gt: 10n } } },
    });
    expectTypeOf(groups).toEqualTypeOf<
      { role: "ADMIN" | "EDITOR" | "VIEWER"; _sum: { balance: bigint | null } }[]
    >();
    // @ts-expect-error — Json fields are not aggregated
    await tdb.tyAccount.aggregate({ _max: { settings: true } });
    // @ts-expect-error — nor summed
    await tdb.tyAccount.aggregate({ _sum: { role: true } });
  });
});
