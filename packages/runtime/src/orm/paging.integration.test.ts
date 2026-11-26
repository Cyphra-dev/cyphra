/**
 * Keyset cursors of `findMany`, engine rules (`withEngineRules`) and aliased relation loads against
 * a real database. Own `Pg*` labels, so it can run next to the other suites.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type Db } from "./__fixtures__/paging.gen.js";
import { withEngineRules, withRawValues } from "./client.js";
import {
  CyphraValidationError,
  ForbiddenError,
  NotFoundError,
  UnsupportedFeatureError,
} from "./errors.js";
import { hasTestDb, onFalkorDB, testConnection, testDialect } from "./__fixtures__/testDialect.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

type OrderBy = NonNullable<Parameters<Db["pgPost"]["findMany"]>[0]>["orderBy"];

describe.skipIf(!hasTestDb)("keyset cursors, engine rules and aliased loads", () => {
  let db: Db;

  const wipe = () => db.$cypher`MATCH (n) WHERE n:PgUser OR n:PgPost DETACH DELETE n`;

  beforeAll(async () => {
    db = createClient(testConnection());
    await wipe();
    const authors = ["ada", "bob", "cy"];
    for (const [i, id] of authors.entries()) {
      await db.pgUser.create({
        data: { id, name: ["Ada", "Bob", "Cy"][i]!, rank: i === 2 ? null : i },
      });
    }
    // 24 posts: views in 4 ties, scores with nulls, two createdAt values, 3 authors (and none).
    for (let i = 0; i < 24; i++) {
      const author = i % 4 === 3 ? undefined : authors[i % 3]!;
      await db.pgPost.create({
        data: {
          id: `p${String(i).padStart(2, "0")}`,
          title: `Post ${i}`,
          views: (i * 7) % 4,
          score: i % 5 === 0 ? null : (i % 3) / 2,
          createdAt: new Date(Date.UTC(2024, 0, 1 + (i % 2))),
          published: i % 2 === 0,
          ...(author ? { author: { connect: { id: author } } } : {}),
        },
      });
    }
  });

  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  /** Every id in the database's own order for `orderBy`, with the id as tiebreaker. */
  async function reference(orderBy: OrderBy): Promise<string[]> {
    const list = orderBy === undefined ? [] : [orderBy].flat();
    const rows = await db.pgPost.findMany({
      orderBy: [...list, { id: "asc" }] as OrderBy,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Walk every page forward (`after`, from the start) or backward (`before`, from the last node),
   * `take` at a time.
   */
  async function walk(orderBy: OrderBy, take: number, side: "after" | "before") {
    const ids: string[] = [];
    let cursor: string | undefined;
    if (side === "before") {
      const all = await db.pgPost.findMany({ orderBy, select: { id: true, $cursor: true } });
      ids.push(all[all.length - 1]!.id);
      cursor = all[all.length - 1]!.$cursor;
    }
    for (let pages = 0; pages < 50; pages++) {
      const page = await db.pgPost.findMany({
        orderBy,
        take,
        ...(cursor ? { cursor: { [side]: cursor } } : {}),
        select: { id: true, $cursor: true },
      });
      if (page.length === 0) break;
      if (side === "after") {
        ids.push(...page.map((r) => r.id));
        cursor = page[page.length - 1]!.$cursor;
      } else {
        ids.unshift(...page.map((r) => r.id));
        cursor = page[0]!.$cursor;
      }
    }
    return ids;
  }

  const orders: [string, OrderBy][] = [
    ["no orderBy (the id)", undefined],
    ["ties on views (desc)", { views: "desc" }],
    ["nulls ascending (score asc)", { score: "asc" }],
    ["nulls descending (score desc)", [{ score: "desc" }, { views: "asc" }]],
    ["DateTime then Int", [{ createdAt: "desc" }, { views: "desc" }]],
    ["a to-one relation's scalar, with posts without one", [{ author: { name: "asc" } }]],
  ];

  for (const [name, orderBy] of orders) {
    it(`pages forward and backward through every node once: ${name}`, async () => {
      const expected = await reference(orderBy);
      expect(expected).toHaveLength(24);
      expect(await walk(orderBy, 5, "after")).toEqual(expected);
      expect(await walk(orderBy, 4, "before")).toEqual(expected);
    });
  }

  it("orders users by a relation count, with ties", async () => {
    const all = await db.pgUser.findMany({
      orderBy: [{ posts: { _count: "desc" } }, { rank: "asc" }],
      select: { id: true, $cursor: true },
    });
    expect(all).toHaveLength(3);
    const second = await db.pgUser.findMany({
      orderBy: [{ posts: { _count: "desc" } }, { rank: "asc" }],
      cursor: { after: all[0]!.$cursor },
      take: 1,
    });
    expect(second.map((u) => u.id)).toEqual([all[1]!.id]);
  });

  it("skip applies after the cursor; findFirst takes the next node", async () => {
    const expected = await reference({ views: "asc" });
    const [first] = await db.pgPost.findMany({
      orderBy: { views: "asc" },
      take: 1,
      select: { id: true, $cursor: true },
    });
    const skipped = await db.pgPost.findMany({
      orderBy: { views: "asc" },
      cursor: { after: first!.$cursor },
      skip: 2,
      take: 3,
      select: { id: true },
    });
    expect(skipped.map((r) => r.id)).toEqual(expected.slice(3, 6));
    const next = await db.pgPost.findFirst({
      orderBy: { views: "asc" },
      cursor: { after: first!.$cursor },
    });
    expect(next?.id).toBe(expected[1]);
  });

  it("is stable when nodes are inserted before the cursor or the boundary node is deleted", async () => {
    const orderBy: OrderBy = [{ createdAt: "asc" }];
    const page1 = await db.pgPost.findMany({
      orderBy,
      take: 6,
      select: { id: true, $cursor: true },
    });
    const expected = (await reference(orderBy)).slice(6, 12);
    // A node that sorts first, and the boundary node itself deleted.
    await db.pgPost.create({
      data: { id: "a-new", title: "New", createdAt: new Date(Date.UTC(2023, 0, 1)) },
    });
    const boundary = page1[5]!;
    const removed = await db.pgPost.delete({ where: { id: boundary.id } });
    try {
      const page2 = await db.pgPost.findMany({
        orderBy,
        take: 6,
        cursor: { after: boundary.$cursor },
        select: { id: true },
      });
      expect(page2.map((r) => r.id)).toEqual(expected);
    } finally {
      await db.pgPost.delete({ where: { id: "a-new" } });
      await db.pgPost.create({
        data: { ...removed, author: undefined } as Parameters<Db["pgPost"]["create"]>[0]["data"],
      });
    }
  });

  it("rejects a cursor made for another orderBy or another model", async () => {
    const [post] = await db.pgPost.findMany({
      orderBy: { views: "asc" },
      take: 1,
      select: { $cursor: true },
    });
    await expect(
      db.pgPost.findMany({ orderBy: { views: "desc" }, cursor: { after: post!.$cursor } }),
    ).rejects.toThrow(CyphraValidationError);
    await expect(
      db.pgUser.findMany({ orderBy: { rank: "asc" }, cursor: { after: post!.$cursor } }),
    ).rejects.toThrow(/not a valid cursor/);
    await expect(db.pgPost.findMany({ cursor: { after: "bm90IGEgY3Vyc29y" } })).rejects.toThrow(
      /not a valid cursor/,
    );
  });

  describe("engine rules", () => {
    const published = { PgPost: { read: { published: true } } };

    it("hide nodes from roots, relation loads, counts, relation filters and cursors", async () => {
      const scoped = withEngineRules(db, published);
      const posts = await scoped.pgPost.findMany({ select: { id: true, published: true } });
      expect(posts).toHaveLength(12);
      expect(posts.every((p) => p.published)).toBe(true);
      expect(await scoped.pgPost.count()).toBe(12);
      expect(await db.pgPost.count()).toBe(24);

      const users = await scoped.pgUser.findMany({
        orderBy: { id: "asc" },
        select: { id: true, posts: { select: { published: true } }, _count: true },
      });
      for (const u of users) {
        expect(u.posts.every((p) => p.published)).toBe(true);
        expect(u._count.posts).toBe(u.posts.length);
      }
      const all = await db.pgUser.findMany({
        orderBy: { id: "asc" },
        select: { id: true, _count: true },
      });
      expect(users.map((u) => u._count.posts)).not.toEqual(all.map((u) => u._count.posts));

      // `some` cannot find a hidden post; `every` ignores hidden ones.
      const unpublished = await db.pgPost.findFirst({
        where: { published: false, author: { isNot: null } },
        include: { author: true },
      });
      const probe = await scoped.pgUser.findMany({
        where: { posts: { some: { id: unpublished!.id } } },
      });
      expect(probe).toEqual([]);
      const everyPublished = await scoped.pgUser.count({
        where: { posts: { every: { published: true } } },
      });
      expect(everyPublished).toBe(3);

      // Aggregates and cursors.
      const agg = await scoped.pgPost.aggregate({ _count: { _all: true } });
      expect(agg._count._all).toBe(12);
      const page = await scoped.pgPost.findMany({ take: 5, select: { id: true, $cursor: true } });
      const rest = await scoped.pgPost.findMany({ cursor: { after: page[4]!.$cursor } });
      expect(page.length + rest.length).toBe(12);
    });

    it("restrict update and delete targets (NotFound outside the rule)", async () => {
      const scoped = withEngineRules(db, {
        PgPost: { update: { published: true }, delete: false },
      });
      const hidden = await db.pgPost.findFirst({ where: { published: false } });
      await expect(
        scoped.pgPost.update({ where: { id: hidden!.id }, data: { title: "x" } }),
      ).rejects.toThrow(NotFoundError);
      const res = await scoped.pgPost.updateMany({ data: { score: 1 }, where: { views: 0 } });
      const visible = await db.pgPost.count({ where: { views: 0, published: true } });
      expect(res.count).toBe(visible);
      await expect(scoped.pgPost.delete({ where: { id: hidden!.id } })).rejects.toThrow(
        NotFoundError,
      );
      expect((await scoped.pgPost.deleteMany()).count).toBe(0);
      expect(await db.pgPost.count()).toBe(24);
    });
  });

  describe("engine rules on writes and fields", () => {
    /** Posts and edges, to compare before and after a write that must roll back. */
    const snapshot = async () =>
      JSON.stringify(
        await db.pgPost.findMany({
          orderBy: { id: "asc" },
          select: { id: true, title: true, views: true, author: { select: { id: true } } },
        }),
      );

    // FalkorDB cannot roll a write back: rules checked after it ran are refused (test below).
    it.skipIf(onFalkorDB)(
      "roll back a write whose nodes break an after rule (root, nested, batch, upsert)",
      async () => {
        const before = await snapshot();
        const scoped = withEngineRules(db, {
          PgPost: {
            after: { create: { author: { is: { id: "ada" } } }, update: { views: { lt: 100 } } },
          },
        });
        await expect(
          scoped.pgPost.create({
            data: {
              id: "rx1",
              title: "x",
              createdAt: new Date(),
              author: { connect: { id: "bob" } },
            },
          }),
        ).rejects.toThrow(ForbiddenError);
        await expect(
          scoped.pgUser.update({
            where: { id: "bob" },
            data: { posts: { create: [{ id: "rx2", title: "x", createdAt: new Date() }] } },
          }),
        ).rejects.toMatchObject({
          name: "ForbiddenError",
          model: "PgPost",
          operation: "after.create",
        });
        await expect(
          scoped.pgPost.createMany({ data: [{ id: "rx3", title: "x", createdAt: new Date() }] }),
        ).rejects.toThrow(ForbiddenError);
        await expect(
          scoped.pgPost.update({ where: { id: "p00" }, data: { views: { increment: 500 } } }),
        ).rejects.toMatchObject({ operation: "after.update" });
        await expect(
          scoped.pgPost.updateMany({ where: { views: 0 }, data: { views: 500 } }),
        ).rejects.toThrow(ForbiddenError);
        await expect(
          scoped.pgPost.upsert({
            where: { id: "p00" },
            create: { id: "p00", title: "x", createdAt: new Date() },
            update: { views: 500 },
          }),
        ).rejects.toMatchObject({ operation: "after.update" });
        expect(await snapshot()).toBe(before);

        // Within the rule: written.
        const ok = await scoped.pgPost.create({
          data: {
            id: "rx4",
            title: "x",
            createdAt: new Date(),
            author: { connect: { id: "ada" } },
          },
          select: { id: true, author: { select: { id: true } } },
        });
        expect(ok.author?.id).toBe("ada");
        await db.pgPost.delete({ where: { id: "rx4" } });
      },
    );

    it.runIf(onFalkorDB)("refuse after and disconnect rules on FalkorDB", () => {
      expect(() => withEngineRules(db, { PgPost: { after: { create: true } } })).toThrow(
        UnsupportedFeatureError,
      );
      expect(() => withEngineRules(db, { PgUser: { disconnect: { posts: true } } })).toThrow(
        UnsupportedFeatureError,
      );
    });

    it.skipIf(onFalkorDB)(
      "check create rules (also nested) and restrict connect / disconnect targets",
      async () => {
        const before = await snapshot();
        const scoped = withEngineRules(db, {
          PgPost: { create: (d) => d.title !== "forbidden" },
          PgUser: { connect: { posts: { published: true } }, disconnect: { posts: { views: 0 } } },
        });
        await expect(
          scoped.pgUser.update({
            where: { id: "ada" },
            data: { posts: { create: [{ id: "rx5", title: "forbidden", createdAt: new Date() }] } },
          }),
        ).rejects.toThrow(ForbiddenError);
        const unpublished = await db.pgPost.findFirst({ where: { published: false } });
        await expect(
          scoped.pgUser.update({
            where: { id: "ada" },
            data: { posts: { connect: [{ id: unpublished!.id }] } },
          }),
        ).rejects.toThrow(NotFoundError);
        // A disconnect outside the rule leaves the edge alone.
        const linked = await db.pgPost.findFirst({
          where: { author: { is: { id: "ada" } }, views: { gt: 0 } },
        });
        await scoped.pgUser.update({
          where: { id: "ada" },
          data: { posts: { disconnect: [{ id: linked!.id }] } },
        });
        expect(await snapshot()).toBe(before);

        // Replacing a post's author (to-one): the current author must be disconnectable.
        const guarded = withEngineRules(db, { PgPost: { disconnect: { author: { id: "cy" } } } });
        await expect(
          guarded.pgPost.update({
            where: { id: linked!.id },
            data: { author: { connect: { id: "bob" } } },
          }),
        ).rejects.toMatchObject({ name: "ForbiddenError", operation: "disconnect" });
        expect(await snapshot()).toBe(before);
      },
    );

    it("read a field ruled out as null in results, filters, ordering and aggregates", async () => {
      const scoped = withEngineRules(db, { PgPost: { fields: { score: { published: true } } } });
      const rows = await scoped.pgPost.findMany({
        orderBy: [{ score: "asc" }, { id: "asc" }],
        select: { id: true, score: true, published: true },
      });
      for (const r of rows) if (!r.published) expect(r.score).toBeNull();
      const withScore = await db.pgPost.count({ where: { published: true, score: { not: null } } });
      expect(await scoped.pgPost.count({ where: { score: { not: null } } })).toBe(withScore);
      // Nulls sort last ascending: the readable scores come first.
      expect(rows.slice(0, withScore).every((r) => r.published)).toBe(true);
      const agg = await scoped.pgPost.aggregate({ _count: { score: true } });
      expect(agg._count.score).toBe(withScore);
    });

    it("return null for a written node the read rules hide", async () => {
      const scoped = withEngineRules(db, { PgPost: { read: { published: true } } });
      const created = await scoped.pgPost.create({
        data: { id: "rx6", title: "x", createdAt: new Date(), published: false },
      });
      expect(created).toBeNull();
      expect(await db.pgPost.findUnique({ where: { id: "rx6" } })).not.toBeNull();
      await db.pgPost.delete({ where: { id: "rx6" } });
    });
  });

  it("loads one relation several times with different arguments (aliased loads)", async () => {
    const [user] = await db.pgUser.findMany({
      where: { id: "ada" },
      select: {
        id: true,
        newest: {
          $relation: "posts",
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 2,
          select: { id: true },
        },
        popular: {
          $relation: "posts",
          orderBy: [{ views: "desc" }, { id: "asc" }],
          take: 1,
          select: { id: true, views: true },
        },
        posts: { select: { id: true } },
      },
    } as never);
    const u = user as unknown as {
      newest: { id: string }[];
      popular: { id: string; views: number }[];
      posts: { id: string }[];
    };
    const own = await db.pgPost.findMany({ where: { author: { is: { id: "ada" } } } });
    expect(u.posts).toHaveLength(own.length);
    const newest = [...own].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1),
    );
    expect(u.newest.map((p) => p.id)).toEqual(newest.slice(0, 2).map((p) => p.id));
    const popular = [...own].sort((a, b) => b.views - a.views || (a.id < b.id ? -1 : 1));
    expect(u.popular).toEqual([{ id: popular[0]!.id, views: popular[0]!.views }]);
  });

  it("withRawValues: driver values for scalars, decoded ones elsewhere", async () => {
    const raw = withRawValues(db);
    const [post] = (await raw.pgPost.findMany({
      where: { id: "p00" },
      select: { views: true, createdAt: true, author: { select: { rank: true } } },
    })) as unknown as { views: unknown; createdAt: unknown; author: { rank: unknown } }[];
    // Driver values (Bolt: neo4j-driver's, HTTP: the transport's), never the decoded ones.
    expect(typeof post!.views).toBe("object");
    expect(post!.createdAt).not.toBeInstanceOf(Date);
    expect(typeof post!.author.rank).toBe("object");
    const [decoded] = await db.pgPost.findMany({ where: { id: "p00" }, select: { views: true } });
    expect(decoded!.views).toBe(0);
  });

  it.skipIf(testDialect !== "neo4j")(
    "deleteMany $relationships counts the distinct relationships removed",
    async () => {
      await db.$transaction(async (tx) => {
        await tx.pgUser.create({ data: { id: "rx", name: "Rx" } });
        await tx.pgPost.create({
          data: { id: "rx1", title: "t", createdAt: new Date(), author: { connect: { id: "rx" } } },
        });
        await tx.pgPost.create({
          data: { id: "rx2", title: "t", createdAt: new Date(), author: { connect: { id: "rx" } } },
        });
      });
      // The user and its two relationships (the posts stay).
      const res = (await db.pgUser.deleteMany({
        where: { id: "rx" },
        $relationships: true,
      } as never)) as unknown as { count: number; relationships: number };
      expect(res).toEqual({ count: 1, relationships: 2 });
      await db.pgPost.deleteMany({ where: { id: { in: ["rx1", "rx2"] } } });
    },
  );
});
