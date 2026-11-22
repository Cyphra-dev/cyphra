import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Db } from "./__fixtures__/unions.gen.js";
import { CyphraValidationError, NotFoundError } from "./errors.js";
import { hasTestDb, testConnection } from "./__fixtures__/testDialect.js";

// Each test makes many round trips: the default 5 s is too tight on a busy CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const LABELS = ["Story", "Writer", "Editor", "Contributor", "Remark", "Shelf", "Marker"];

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

  /** A shelf showing an story (with remarks), an writer and a editor member. */
  async function seed() {
    await db.editor.create({ data: { email: "s@x.io", role: "admin" } });
    const shelf = await db.shelf.create({
      data: {
        name: "front",
        items: {
          create: [
            { Story: { title: "Graphs", remarks: { create: [{ text: "n1" }, { text: "n2" }] } } },
            { Writer: { name: "Ada", rating: 5 } },
          ],
          connect: { Editor: { email: "s@x.io" } },
        },
      },
    });
    // Not on the shelf, and not a member of the union.
    await db.remark.create({ data: { text: "loose" } });
    await db.writer.create({ data: { name: "Bob" } });
    return shelf;
  }

  it("writes no label for the union and reads every member, typed by __typename", async () => {
    await seed();
    const labels = await db.$cypher<{ l: string[] }>`
      MATCH (n) WHERE n:SearchHit RETURN labels(n) AS l`;
    expect(labels).toEqual([]);
    const hits = await db.searchHit.findMany({ orderBy: [{ __typename: "asc" }] });
    expect(hits.map((h) => h.__typename)).toEqual(["Editor", "Story", "Writer", "Writer"]);
    const story = hits.find((h) => h.__typename === "Story")!;
    expect(story).toEqual({ __typename: "Story", id: expect.any(String), title: "Graphs" });
    expect(hits.find((h) => h.__typename === "Editor")).toEqual({
      __typename: "Editor",
      id: expect.any(String),
      email: "s@x.io",
      role: "admin",
    });
    expect(await db.searchHit.count()).toBe(4);
  });

  it("filters with __typename and $on, selects per member", async () => {
    await seed();
    expect(await db.searchHit.count({ where: { __typename: { in: ["Writer", "Editor"] } } })).toBe(
      3,
    );
    const found = await db.searchHit.findMany({
      where: { $on: { Story: { title: { contains: "raph" } }, Writer: { rating: { gte: 4 } } } },
      select: { $on: { Story: { title: true, remarks: { orderBy: { text: "asc" } } } } },
      orderBy: { __typename: "asc" },
    });
    expect(found).toEqual([
      {
        __typename: "Story",
        title: "Graphs",
        remarks: [
          { id: expect.any(String), text: "n1" },
          { id: expect.any(String), text: "n2" },
        ],
      },
      { __typename: "Writer" },
    ]);
    expect(await db.searchHit.count({ where: { $on: {} } })).toBe(0);
    const first = await db.searchHit.findFirst({ where: { __typename: "Editor" } });
    expect(first?.__typename).toBe("Editor");
  });

  it("loads, filters and counts relations to a union", async () => {
    await seed();
    const shelves = await db.shelf.findMany({
      where: { items: { some: { $on: { Writer: { name: "Ada" } } } } },
      include: {
        items: { where: { __typename: { not: "Editor" } }, orderBy: { __typename: "desc" } },
        _count: true,
      },
    });
    expect(shelves).toHaveLength(1);
    expect(shelves[0]!._count).toEqual({ items: 3 });
    expect(shelves[0]!.items.map((i) => i.__typename)).toEqual(["Writer", "Story"]);
    expect(
      await db.shelf.count({ where: { items: { none: { $on: { Writer: { name: "Bob" } } } } } }),
    ).toBe(1);
  });

  it("connects, disconnects and sets by member, rejecting a missing member", async () => {
    const shelf = await seed();
    await db.shelf.update({
      where: { id: shelf.id },
      data: {
        items: {
          connect: [{ Writer: { name: "Bob" } }],
          disconnect: { Editor: { email: "s@x.io" } },
        },
      },
    });
    const names = async () =>
      (
        await db.shelf.findUniqueOrThrow({
          where: { id: shelf.id },
          select: { items: { select: { $on: { Writer: { name: true } } } } },
        })
      ).items
        .map((i) => ("name" in i ? `${i.__typename}:${i.name}` : i.__typename))
        .sort();
    expect(await names()).toEqual(["Story", "Writer:Ada", "Writer:Bob"]);
    await db.shelf.update({
      where: { id: shelf.id },
      data: { items: { set: [{ Writer: { name: "Bob" } }, { Editor: { email: "s@x.io" } }] } },
    });
    expect(await names()).toEqual(["Editor", "Writer:Bob"]);
    await expect(
      db.shelf.update({
        where: { id: shelf.id },
        data: { items: { connect: { Writer: { name: "Nobody" } } } },
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      db.shelf.update({
        where: { id: shelf.id },
        // @ts-expect-error the member must be named
        data: { items: { connect: { name: "Bob" } } },
      }),
    ).rejects.toThrow(CyphraValidationError);
  });

  it("keeps a to-one relation to a union, and its inverse, to one edge", async () => {
    await seed();
    const story = await db.story.findFirst();
    const marker = await db.marker.create({
      data: { label: "p1", subject: { connect: { Story: { id: story!.id } } } },
      include: { subject: true },
    });
    expect(marker.subject).toEqual({ __typename: "Story", id: story!.id, title: "Graphs" });
    // Pinning another member replaces the edge.
    const moved = await db.marker.update({
      where: { id: marker.id },
      data: { subject: { connect: { Writer: { name: "Bob" } } } },
      include: { subject: true },
    });
    expect(moved.subject?.__typename).toBe("Writer");
    // A second marker taking the story: Story.marker is to-one, so the first marker's edge goes.
    await db.marker.update({
      where: { id: marker.id },
      data: { subject: { connect: { Story: { id: story!.id } } } },
    });
    await db.marker.create({
      data: { label: "p2", subject: { connect: { Story: { id: story!.id } } } },
    });
    const markers = await db.marker.findMany({ include: { subject: true }, orderBy: { label: "asc" } });
    expect(markers.map((p) => [p.label, p.subject?.__typename ?? null])).toEqual([
      ["p1", null],
      ["p2", "Story"],
    ]);
    const a = await db.story.findUniqueOrThrow({
      where: { id: story!.id },
      include: { marker: true },
    });
    expect(a.marker?.label).toBe("p2");
  });

  it("cascades a delete into a union with each member's own rules", async () => {
    const shelf = await seed();
    await db.shelf.delete({ where: { id: shelf.id } });
    // Story, Ada and the editor member went with the shelf, the story's remarks with it.
    expect((await db.searchHit.findMany()).map((h) => h.__typename)).toEqual(["Writer"]);
    expect((await db.remark.findMany()).map((n) => n.text)).toEqual(["loose"]);
  });

  it("traverses into a union", async () => {
    const shelf = await seed();
    const reached = await db.shelf.traverse({
      from: { id: shelf.id },
      via: [{ rel: "items", where: { __typename: "Story" } }],
    });
    expect(reached.map((r) => r.__typename)).toEqual(["Story"]);
  });

  it("checks the rules of the member a nested create names", async () => {
    await expect(
      db.shelf.create({
        data: { name: "b", items: { create: { Story: { title: "x".repeat(201) } } } },
      }),
    ).rejects.toThrow(CyphraValidationError);
    expect(await db.shelf.count()).toBe(0);
  });
});
