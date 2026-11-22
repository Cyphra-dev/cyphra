import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Db } from "./__fixtures__/unions.gen.js";
import { CyphraValidationError, NotFoundError } from "./errors.js";
import { hasTestDb, testConnection } from "./__fixtures__/testDialect.js";

// Each test makes many round trips: the default 5 s is too tight on a busy CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const LABELS = ["Article", "Author", "Staff", "Member", "Note", "Board", "Pin"];

describe.skipIf(!hasTestDb)("unions of unrelated models", () => {
  let db: Db;

  beforeEach(async () => {
    db ??= createClient({ ...testConnection() });
    await db.$cypher`MATCH (n) WHERE any(l IN labels(n) WHERE l IN ${LABELS}) DETACH DELETE n`;
  });

  afterAll(async () => {
    if (!db) return;
    await db.$cypher`MATCH (n) WHERE any(l IN labels(n) WHERE l IN ${LABELS}) DETACH DELETE n`;
    await db.$disconnect();
  });

  /** A board showing an article (with notes), an author and a staff member. */
  async function seed() {
    await db.staff.create({ data: { email: "s@x.io", role: "admin" } });
    const board = await db.board.create({
      data: {
        name: "front",
        items: {
          create: [
            { Article: { title: "Graphs", notes: { create: [{ text: "n1" }, { text: "n2" }] } } },
            { Author: { name: "Ada", rating: 5 } },
          ],
          connect: { Staff: { email: "s@x.io" } },
        },
      },
    });
    // Not on the board, and not a member of the union.
    await db.note.create({ data: { text: "loose" } });
    await db.author.create({ data: { name: "Bob" } });
    return board;
  }

  it("writes no label for the union and reads every member, typed by __typename", async () => {
    await seed();
    const labels = await db.$cypher<{ l: string[] }>`
      MATCH (n) WHERE n:SearchHit RETURN labels(n) AS l`;
    expect(labels).toEqual([]);
    const hits = await db.searchHit.findMany({ orderBy: [{ __typename: "asc" }] });
    expect(hits.map((h) => h.__typename)).toEqual(["Article", "Author", "Author", "Staff"]);
    const article = hits.find((h) => h.__typename === "Article")!;
    expect(article).toEqual({ __typename: "Article", id: expect.any(String), title: "Graphs" });
    expect(hits.find((h) => h.__typename === "Staff")).toEqual({
      __typename: "Staff",
      id: expect.any(String),
      email: "s@x.io",
      role: "admin",
    });
    expect(await db.searchHit.count()).toBe(4);
  });

  it("filters with __typename and $on, selects per member", async () => {
    await seed();
    expect(await db.searchHit.count({ where: { __typename: { in: ["Author", "Staff"] } } })).toBe(
      3,
    );
    const found = await db.searchHit.findMany({
      where: { $on: { Article: { title: { contains: "raph" } }, Author: { rating: { gte: 4 } } } },
      select: { $on: { Article: { title: true, notes: { orderBy: { text: "asc" } } } } },
      orderBy: { __typename: "asc" },
    });
    expect(found).toEqual([
      {
        __typename: "Article",
        title: "Graphs",
        notes: [
          { id: expect.any(String), text: "n1" },
          { id: expect.any(String), text: "n2" },
        ],
      },
      { __typename: "Author" },
    ]);
    expect(await db.searchHit.count({ where: { $on: {} } })).toBe(0);
    const first = await db.searchHit.findFirst({ where: { __typename: "Staff" } });
    expect(first?.__typename).toBe("Staff");
  });

  it("loads, filters and counts relations to a union", async () => {
    await seed();
    const boards = await db.board.findMany({
      where: { items: { some: { $on: { Author: { name: "Ada" } } } } },
      include: {
        items: { where: { __typename: { not: "Staff" } }, orderBy: { __typename: "desc" } },
        _count: true,
      },
    });
    expect(boards).toHaveLength(1);
    expect(boards[0]!._count).toEqual({ items: 3 });
    expect(boards[0]!.items.map((i) => i.__typename)).toEqual(["Author", "Article"]);
    expect(
      await db.board.count({ where: { items: { none: { $on: { Author: { name: "Bob" } } } } } }),
    ).toBe(1);
  });

  it("connects, disconnects and sets by member, rejecting a missing member", async () => {
    const board = await seed();
    await db.board.update({
      where: { id: board.id },
      data: {
        items: {
          connect: [{ Author: { name: "Bob" } }],
          disconnect: { Staff: { email: "s@x.io" } },
        },
      },
    });
    const names = async () =>
      (
        await db.board.findUniqueOrThrow({
          where: { id: board.id },
          select: { items: { select: { $on: { Author: { name: true } } } } },
        })
      ).items
        .map((i) => ("name" in i ? `${i.__typename}:${i.name}` : i.__typename))
        .sort();
    expect(await names()).toEqual(["Article", "Author:Ada", "Author:Bob"]);
    await db.board.update({
      where: { id: board.id },
      data: { items: { set: [{ Author: { name: "Bob" } }, { Staff: { email: "s@x.io" } }] } },
    });
    expect(await names()).toEqual(["Author:Bob", "Staff"]);
    await expect(
      db.board.update({
        where: { id: board.id },
        data: { items: { connect: { Author: { name: "Nobody" } } } },
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      db.board.update({
        where: { id: board.id },
        // @ts-expect-error the member must be named
        data: { items: { connect: { name: "Bob" } } },
      }),
    ).rejects.toThrow(CyphraValidationError);
  });

  it("keeps a to-one relation to a union, and its inverse, to one edge", async () => {
    await seed();
    const article = await db.article.findFirst();
    const pin = await db.pin.create({
      data: { label: "p1", subject: { connect: { Article: { id: article!.id } } } },
      include: { subject: true },
    });
    expect(pin.subject).toEqual({ __typename: "Article", id: article!.id, title: "Graphs" });
    // Pinning another member replaces the edge.
    const moved = await db.pin.update({
      where: { id: pin.id },
      data: { subject: { connect: { Author: { name: "Bob" } } } },
      include: { subject: true },
    });
    expect(moved.subject?.__typename).toBe("Author");
    // A second pin taking the article: Article.pin is to-one, so the first pin's edge goes.
    await db.pin.update({
      where: { id: pin.id },
      data: { subject: { connect: { Article: { id: article!.id } } } },
    });
    await db.pin.create({
      data: { label: "p2", subject: { connect: { Article: { id: article!.id } } } },
    });
    const pins = await db.pin.findMany({ include: { subject: true }, orderBy: { label: "asc" } });
    expect(pins.map((p) => [p.label, p.subject?.__typename ?? null])).toEqual([
      ["p1", null],
      ["p2", "Article"],
    ]);
    const a = await db.article.findUniqueOrThrow({
      where: { id: article!.id },
      include: { pin: true },
    });
    expect(a.pin?.label).toBe("p2");
  });

  it("cascades a delete into a union with each member's own rules", async () => {
    const board = await seed();
    await db.board.delete({ where: { id: board.id } });
    // Article, Ada and the staff member went with the board, the article's notes with it.
    expect((await db.searchHit.findMany()).map((h) => h.__typename)).toEqual(["Author"]);
    expect((await db.note.findMany()).map((n) => n.text)).toEqual(["loose"]);
  });

  it("traverses into a union", async () => {
    const board = await seed();
    const reached = await db.board.traverse({
      from: { id: board.id },
      via: [{ rel: "items", where: { __typename: "Article" } }],
    });
    expect(reached.map((r) => r.__typename)).toEqual(["Article"]);
  });

  it("checks the rules of the member a nested create names", async () => {
    await expect(
      db.board.create({
        data: { name: "b", items: { create: { Article: { title: "x".repeat(201) } } } },
      }),
    ).rejects.toThrow(CyphraValidationError);
    expect(await db.board.count()).toBe(0);
  });
});
