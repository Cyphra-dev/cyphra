import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Db } from "./__fixtures__/labels.gen.js";
import { CyphraValidationError } from "./errors.js";
import { hasTestDb, testConnection } from "./__fixtures__/testDialect.js";

// Each test makes several round trips: the default 5 s is too tight on a busy CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hasNeo = hasTestDb;

const LABELS = ["Content", "Article", "Page", "Tag", "Author"];

describe.skipIf(!hasNeo)("dynamic labels (@@labels)", () => {
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

  const labelsOf = async (id: string) => {
    const rows = await db.$cypher<{ labels: string[] }>`
      MATCH (n) WHERE n.id = ${id} OR n.name = ${id} RETURN labels(n) AS labels`;
    return [...(rows[0]?.labels ?? [])].sort();
  };

  it("creates nodes with dynamic labels, nested and in bulk", async () => {
    const a = await db.article.create({
      data: { title: "A", $labels: ["Featured"] },
      select: { id: true, $labels: true },
    });
    expect(a.$labels).toEqual(["Featured"]);
    expect(await labelsOf(a.id)).toEqual(["Article", "Content", "Featured"]);

    const author = await db.author.create({
      data: {
        name: "U",
        articles: {
          create: [
            { title: "B", $labels: ["Pinned"] },
            { title: "C" },
            {
              title: "D",
              $labels: ["Archived"],
              tags: { create: { name: "t", $labels: ["Hidden"] } },
            },
          ],
        },
      },
      include: { articles: { include: { $labels: true }, orderBy: { title: "asc" } } },
    });
    expect(author.articles.map((x) => [x.title, x.$labels])).toEqual([
      ["B", ["Pinned"]],
      ["C", []],
      ["D", ["Archived"]],
    ]);
    expect(await labelsOf("t")).toEqual(["Hidden", "Tag"]);

    const res = await db.page.createMany({
      data: [
        { title: "P1", path: "/1" },
        { title: "P2", path: "/2", $labels: ["Archived"] },
        { title: "P3", path: "/3", $labels: ["Archived"] },
      ],
    });
    expect(res).toEqual({ count: 3 });
    expect(await db.page.count({ where: { $labels: { has: "Archived" } } })).toBe(2);
  });

  it("createMany with select returns the nodes in data order across label groups", async () => {
    const res = await db.article.createMany({
      data: [
        { title: "a" },
        { title: "b", $labels: ["Featured"] },
        { title: "c" },
        { title: "d", $labels: ["Featured"] },
      ],
      select: { title: true, $labels: true },
    });
    expect(res).toEqual({
      count: 4,
      nodes: [
        { title: "a", $labels: [] },
        { title: "b", $labels: ["Featured"] },
        { title: "c", $labels: [] },
        { title: "d", $labels: ["Featured"] },
      ],
    });
  });

  it("updateMany with select checks @min first and returns the updated nodes", async () => {
    await db.article.createMany({
      data: [
        { title: "a", views: 1 },
        { title: "b", views: 5 },
      ],
    });
    await expect(
      db.article.updateMany({ data: { views: { decrement: 2 } }, select: { title: true } }),
    ).rejects.toBeInstanceOf(CyphraValidationError);
    const res = await db.article.updateMany({
      data: { views: { increment: 2 } },
      select: { title: true, views: true },
    });
    expect(res.count).toBe(2);
    expect(res.nodes.sort((x, y) => x.title.localeCompare(y.title))).toEqual([
      { title: "a", views: 3 },
      { title: "b", views: 7 },
    ]);
    expect(
      await db.article.updateMany({
        where: { title: "none" },
        data: { views: { increment: 1 } },
        select: { title: true },
      }),
    ).toEqual({ count: 0, nodes: [] });
  });

  it("adds, removes and sets labels on update, updateMany and upsert", async () => {
    const a = await db.article.create({ data: { title: "A", $labels: ["Featured"] } });
    const up = await db.article.update({
      where: { id: a.id },
      data: { title: "A2", $labels: { add: ["Pinned", "Archived"], remove: ["Featured"] } },
      select: { title: true, $labels: true },
    });
    expect(up).toEqual({ title: "A2", $labels: ["Archived", "Pinned"] });
    const set = await db.article.update({
      where: { id: a.id },
      data: { $labels: { set: ["Featured"] } },
      select: { $labels: true },
    });
    expect(set.$labels).toEqual(["Featured"]);
    expect(await labelsOf(a.id)).toEqual(["Article", "Content", "Featured"]);

    await db.page.createMany({
      data: [
        { title: "P1", path: "/1", $labels: ["Archived"] },
        { title: "P2", path: "/2" },
      ],
    });
    // Through the interface, on its own labels.
    const many = await db.content.updateMany({
      where: { $labels: { hasNone: ["Archived"] } },
      data: { $labels: { add: ["Archived"] } },
    });
    expect(many).toEqual({ count: 2 }); // the article and P2
    expect(await db.content.count({ where: { $labels: { isEmpty: true } } })).toBe(0);

    const created = await db.page.upsert({
      where: { path: "/3" },
      create: { title: "P3", path: "/3", $labels: ["Archived"] },
      update: { $labels: { remove: ["Archived"] } },
      select: { path: true, $labels: true },
    });
    expect(created).toEqual({ path: "/3", $labels: ["Archived"] });
    const matched = await db.page.upsert({
      where: { path: "/3" },
      create: { title: "P3", path: "/3" },
      update: { $labels: { remove: ["Archived"] } },
      select: { path: true, $labels: true },
    });
    expect(matched).toEqual({ path: "/3", $labels: [] });
  });

  it("keeps labels unchanged when a @min check fails", async () => {
    const a = await db.article.create({ data: { title: "A" } });
    await expect(
      db.article.update({
        where: { id: a.id },
        data: { views: { decrement: 1 }, $labels: { add: ["Pinned"] } },
      }),
    ).rejects.toThrow();
    expect(await labelsOf(a.id)).toEqual(["Article", "Content"]);
  });

  it("filters by label, on relations and through the interface", async () => {
    await db.author.create({
      data: {
        name: "U",
        articles: {
          create: [
            { title: "A", $labels: ["Featured", "Pinned"] },
            { title: "B", $labels: ["Featured"] },
            { title: "C", $labels: ["Archived"] },
          ],
        },
      },
    });
    await db.page.create({ data: { title: "P", path: "/p", $labels: ["Archived"] } });
    const titles = async (where: Parameters<Db["article"]["findMany"]>[0]) =>
      (await db.article.findMany({ ...where, orderBy: { title: "asc" } })).map((x) => x.title);
    expect(await titles({ where: { $labels: { has: "Featured" } } })).toEqual(["A", "B"]);
    expect(await titles({ where: { $labels: { hasEvery: ["Featured", "Pinned"] } } })).toEqual([
      "A",
    ]);
    expect(await titles({ where: { $labels: { hasSome: ["Pinned", "Archived"] } } })).toEqual([
      "A",
      "C",
    ]);
    expect(await titles({ where: { $labels: { hasNone: ["Featured"] } } })).toEqual(["C"]);
    expect(await titles({ where: { $labels: { hasSome: [] } } })).toEqual([]);
    expect(
      await titles({ where: { OR: [{ title: "C" }, { NOT: { $labels: { has: "Archived" } } }] } }),
    ).toEqual(["A", "B", "C"]);

    const archived = await db.content.findMany({
      where: { $labels: { has: "Archived" } },
      orderBy: { title: "asc" },
      select: { title: true, $labels: true },
    });
    expect(archived).toEqual([
      { __typename: "Article", title: "C", $labels: ["Archived"] },
      { __typename: "Page", title: "P", $labels: ["Archived"] },
    ]);
    const authors = await db.author.count({
      where: { articles: { some: { $labels: { has: "Pinned" } } } },
    });
    expect(authors).toBe(1);
  });

  it("rejects labels outside the schema's allow-list before running anything", async () => {
    await expect(
      db.article.create({
        data: { title: "x", $labels: ["Featured` SET n:Admin //" as "Featured"] },
      }),
    ).rejects.toBeInstanceOf(CyphraValidationError);
    expect(await db.article.count()).toBe(0);
  });
});
