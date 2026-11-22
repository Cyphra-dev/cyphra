/**
 * Compile-time tests for unions (`union SearchHit = Article | Author | Staff`), checked by
 * `tsc --noEmit` / `pnpm typecheck`. The bodies never run against a database.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { Db, SearchHit } from "./__fixtures__/unions.gen.js";

declare const db: Db;

type ArticleRow = { __typename: "Article"; id: string; title: string };
type AuthorRow = { __typename: "Author"; id: string; name: string; rating: number | null };
type StaffRow = { __typename: "Staff"; id: string; email: string; role: string };

describe("union types", () => {
  it("returns the members, discriminated by __typename", async () => {
    const hits = await db.searchHit.findMany({
      where: { __typename: { in: ["Article", "Author"] } },
    });
    expectTypeOf(hits).toEqualTypeOf<(ArticleRow | AuthorRow | StaffRow)[]>();
    expectTypeOf<SearchHit>().toEqualTypeOf<
      | ({ __typename: "Article" } & { id: string; title: string })
      | ({ __typename: "Author" } & { id: string; name: string; rating: number | null })
      | ({ __typename: "Staff" } & { id: string; email: string; role: string })
    >();
    const first = await db.searchHit.findFirst({ orderBy: { __typename: "asc" } });
    if (first?.__typename === "Author") expectTypeOf(first.rating).toEqualTypeOf<number | null>();
    expectTypeOf(
      await db.searchHit.count({ where: { $on: { Author: {} } } }),
    ).toEqualTypeOf<number>();
  });

  it("filters with $on per member, and nothing else", async () => {
    await db.searchHit.findMany({
      where: { $on: { Article: { title: { contains: "x" } }, Staff: { email: "e" } } },
    });
    // @ts-expect-error a union has no fields
    await db.searchHit.findMany({ where: { title: "x" } });
    // @ts-expect-error not a member
    await db.searchHit.findMany({ where: { $on: { Note: {} } } });
    // @ts-expect-error not a member
    await db.searchHit.findMany({ where: { __typename: "Note" } });
    // @ts-expect-error a member's fields go through $on
    await db.searchHit.findMany({ where: { $on: { Author: { title: "x" } } } });
  });

  it("selects per member with $on", async () => {
    const _rows = await db.searchHit.findMany({
      select: { $on: { Article: { title: true, notes: true } } },
    });
    type Row = (typeof _rows)[number];
    expectTypeOf<Extract<Row, { __typename: "Article" }>>().toEqualTypeOf<{
      __typename: "Article";
      title: string;
      notes: { id: string; text: string }[];
    }>();
    expectTypeOf<Extract<Row, { __typename: "Author" }>>().toEqualTypeOf<{
      __typename: "Author";
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
    const board = await db.board.findFirst({ include: { items: true } });
    expectTypeOf(board!.items).toEqualTypeOf<(ArticleRow | AuthorRow | StaffRow)[]>();
    const pin = await db.pin.findFirst({ include: { subject: true } });
    expectTypeOf(pin!.subject).toEqualTypeOf<ArticleRow | AuthorRow | StaffRow | null>();
  });

  it("names the member in relation writes", async () => {
    await db.board.create({
      data: {
        name: "b",
        items: {
          create: [{ Article: { title: "t" } }, { Author: { name: "a" } }],
          connect: [{ Staff: { email: "s@x" } }, { Article: { id: "1" } }],
        },
      },
    });
    await db.board.update({
      where: { id: "b" },
      data: { items: { disconnect: { Author: { name: "a" } }, set: [{ Article: { id: "1" } }] } },
    });
    await db.pin.create({ data: { label: "l", subject: { connect: { Author: { name: "a" } } } } });
    // @ts-expect-error the member must be named
    await db.pin.create({ data: { label: "l", subject: { connect: { id: "1" } } } });
    await db.pin.create({
      // @ts-expect-error one member per item
      data: { label: "l", subject: { connect: { Author: { name: "a" }, Article: { id: "1" } } } },
    });
    // @ts-expect-error Author has no title
    await db.board.create({ data: { name: "b", items: { create: { Author: { title: "t" } } } } });
  });
});
