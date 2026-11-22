/**
 * Compile-time tests for unions (`union SearchHit = Story | Writer | Editor`), checked by
 * `tsc --noEmit` / `pnpm typecheck`. The bodies never run against a database.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { Db, SearchHit } from "./__fixtures__/unions.gen.js";

declare const db: Db;

type StoryRow = { __typename: "Story"; id: string; title: string };
type WriterRow = { __typename: "Writer"; id: string; name: string; rating: number | null };
type EditorRow = { __typename: "Editor"; id: string; email: string; role: string };

describe("union types", () => {
  it("returns the members, discriminated by __typename", async () => {
    const hits = await db.searchHit.findMany({
      where: { __typename: { in: ["Story", "Writer"] } },
    });
    expectTypeOf(hits).toEqualTypeOf<(StoryRow | WriterRow | EditorRow)[]>();
    expectTypeOf<SearchHit>().toEqualTypeOf<
      | ({ __typename: "Story" } & { id: string; title: string })
      | ({ __typename: "Writer" } & { id: string; name: string; rating: number | null })
      | ({ __typename: "Editor" } & { id: string; email: string; role: string })
    >();
    const first = await db.searchHit.findFirst({ orderBy: { __typename: "asc" } });
    if (first?.__typename === "Writer") expectTypeOf(first.rating).toEqualTypeOf<number | null>();
    expectTypeOf(
      await db.searchHit.count({ where: { $on: { Writer: {} } } }),
    ).toEqualTypeOf<number>();
  });

  it("filters with $on per member, and nothing else", async () => {
    await db.searchHit.findMany({
      where: { $on: { Story: { title: { contains: "x" } }, Editor: { email: "e" } } },
    });
    // @ts-expect-error a union has no fields
    await db.searchHit.findMany({ where: { title: "x" } });
    // @ts-expect-error not a member
    await db.searchHit.findMany({ where: { $on: { Remark: {} } } });
    // @ts-expect-error not a member
    await db.searchHit.findMany({ where: { __typename: "Remark" } });
    // @ts-expect-error a member's fields go through $on
    await db.searchHit.findMany({ where: { $on: { Writer: { title: "x" } } } });
  });

  it("selects per member with $on", async () => {
    const _rows = await db.searchHit.findMany({
      select: { $on: { Story: { title: true, remarks: true } } },
    });
    type Row = (typeof _rows)[number];
    expectTypeOf<Extract<Row, { __typename: "Story" }>>().toEqualTypeOf<{
      __typename: "Story";
      title: string;
      remarks: { id: string; text: string }[];
    }>();
    expectTypeOf<Extract<Row, { __typename: "Writer" }>>().toEqualTypeOf<{
      __typename: "Writer";
    }>();
  });

  it("has only findMany, findFirst and count", () => {
    // @ts-expect-error no unique key
    void db.searchHit.findUnique;
    // @ts-expect-error written through its members
    void db.searchHit.create;
    // @ts-expect-error written through its members
    void db.searchHit.deleteMany;
    // @ts-expect-error no fields to aggregate
    void db.searchHit.aggregate;
  });

  it("loads relations to a union as the members", async () => {
    const shelf = await db.shelf.findFirst({ include: { items: true } });
    expectTypeOf(shelf!.items).toEqualTypeOf<(StoryRow | WriterRow | EditorRow)[]>();
    const marker = await db.marker.findFirst({ include: { subject: true } });
    expectTypeOf(marker!.subject).toEqualTypeOf<StoryRow | WriterRow | EditorRow | null>();
  });

  it("names the member in relation writes", async () => {
    await db.shelf.create({
      data: {
        name: "b",
        items: {
          create: [{ Story: { title: "t" } }, { Writer: { name: "a" } }],
          connect: [{ Editor: { email: "s@x" } }, { Story: { id: "1" } }],
        },
      },
    });
    await db.shelf.update({
      where: { id: "b" },
      data: { items: { disconnect: { Writer: { name: "a" } }, set: [{ Story: { id: "1" } }] } },
    });
    await db.marker.create({
      data: { label: "l", subject: { connect: { Writer: { name: "a" } } } },
    });
    // @ts-expect-error the member must be named
    await db.marker.create({ data: { label: "l", subject: { connect: { id: "1" } } } });
    await db.marker.create({
      // @ts-expect-error one member per item
      data: { label: "l", subject: { connect: { Writer: { name: "a" }, Story: { id: "1" } } } },
    });
    // @ts-expect-error Writer has no title
    await db.shelf.create({ data: { name: "b", items: { create: { Writer: { title: "t" } } } } });
  });
});

describe("typed edges and interface members", () => {
  it("types $edge on a relation to a union, on writes and reads", async () => {
    const shelf = await db.shelf.create({
      data: {
        name: "s",
        picks: {
          create: { Story: { title: "t" }, $edge: { rank: 1 } },
          connect: { Writer: { name: "w" }, $edge: { rank: { increment: 1 }, note: null } },
        },
      },
      include: { picks: true },
    });
    expectTypeOf(shelf.picks[0]!.$edge).toEqualTypeOf<{ rank: number; note: string | null }>();
    await db.shelf.update({
      where: { id: shelf.id },
      // @ts-expect-error not an edge property
      data: { picks: { connect: { Writer: { name: "w" }, $edge: { weight: 1 } } } },
    });
    const w = await db.writer.findUniqueOrThrow({
      where: { name: "w" },
      include: { pickedBy: true },
    });
    expectTypeOf(w.pickedBy[0]!.$edge.rank).toEqualTypeOf<number>();
  });

  it("reads a union with an interface member as its implementations", async () => {
    const parties = await db.party.findMany({});
    expectTypeOf(parties[0]!.__typename).toEqualTypeOf<"Editor" | "Reviewer" | "Writer">();
    await db.party.findMany({ where: { $on: { Contributor: { email: "e" }, Writer: {} } } });
    // @ts-expect-error not a member
    await db.party.findMany({ where: { $on: { Story: {} } } });
    const rows = await db.party.findMany({ select: { $on: { Contributor: { email: true } } } });
    const r = rows[0]!;
    if (r.__typename === "Reviewer") expectTypeOf(r.email).toEqualTypeOf<string>();
    if (r.__typename === "Writer") expectTypeOf(r).toEqualTypeOf<{ __typename: "Writer" }>();
  });

  it("writes through the interface member's key, creates through an implementation", async () => {
    await db.desk.create({
      data: {
        name: "d",
        owner: { connect: { Contributor: { email: "e" } } },
        seated: {
          connect: { Writer: { name: "w" }, $edge: { since: 1 } },
          create: { Reviewer: { email: "r" } },
        },
      },
    });
    await db.desk.create({
      // @ts-expect-error an interface member cannot be created
      data: { name: "d", seated: { create: { Contributor: { email: "x" } } } },
    });
  });
});
