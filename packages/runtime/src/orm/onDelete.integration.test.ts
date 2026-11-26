import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Db } from "./__fixtures__/ondelete.gen.js";
import { NotFoundError, RestrictError } from "./errors.js";
import { hasTestDb, onFalkorDB, testConnection } from "./__fixtures__/testDialect.js";
import type { QueryEvent } from "../observability.js";

// Each test makes many round trips to Neo4j: the default 5 s is too tight on a busy CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hasNeo = hasTestDb;

const LABELS = [
  "OdUser",
  "OdSession",
  "OdPost",
  "OdComment",
  "OdInvoice",
  "OdRing",
  "OdPlain",
  "OdTag",
  "OdFolder",
  "OdFile",
  "OdVersion",
  "OdHold",
];

describe.skipIf(!hasNeo)("onDelete rules (Neo4j)", () => {
  let db: Db;

  beforeEach(async () => {
    db ??= createClient({
      ...testConnection(),
    });
    await db.$cypher`MATCH (n) WHERE any(l IN labels(n) WHERE l IN ${LABELS}) DETACH DELETE n`;
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function counts() {
    const [user, session, post, comment, invoice] = await Promise.all([
      db.odUser.count(),
      db.odSession.count(),
      db.odPost.count(),
      db.odComment.count(),
      db.odInvoice.count(),
    ]);
    return { user, session, post, comment, invoice };
  }

  /** A user with 2 sessions, a post with a comment thread (comment → reply → reply), a review. */
  async function seed(email: string) {
    await db.odUser.create({
      data: {
        email,
        sessions: { create: [{ token: `${email}-1` }, { token: `${email}-2` }] },
        posts: { create: { title: `${email} post` } },
      },
    });
    const post = (await db.odPost.findFirst({ where: { title: `${email} post` } }))!;
    const c1 = await db.odComment.create({
      data: { body: "c1", post: { connect: { id: post.id } } },
    });
    const c2 = await db.odComment.create({
      data: { body: "c2", parent: { connect: { id: c1.id } } },
    });
    await db.odComment.create({ data: { body: "c3", parent: { connect: { id: c2.id } } } });
    return post;
  }

  it("cascades through a chain (user → posts → comments → replies → replies)", async () => {
    await seed("a@x.io");
    await seed("b@x.io");
    expect(await counts()).toEqual({ user: 2, session: 4, post: 2, comment: 6, invoice: 0 });

    const deleted = await db.odUser.delete({
      where: { email: "a@x.io" },
      include: { posts: true },
    });
    expect(deleted.email).toBe("a@x.io");
    expect(deleted.posts).toHaveLength(1);
    expect(await counts()).toEqual({ user: 1, session: 2, post: 1, comment: 3, invoice: 0 });
    expect(await db.odSession.count({ where: { token: { startsWith: "b@x.io" } } })).toBe(2);
  });

  it("SetNull (the default) keeps the related nodes and removes the edges", async () => {
    const reviewer = await db.odUser.create({ data: { email: "r@x.io" } });
    const author = await db.odUser.create({
      data: {
        email: "w@x.io",
        posts: { create: { title: "reviewed", reviewer: { connect: { id: reviewer.id } } } },
      },
    });
    expect(author.email).toBe("w@x.io");
    await db.odUser.delete({ where: { email: "r@x.io" } });
    const post = await db.odPost.findFirst({
      where: { title: "reviewed" },
      include: { reviewer: true },
    });
    expect(post?.reviewer).toBeNull();

    // The plain path (no rules on the model): edges go, tags stay.
    await db.odPlain.create({ data: { tags: { create: [{}, {}] } } });
    expect(await db.odPlain.deleteMany()).toEqual({ count: 1 });
    expect(await db.odTag.count()).toBe(2);
  });

  it("Restrict refuses the delete before deleting anything", async () => {
    await seed("a@x.io");
    await db.odUser.update({
      where: { email: "a@x.io" },
      data: { invoices: { create: { amount: 10 } } },
    });
    const before = await counts();
    const err = await db.odUser.delete({ where: { email: "a@x.io" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestrictError);
    expect(err).toMatchObject({
      model: "OdUser",
      relation: "invoices",
      target: "OdInvoice",
      count: 1,
    });
    expect((err as Error).message).toMatch(/OdUser\.invoices \(onDelete: Restrict\)/);
    expect(await counts()).toEqual(before);

    await db.odInvoice.deleteMany();
    await db.odUser.delete({ where: { email: "a@x.io" } });
    expect(await counts()).toEqual({ user: 0, session: 0, post: 0, comment: 0, invoice: 0 });
  });

  it("Restrict applies to nodes reached by a cascade", async () => {
    const post = await seed("a@x.io");
    await db.odInvoice.create({ data: { amount: 5, post: { connect: { id: post.id } } } });
    const before = await counts();
    await expect(db.odUser.delete({ where: { email: "a@x.io" } })).rejects.toMatchObject({
      name: "RestrictError",
      model: "OdPost",
      relation: "invoice",
    });
    expect(await counts()).toEqual(before);
  });

  it("Restrict ignores nodes deleted by the same operation", async () => {
    // OdUser.manager is Restrict (IN): a user who has a manager cannot be deleted…
    const boss = await db.odUser.create({ data: { email: "boss@x.io" } });
    await db.odUser.create({ data: { email: "emp@x.io", manager: { connect: { id: boss.id } } } });
    await expect(db.odUser.delete({ where: { email: "emp@x.io" } })).rejects.toBeInstanceOf(
      RestrictError,
    );
    // …unless the manager goes in the same deleteMany.
    expect(await db.odUser.deleteMany({ where: { email: { endsWith: "@x.io" } } })).toEqual({
      count: 2,
    });
  });

  it("handles cycles", async () => {
    // a → b → c → a
    const a = await db.odRing.create({ data: { name: "a" } });
    const b = await db.odRing.create({ data: { name: "b" } });
    const c = await db.odRing.create({ data: { name: "c", next: { connect: { id: a.id } } } });
    await db.odRing.update({ where: { id: a.id }, data: { next: { connect: { id: b.id } } } });
    await db.odRing.update({ where: { id: b.id }, data: { next: { connect: { id: c.id } } } });
    const lone = await db.odRing.create({ data: { name: "lone" } });
    // A self-loop too.
    await db.odRing.update({
      where: { id: lone.id },
      data: { next: { connect: { id: lone.id } } },
    });

    await db.odRing.delete({ where: { name: "b" } });
    expect((await db.odRing.findMany()).map((r) => r.name)).toEqual(["lone"]);
    await db.odRing.delete({ where: { name: "lone" } });
    expect(await db.odRing.count()).toBe(0);

    // A comment replying to itself.
    const self = await db.odComment.create({ data: { body: "self" } });
    await db.odComment.update({
      where: { id: self.id },
      data: { parent: { connect: { id: self.id } } },
    });
    await db.odComment.delete({ where: { id: self.id } });
    expect(await db.odComment.count()).toBe(0);
  });

  it("deleteMany cascades and counts the root nodes only", async () => {
    await seed("a@x.io");
    await seed("b@x.io");
    await seed("c@x.io");
    expect(await db.odUser.deleteMany({ where: { email: { in: ["a@x.io", "b@x.io"] } } })).toEqual({
      count: 2,
    });
    expect(await counts()).toEqual({ user: 1, session: 2, post: 1, comment: 3, invoice: 0 });
    expect(await db.odUser.deleteMany({ where: { email: "none@x.io" } })).toEqual({ count: 0 });
    // Rolled back as a whole when one of them is restricted.
    await seed("d@x.io");
    await db.odUser.update({
      where: { email: "d@x.io" },
      data: { invoices: { create: { amount: 1 } } },
    });
    const before = await counts();
    await expect(db.odUser.deleteMany()).rejects.toBeInstanceOf(RestrictError);
    expect(await counts()).toEqual(before);
  });

  // FalkorDB has no multi-statement transactions.
  it.skipIf(onFalkorDB)("rolls back with the surrounding $transaction", async () => {
    await seed("a@x.io");
    await expect(
      db.$transaction(async (tx) => {
        await tx.odUser.delete({ where: { email: "a@x.io" } });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await counts()).toEqual({ user: 1, session: 2, post: 1, comment: 3, invoice: 0 });
  });

  it("two deletes racing on the same user: one deletes, the other finds nothing", async () => {
    for (let round = 0; round < 5; round++) {
      await seed("a@x.io");
      const results = await Promise.allSettled([
        db.odUser.delete({ where: { email: "a@x.io" } }),
        db.odUser.delete({ where: { email: "a@x.io" } }),
        db.odUser.deleteMany({ where: { email: "a@x.io" } }),
      ]);
      const deletes = results.slice(0, 2);
      const ok = deletes.filter((r) => r.status === "fulfilled").length;
      const many = results[2]!;
      expect(many.status).toBe("fulfilled");
      const manyCount = (many as PromiseFulfilledResult<{ count: number }>).value.count;
      // Exactly one of the three operations deleted the user.
      expect(ok + manyCount).toBe(1);
      for (const r of deletes) {
        if (r.status === "rejected") expect(r.reason).toBeInstanceOf(NotFoundError);
      }
      expect(await counts()).toEqual({ user: 0, session: 0, post: 0, comment: 0, invoice: 0 });
    }
    // Lock waits and deadlock retries (the driver backs off ~1 s) take time.
  }, 30_000);

  it("a delete racing a write that links a restricting node never leaves it dangling", async () => {
    for (let round = 0; round < 5; round++) {
      await db.odInvoice.deleteMany();
      await db.odUser.create({ data: { email: "a@x.io" } });
      const [del, link] = await Promise.allSettled([
        db.odUser.delete({ where: { email: "a@x.io" } }),
        db.odInvoice.create({ data: { amount: 1, user: { connect: { email: "a@x.io" } } } }),
      ]);
      const invoice = await db.odInvoice.findFirst({ include: { user: true } });
      if (del.status === "fulfilled") {
        // The delete went first: the invoice could not link (or was created without the user).
        expect(await db.odUser.count()).toBe(0);
        if (link.status === "fulfilled") expect(invoice?.user ?? null).toBeNull();
      } else {
        // The invoice linked first: the delete was refused.
        expect(del.reason).toBeInstanceOf(RestrictError);
        expect(link.status).toBe("fulfilled");
        expect(invoice?.user?.email).toBe("a@x.io");
        await db.odInvoice.deleteMany();
        await db.odUser.deleteMany();
      }
    }
    // Lock waits and deadlock retries (the driver backs off ~1 s) take time.
  }, 30_000);

  /** Statements `fn` runs (query events). */
  async function statements(fn: () => Promise<unknown>): Promise<string[]> {
    const seen: string[] = [];
    const off = db.$on("query", (e: QueryEvent) => seen.push(e.text));
    try {
      await fn().catch(() => undefined);
    } finally {
      off();
    }
    return seen;
  }

  /** A folder with 2 files, each with 2 versions. */
  async function seedFolder(name: string) {
    return db.odFolder.create({
      data: {
        name,
        files: {
          create: [
            { name: `${name}/a`, versions: { create: [{ n: 1 }, { n: 2 }] } },
            { name: `${name}/b`, versions: { create: [{ n: 1 }, { n: 2 }] } },
          ],
        },
      },
    });
  }

  async function folderCounts() {
    const [folder, file, version, hold] = await Promise.all([
      db.odFolder.count(),
      db.odFile.count(),
      db.odVersion.count(),
      db.odHold.count(),
    ]);
    return { folder, file, version, hold };
  }

  it("an acyclic cascade (folder → files → versions) is one statement", async () => {
    expect(await statements(() => seedFolder("x"))).toHaveLength(1);
    await seedFolder("y");
    expect(await folderCounts()).toEqual({ folder: 2, file: 4, version: 8, hold: 0 });
    let deleted: { name: string; files: unknown[] } | undefined;
    const texts = await statements(async () => {
      deleted = await db.odFolder.delete({ where: { name: "x" }, include: { files: true } });
    });
    expect(texts).toHaveLength(1);
    expect(deleted?.name).toBe("x");
    expect(deleted?.files).toHaveLength(2);
    expect(await folderCounts()).toEqual({ folder: 1, file: 2, version: 4, hold: 0 });

    await seedFolder("z");
    let count: { count: number } | undefined;
    expect(
      await statements(async () => {
        count = await db.odFolder.deleteMany();
      }),
    ).toHaveLength(1);
    expect(count).toEqual({ count: 2 });
    expect(await folderCounts()).toEqual({ folder: 0, file: 0, version: 0, hold: 0 });
    await expect(db.odFolder.delete({ where: { name: "x" } })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("an acyclic cascade checks Restrict in the same statement and deletes nothing", async () => {
    await seedFolder("x");
    await db.odHold.create({ data: { reason: "legal", file: { connect: { name: "x/b" } } } });
    const err = await db.odFolder.delete({ where: { name: "x" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestrictError);
    expect(err).toMatchObject({ model: "OdFile", relation: "holds", target: "OdHold", count: 1 });
    await expect(db.odFolder.deleteMany()).rejects.toBeInstanceOf(RestrictError);
    expect(await folderCounts()).toEqual({ folder: 1, file: 2, version: 4, hold: 1 });
    // Deleting the file itself is restricted too; deleting the hold lifts it.
    await expect(db.odFile.delete({ where: { name: "x/b" } })).rejects.toBeInstanceOf(
      RestrictError,
    );
    await db.odHold.deleteMany();
    expect(await db.odFolder.deleteMany()).toEqual({ count: 1 });
    expect(await folderCounts()).toEqual({ folder: 0, file: 0, version: 0, hold: 0 });
  });

  it("an acyclic cascade: racing deletes delete once, a racing hold is never left dangling", async () => {
    for (let round = 0; round < 5; round++) {
      await seedFolder("x");
      const results = await Promise.allSettled([
        db.odFolder.delete({ where: { name: "x" } }),
        db.odFolder.delete({ where: { name: "x" } }),
        db.odFolder.deleteMany({ where: { name: "x" } }),
      ]);
      const ok = results.slice(0, 2).filter((r) => r.status === "fulfilled").length;
      const many = results[2]!;
      expect(many.status).toBe("fulfilled");
      expect(ok + (many as PromiseFulfilledResult<{ count: number }>).value.count).toBe(1);
      for (const r of results.slice(0, 2)) {
        if (r.status === "rejected") expect(r.reason).toBeInstanceOf(NotFoundError);
      }
      expect(await folderCounts()).toEqual({ folder: 0, file: 0, version: 0, hold: 0 });

      await seedFolder("x");
      const [del, hold] = await Promise.allSettled([
        db.odFolder.delete({ where: { name: "x" } }),
        db.odHold.create({ data: { reason: "r", file: { connect: { name: "x/a" } } } }),
      ]);
      if (del.status === "fulfilled") {
        expect(await db.odFile.count()).toBe(0);
        expect(hold.status).toBe("rejected");
      } else {
        expect(del.reason).toBeInstanceOf(RestrictError);
        expect(hold.status).toBe("fulfilled");
        expect((await db.odHold.findFirst({ include: { file: true } }))?.file?.name).toBe("x/a");
      }
      await db.odHold.deleteMany();
      await db.odFolder.deleteMany();
    }
    // Lock waits and deadlock retries (the driver backs off ~1 s) take time.
  }, 60_000);

  it("deleteMany with select returns the deleted nodes as they were (every delete path)", async () => {
    // No rules: one DETACH DELETE.
    await db.odPlain.create({ data: { tags: { create: [{}, {}] } } });
    const plain = await db.odPlain.deleteMany({
      select: { id: true, tags: { select: { id: true } } },
    });
    expect(plain.count).toBe(1);
    expect(plain.nodes).toHaveLength(1);
    expect(plain.nodes[0]!.tags).toHaveLength(2);

    // An acyclic cascade: one statement, the projections read before the delete.
    await seedFolder("x");
    await seedFolder("y");
    let tree: { count: number; nodes: { name: string; files: { name: string }[] }[] } | undefined;
    const texts = await statements(async () => {
      tree = await db.odFolder.deleteMany({
        where: { name: { in: ["x", "y", "none"] } },
        select: { name: true, files: { select: { name: true }, orderBy: { name: "asc" } } },
      });
    });
    expect(texts).toHaveLength(1);
    expect(tree!.count).toBe(2);
    expect(tree!.nodes.map((f) => [f.name, f.files.map((x) => x.name)]).sort()).toEqual([
      ["x", ["x/a", "x/b"]],
      ["y", ["y/a", "y/b"]],
    ]);
    expect(await folderCounts()).toEqual({ folder: 0, file: 0, version: 0, hold: 0 });
    expect(await db.odFolder.deleteMany({ select: { name: true } })).toEqual({
      count: 0,
      nodes: [],
    });

    // A cascade with a cycle: level by level, the nodes read when they are locked.
    await seed("a@x.io");
    await seed("b@x.io");
    const cyclic = await db.odUser.deleteMany({
      select: { email: true, _count: { select: { sessions: true } } },
    });
    expect(cyclic.count).toBe(2);
    expect(cyclic.nodes.map((u) => [u.email, u._count.sessions]).sort()).toEqual([
      ["a@x.io", 2],
      ["b@x.io", 2],
    ]);
    expect(await counts()).toEqual({ user: 0, session: 0, post: 0, comment: 0, invoice: 0 });
  });

  it("a cascade with a cycle locks level by level: one statement per level", async () => {
    await seed("a@x.io");
    // Find + lock + read, then the levels (sessions and posts, comments, replies, replies of
    // replies, none left), then the Restrict checks with the delete.
    const texts = await statements(() => db.odUser.delete({ where: { email: "a@x.io" } }));
    expect(texts).toHaveLength(7);
    expect(await counts()).toEqual({ user: 0, session: 0, post: 0, comment: 0, invoice: 0 });
  });
});
