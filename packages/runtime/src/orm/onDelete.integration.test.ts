import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Db } from "./__fixtures__/ondelete.gen.js";
import { NotFoundError, RestrictError } from "./errors.js";

// Each test makes many round trips to Neo4j: the default 5 s is too tight on a busy CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hasNeo = Boolean(
  process.env.NEO4J_TEST_URI && process.env.NEO4J_TEST_USER && process.env.NEO4J_TEST_PASSWORD,
);

const LABELS = [
  "OdUser",
  "OdSession",
  "OdPost",
  "OdComment",
  "OdInvoice",
  "OdRing",
  "OdPlain",
  "OdTag",
];

describe.skipIf(!hasNeo)("onDelete rules (Neo4j)", () => {
  let db: Db;

  beforeEach(async () => {
    db ??= createClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
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

  it("rolls back with the surrounding $transaction", async () => {
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
});
