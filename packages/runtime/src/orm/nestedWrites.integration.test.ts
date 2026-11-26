/**
 * Nested `update` / `delete` / `upsert` / `connectOrCreate` and `_count` filters in `where`
 * against a real database, with and without engine rules. Own `Nx*` labels, so it can run next to
 * the other suites.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Db } from "./__fixtures__/nestedWrites.gen.js";
import { withEngineRules } from "./client.js";
import {
  CyphraValidationError,
  ForbiddenError,
  NotFoundError,
  RestrictError,
  UnsupportedFeatureError,
} from "./errors.js";
import { hasTestDb, onFalkorDB, testConnection } from "./__fixtures__/testDialect.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const LABELS = ["NxUser", "NxProfile", "NxPost", "NxTag", "NxComment", "NxLock"];

describe.skipIf(!hasTestDb)("nested update / delete / upsert / connectOrCreate", () => {
  let db: Db;

  const wipe = () =>
    db.$cypher`MATCH (n) WHERE any(l IN labels(n) WHERE l IN ${LABELS}) DETACH DELETE n`;

  /** Every node and edge of the suite, to compare before and after a write that must roll back. */
  const snapshot = async () =>
    JSON.stringify(
      await db.$cypher`MATCH (n) WHERE any(l IN labels(n) WHERE l IN ${LABELS})
        OPTIONAL MATCH (n)-[r]->(m)
        WITH n, m, r ORDER BY coalesce(n.id, n.name), type(r), coalesce(m.id, m.name)
        RETURN labels(n)[0] AS label, properties(n) AS props,
               collect([type(r), coalesce(m.id, m.name), r.weight]) AS edges
        ORDER BY label, coalesce(props.id, props.name)`,
    );

  beforeEach(async () => {
    db ??= createClient(testConnection());
    await wipe();
    await db.nxUser.create({
      data: {
        id: "ada",
        email: "ada@x.io",
        name: "Ada",
        profile: { create: { id: "pr-ada", bio: "math" } },
        posts: {
          create: [
            {
              id: "p1",
              title: "First",
              views: 1,
              published: true,
              tags: { create: { name: "a" } },
            },
            {
              id: "p2",
              title: "Second",
              comments: {
                create: [
                  { id: "c1", body: "hi" },
                  { id: "c2", body: "yo" },
                ],
              },
            },
            { id: "p3", title: "Third", locks: { create: { id: "l1" } } },
          ],
        },
      },
    });
    await db.nxUser.create({
      data: { id: "bob", email: "bob@x.io", posts: { create: { id: "p4", title: "Bob's" } } },
    });
  });

  afterAll(async () => {
    if (db) {
      await wipe();
      await db.$disconnect();
    }
  });

  it("updates a linked node by its unique key, with its own nested writes", async () => {
    const ada = await db.nxUser.update({
      where: { id: "ada" },
      data: {
        name: "Ada L",
        posts: {
          update: [
            {
              where: { id: "p1" },
              data: {
                title: "First!",
                views: { increment: 2 },
                tags: {
                  connectOrCreate: [
                    { where: { name: "a" }, create: { name: "a" } },
                    { where: { name: "b" }, create: { name: "b" } },
                  ],
                },
              },
            },
            { where: { id: "p2" }, data: { comments: { delete: { id: "c1" } } } },
          ],
        },
      },
      select: {
        name: true,
        posts: {
          orderBy: { id: "asc" },
          select: {
            id: true,
            title: true,
            views: true,
            tags: { orderBy: { name: "asc" }, select: { name: true } },
            _count: { select: { comments: true } },
          },
        },
      },
    });
    expect(ada.name).toBe("Ada L");
    expect(ada.posts[0]).toEqual({
      id: "p1",
      title: "First!",
      views: 3,
      tags: [{ name: "a" }, { name: "b" }],
      _count: { comments: 0 },
    });
    expect(ada.posts[1]!._count.comments).toBe(1);
    expect(await db.nxTag.count()).toBe(2);
    expect(await db.nxComment.count()).toBe(1);
  });

  it.skipIf(onFalkorDB)(
    "fails the whole write when a nested update or delete target is not linked",
    async () => {
      const before = await snapshot();
      // p4 is Bob's: not one of Ada's posts.
      await expect(
        db.nxUser.update({
          where: { id: "ada" },
          data: {
            name: "Changed",
            posts: { update: { where: { id: "p4" }, data: { title: "Stolen" } } },
          },
        }),
      ).rejects.toThrow(NotFoundError);
      await expect(
        db.nxUser.update({
          where: { id: "ada" },
          data: { name: "Changed", posts: { delete: [{ id: "p1" }, { id: "p4" }] } },
        }),
      ).rejects.toThrow(/NxUser\.posts\.delete: no NxPost linked/);
      await expect(
        db.nxUser.update({ where: { id: "bob" }, data: { profile: { update: { bio: "x" } } } }),
      ).rejects.toThrow(NotFoundError);
      expect(await snapshot()).toBe(before);
    },
  );

  it.runIf(onFalkorDB)(
    "throws NotFoundError for a nested target that is not linked (FalkorDB: other writes stay)",
    async () => {
      await expect(
        db.nxUser.update({
          where: { id: "ada" },
          data: { posts: { update: { where: { id: "p4" }, data: { title: "Stolen" } } } },
        }),
      ).rejects.toThrow(NotFoundError);
      expect((await db.nxPost.findUnique({ where: { id: "p4" } }))?.title).toBe("Bob's");
    },
  );

  it("checks validation rules and @max on nested update data, with their paths", async () => {
    const err = await db.nxUser
      .update({
        where: { id: "ada" },
        data: { posts: { update: { where: { id: "p1" }, data: { title: "x" } } } },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CyphraValidationError);
    expect((err as CyphraValidationError).issues.map((i) => i.path.join("."))).toEqual([
      "data.posts.update.data.title",
    ]);
    const before = await snapshot();
    const guard = await db.nxUser
      .update({
        where: { id: "ada" },
        data: { posts: { update: [{ where: { id: "p1" }, data: { views: { increment: 500 } } }] } },
      })
      .catch((e: unknown) => e);
    expect(guard).toBeInstanceOf(CyphraValidationError);
    expect((guard as CyphraValidationError).issues[0]).toMatchObject({
      path: ["data", "posts", "update", 0, "data", "views"],
      rule: "max",
    });
    expect(await snapshot()).toBe(before);
  });

  it("updates, deletes and upserts a to-one relation", async () => {
    const updated = await db.nxPost.update({
      where: { id: "p1" },
      data: { author: { update: { name: "Ada (author)" } } },
      select: { author: { select: { name: true } } },
    });
    expect(updated.author?.name).toBe("Ada (author)");

    // Upsert: Ada has a profile (update), Bob has none (create and link).
    await db.nxUser.update({
      where: { id: "ada" },
      data: { profile: { upsert: { create: { bio: "new" }, update: { bio: "updated" } } } },
    });
    const bob = await db.nxUser.update({
      where: { id: "bob" },
      data: {
        profile: { upsert: { create: { id: "pr-bob", bio: "new" }, update: { bio: "updated" } } },
      },
      select: { profile: { select: { id: true, bio: true } } },
    });
    expect(bob.profile).toEqual({ id: "pr-bob", bio: "new" });
    expect((await db.nxProfile.findUnique({ where: { id: "pr-ada" } }))?.bio).toBe("updated");
    expect(await db.nxProfile.count()).toBe(2);

    const gone = await db.nxUser.update({
      where: { id: "bob" },
      data: { profile: { delete: true } },
      include: { profile: true },
    });
    expect(gone.profile).toBeNull();
    expect(await db.nxProfile.findUnique({ where: { id: "pr-bob" } })).toBeNull();
  });

  it("upserts linked nodes on a to-many relation, with a typed edge", async () => {
    await db.nxUser.update({
      where: { id: "ada" },
      data: {
        posts: {
          upsert: [
            { where: { id: "p1" }, create: { id: "p1", title: "Never" }, update: { title: "Upd" } },
            {
              where: { id: "p9" },
              create: { id: "p9", title: "Brand new" },
              update: { title: "Never" },
            },
          ],
        },
        follows: {
          upsert: {
            where: { id: "cy" },
            create: { id: "cy", email: "cy@x.io" },
            update: { name: "Never" },
            $edge: { weight: 5 },
          },
        },
      },
    });
    const ada = await db.nxUser.findUnique({
      where: { id: "ada" },
      select: {
        posts: {
          where: { id: { in: ["p1", "p9"] } },
          orderBy: { id: "asc" },
          select: { id: true, title: true },
        },
        follows: { select: { id: true, name: true } },
      },
    });
    expect(ada?.posts).toEqual([
      { id: "p1", title: "Upd" },
      { id: "p9", title: "Brand new" },
    ]);
    expect(ada?.follows).toEqual([{ id: "cy", name: null, $edge: { weight: 5 } }]);
    const [edge] = await db.$cypher<{
      w: number;
    }>`MATCH (:NxUser {id: "ada"})-[r:NX_FOLLOWS]->(:NxUser {id: "cy"}) RETURN r.weight AS w`;
    expect(edge?.w).toBe(5);

    // Upserting again updates the node now linked (and keeps one edge).
    await db.nxUser.update({
      where: { id: "ada" },
      data: {
        follows: {
          upsert: {
            where: { id: "cy" },
            create: { id: "cy", email: "cy@x.io" },
            update: { name: "Cy" },
          },
        },
      },
    });
    expect((await db.nxUser.findUnique({ where: { id: "cy" } }))?.name).toBe("Cy");
    expect(await db.nxUser.count({ where: { id: "cy" } })).toBe(1);
  });

  it("connects an existing node or creates it (connectOrCreate), on create and update", async () => {
    const post = await db.nxPost.create({
      data: {
        id: "p5",
        title: "Tagged",
        tags: {
          connectOrCreate: [
            { where: { name: "a" }, create: { name: "a" } },
            { where: { name: "z" }, create: { name: "z" } },
          ],
        },
        author: {
          connectOrCreate: {
            where: { email: "bob@x.io" },
            create: { id: "never", email: "bob@x.io" },
          },
        },
      },
      select: {
        tags: { orderBy: { name: "asc" }, select: { name: true } },
        author: { select: { id: true } },
      },
    });
    expect(post.tags).toEqual([{ name: "a" }, { name: "z" }]);
    expect(post.author?.id).toBe("bob");
    expect(await db.nxTag.count()).toBe(2);

    // On a to-one relation of an existing node, connectOrCreate replaces the edge.
    const moved = await db.nxPost.update({
      where: { id: "p5" },
      data: {
        author: {
          connectOrCreate: {
            where: { email: "dan@x.io" },
            create: { id: "dan", email: "dan@x.io" },
          },
        },
      },
      select: { author: { select: { id: true } } },
    });
    expect(moved.author?.id).toBe("dan");
    expect(await db.nxPost.count({ where: { id: "p5", author: { is: { id: "bob" } } } })).toBe(0);

    // A typed edge: $edge on the new edge, or on the existing one.
    await db.nxUser.update({
      where: { id: "ada" },
      data: {
        follows: {
          connectOrCreate: {
            where: { id: "bob" },
            create: { id: "bob", email: "b" },
            $edge: { weight: 7 },
          },
        },
      },
    });
    const [edge] = await db.$cypher<{
      w: number;
    }>`MATCH (:NxUser {id: "ada"})-[r:NX_FOLLOWS]->(:NxUser {id: "bob"}) RETURN r.weight AS w`;
    expect(edge?.w).toBe(7);
  });

  it("applies onDelete rules to nested deletes", async () => {
    if (onFalkorDB) {
      // NxPost has a Restrict rule, which would refuse the delete after the statement's other
      // writes ran: refused before anything runs.
      await expect(
        db.nxUser.update({ where: { id: "ada" }, data: { posts: { delete: { id: "p2" } } } }),
      ).rejects.toThrow(UnsupportedFeatureError);
      return;
    }
    await db.nxUser.update({ where: { id: "ada" }, data: { posts: { delete: { id: "p2" } } } });
    expect(await db.nxPost.findUnique({ where: { id: "p2" } })).toBeNull();
    // Cascade: p2's comments went with it.
    expect(await db.nxComment.count()).toBe(0);

    const before = await snapshot();
    await expect(
      db.nxUser.update({
        where: { id: "ada" },
        data: { name: "x", posts: { delete: { id: "p3" } } },
      }),
    ).rejects.toThrow(RestrictError);
    await expect(
      db.nxUser.update({ where: { id: "ada" }, data: { posts: { delete: { id: "p3" } } } }),
    ).rejects.toMatchObject({ model: "NxPost", relation: "locks", count: 1 });
    expect(await snapshot()).toBe(before);
    await db.nxLock.deleteMany();
    await db.nxUser.update({ where: { id: "ada" }, data: { posts: { delete: { id: "p3" } } } });
    expect(await db.nxPost.findUnique({ where: { id: "p3" } })).toBeNull();
  });

  it("runs nested writes in the update branch of an upsert", async () => {
    await db.nxUser.upsert({
      where: { id: "ada" },
      create: { id: "ada", email: "ada@x.io" },
      update: {
        posts: {
          update: [
            { where: { id: "p1" }, data: { title: "Via upsert" } },
            { where: { id: "p2" }, data: { comments: { delete: { id: "c2" } } } },
          ],
        },
      },
    });
    expect((await db.nxPost.findUnique({ where: { id: "p1" } }))?.title).toBe("Via upsert");
    expect(await db.nxComment.findUnique({ where: { id: "c2" } })).toBeNull();
  });

  it("rejects malformed nested writes before anything runs", async () => {
    const reject = (data: Record<string, unknown>, model: "nxUser" | "nxPost" = "nxUser") =>
      expect(
        (db[model].update as (a: unknown) => Promise<unknown>)({
          where: { id: model === "nxUser" ? "ada" : "p1" },
          data,
        }),
      ).rejects.toThrow(CyphraValidationError);
    await reject({ posts: { update: { title: "x" } } });
    await reject({ posts: { update: { where: { title: "First" }, data: {} } } });
    await reject({ posts: { upsert: { where: { id: "p1" }, update: {} } } });
    await reject({ posts: { connectOrCreate: { create: { id: "p", title: "tt" } } } });
    await reject({ author: { delete: { id: "ada" } } }, "nxPost");
    await reject({ author: { update: { name: "x" }, connect: { id: "bob" } } }, "nxPost");
    await reject(
      { author: { upsert: { create: { id: "x", email: "x" }, update: {} }, disconnect: true } },
      "nxPost",
    );
    await expect(
      db.nxUser.create({
        data: {
          id: "u",
          email: "u",
          posts: { update: { where: { id: "p1" }, data: {} } },
        } as never,
      }),
    ).rejects.toThrow(/only on update/);
  });

  describe("_count filters in where", () => {
    it("filters on the number of related nodes", async () => {
      const ids = async (where: Parameters<Db["nxUser"]["findMany"]>[0]) =>
        (await db.nxUser.findMany({ ...where, orderBy: { id: "asc" }, select: { id: true } })).map(
          (u) => u.id,
        );
      expect(await ids({ where: { _count: { posts: 3 } } })).toEqual(["ada"]);
      expect(await ids({ where: { _count: { posts: { gte: 1 } } } })).toEqual(["ada", "bob"]);
      expect(
        await ids({ where: { _count: { posts: { gte: 1, where: { published: true } } } } }),
      ).toEqual(["ada"]);
      expect(await ids({ where: { _count: { posts: { equals: 1 }, follows: 0 } } })).toEqual([
        "bob",
      ]);
      expect(await ids({ where: { _count: { posts: { not: 3 } } } })).toEqual(["bob"]);
      expect(await ids({ where: { _count: { posts: { in: [0, 1] } } } })).toEqual(["bob"]);
      expect(await ids({ where: { NOT: { _count: { posts: { lt: 2 } } } } })).toEqual(["ada"]);
      // Inside a relation filter, and on the related model.
      expect(
        await ids({ where: { posts: { some: { _count: { comments: { gte: 2 } } } } } }),
      ).toEqual(["ada"]);
      expect(await db.nxPost.count({ where: { _count: { comments: 0, tags: 0 } } })).toBe(2);
      await expect(
        db.nxUser.findMany({ where: { _count: { profile: 1 } } as never }),
      ).rejects.toThrow(/to-one relation/);
    });
  });

  describe("engine rules", () => {
    it("restrict nested update and delete targets, and count only readable nodes", async () => {
      const scoped = withEngineRules(db, {
        NxPost: { read: { id: { not: "p4" } }, update: { published: true } },
      });
      // p2 is not published: outside the update rule.
      await expect(
        scoped.nxUser.update({
          where: { id: "ada" },
          data: { posts: { update: { where: { id: "p2" }, data: { title: "No" } } } },
        }),
      ).rejects.toThrow(NotFoundError);
      await scoped.nxUser.update({
        where: { id: "ada" },
        data: { posts: { update: { where: { id: "p1" }, data: { title: "Yes" } } } },
      });
      expect((await db.nxPost.findUnique({ where: { id: "p1" } }))?.title).toBe("Yes");
      // c1 says "hi": outside the delete rule.
      const comments = withEngineRules(db, { NxComment: { delete: { body: "yo" } } });
      await expect(
        comments.nxPost.update({
          where: { id: "p2" },
          data: { comments: { delete: { id: "c1" } } },
        }),
      ).rejects.toThrow(NotFoundError);
      await comments.nxPost.update({
        where: { id: "p2" },
        data: { comments: { delete: { id: "c2" } } },
      });
      expect(await db.nxComment.count()).toBe(1);
      // p4 cannot be read: Bob has no readable post.
      expect(await scoped.nxUser.count({ where: { _count: { posts: { gte: 1 } } } })).toBe(1);
      expect(await db.nxUser.count({ where: { _count: { posts: { gte: 1 } } } })).toBe(2);
    });

    it("check create rules on upsert and connectOrCreate", async () => {
      const scoped = withEngineRules(db, { NxTag: { create: (d) => d.name !== "forbidden" } });
      // Checked before anything runs, even when the node exists (it may be created).
      await expect(
        scoped.nxPost.update({
          where: { id: "p1" },
          data: {
            tags: { connectOrCreate: { where: { name: "a" }, create: { name: "forbidden" } } },
          },
        }),
      ).rejects.toThrow(ForbiddenError);
      await expect(
        scoped.nxPost.update({
          where: { id: "p1" },
          data: {
            tags: { upsert: { where: { name: "a" }, create: { name: "forbidden" }, update: {} } },
          },
        }),
      ).rejects.toMatchObject({ name: "ForbiddenError", model: "NxTag", operation: "create" });
      await scoped.nxPost.update({
        where: { id: "p2" },
        data: { tags: { connectOrCreate: { where: { name: "ok" }, create: { name: "ok" } } } },
      });
      expect(await db.nxTag.count({ where: { name: "ok" } })).toBe(1);
    });

    it("refuse an upsert or connectOrCreate on a node the rules show but do not let it write", async () => {
      const before = await snapshot();
      const scoped = withEngineRules(db, {
        NxPost: { update: { published: false } },
        NxUser: { connect: { follows: { id: { not: "bob" } } } },
      });
      // p1 is linked and readable, but published: not updatable. Nothing is created instead.
      await expect(
        scoped.nxUser.update({
          where: { id: "ada" },
          data: {
            posts: {
              upsert: {
                where: { id: "p1" },
                create: { id: "p1", title: "Dup" },
                update: { title: "No" },
              },
            },
          },
        }),
      ).rejects.toMatchObject({ name: "ForbiddenError", model: "NxPost", operation: "update" });
      await expect(
        scoped.nxUser.update({
          where: { id: "ada" },
          data: {
            follows: {
              connectOrCreate: { where: { id: "bob" }, create: { id: "bob", email: "dup" } },
            },
          },
        }),
      ).rejects.toMatchObject({
        name: "ForbiddenError",
        operation: "connect",
        relation: "follows",
      });
      if (!onFalkorDB) expect(await snapshot()).toBe(before);
    });

    // FalkorDB refuses after rules (no rollback).
    it.skipIf(onFalkorDB)("check after rules on nodes nested writes update or create", async () => {
      const before = await snapshot();
      const scoped = withEngineRules(db, {
        NxPost: { after: { update: { views: { lt: 10 } } } },
        NxTag: { after: { create: { name: { startsWith: "t-" } } } },
      });
      await expect(
        scoped.nxUser.update({
          where: { id: "ada" },
          data: { posts: { update: { where: { id: "p1" }, data: { views: 50 } } } },
        }),
      ).rejects.toMatchObject({
        name: "ForbiddenError",
        model: "NxPost",
        operation: "after.update",
      });
      await expect(
        scoped.nxPost.update({
          where: { id: "p1" },
          data: { tags: { connectOrCreate: { where: { name: "bad" }, create: { name: "bad" } } } },
        }),
      ).rejects.toMatchObject({
        name: "ForbiddenError",
        model: "NxTag",
        operation: "after.create",
      });
      await expect(
        scoped.nxUser.update({
          where: { id: "ada" },
          data: {
            posts: {
              upsert: {
                where: { id: "p1" },
                create: { id: "p1", title: "x1" },
                update: { views: 40 },
              },
            },
          },
        }),
      ).rejects.toMatchObject({ operation: "after.update" });
      expect(await snapshot()).toBe(before);
      // Within the rules: written (an existing tag is connected, not checked as created).
      await scoped.nxPost.update({
        where: { id: "p1" },
        data: {
          views: 5,
          tags: {
            connectOrCreate: [
              { where: { name: "a" }, create: { name: "a" } },
              { where: { name: "t-1" }, create: { name: "t-1" } },
            ],
          },
        },
      });
      expect(await db.nxTag.count()).toBe(2);
    });
  });
});
