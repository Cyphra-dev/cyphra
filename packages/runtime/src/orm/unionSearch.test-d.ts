/**
 * Compile-time tests for `search` / `findSimilar` over a union (`union UsHit = UsArticle |
 * UsAuthor | UsEditor`), checked by `tsc --noEmit` / `pnpm typecheck`. The bodies never run
 * against a database.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { Db as UnionsDb } from "./__fixtures__/unions.gen.js";
import type { Db } from "./__fixtures__/unionSearch.gen.js";
import type { IndexScore } from "./types.js";

declare const db: Db;
declare const unions: UnionsDb;

describe("search over a union", () => {
  it("returns the members with $score, and $scores with scores: true", async () => {
    const hits = await db.usHit.search({
      query: "graph",
      indexes: { UsArticle: "usArticleText", UsAuthor: "usAuthorName" },
      take: 10,
    });
    const hit = hits[0]!;
    expectTypeOf(hit.$score).toEqualTypeOf<number>();
    expectTypeOf(hit.__typename).toEqualTypeOf<"UsArticle" | "UsAuthor" | "UsEditor">();
    if (hit.__typename === "UsArticle") expectTypeOf(hit.title).toEqualTypeOf<string>();
    // @ts-expect-error -- $scores only with scores: true
    void hit.$scores;
    const scored = await db.usHit.search({
      query: "graph",
      indexes: { UsAuthor: "usAuthorBio" },
      scores: true,
    });
    expectTypeOf(scored[0]!.$scores).toEqualTypeOf<Record<string, IndexScore>>();
  });

  it("takes a union where, per-member select and fusion options", async () => {
    const rows = await db.usHit.search({
      query: "graph",
      mode: "terms",
      indexes: { UsAuthor: "usAuthorBio" },
      where: { $on: { UsArticle: { published: true }, UsAuthor: {} } },
      select: { $on: { UsArticle: { title: true, tags: true } } },
      skip: 5,
      take: 5,
      rrfK: 10,
      minScore: 0.1,
    });
    const row = rows[0]!;
    if (row.__typename === "UsArticle") {
      expectTypeOf(row.tags).toEqualTypeOf<{ id: string; name: string }[]>();
    }
    await db.usHit.search({
      query: "x",
      // @ts-expect-error -- not an index of UsArticle
      indexes: { UsArticle: "usAuthorBio" },
    });
    await db.usHit.search({
      query: "x",
      // @ts-expect-error -- UsTag is not a member
      indexes: { UsTag: "x" },
    });
    // @ts-expect-error -- a union has no single index
    await db.usHit.search({ query: "x", index: "usArticleText" });
    // Interface members name the interface's index.
    await db.usParty.search({ query: "x", indexes: { UsPerson: "usPersonAbout" } });
  });

  it("finds similar nodes through the members' vector indexes", async () => {
    const hits = await db.usHit.findSimilar({
      vector: [1, 0, 0],
      take: 3,
      fields: { UsArticle: "embedding" },
      scores: true,
    });
    expectTypeOf(hits[0]!.$score).toEqualTypeOf<number>();
    expectTypeOf(hits[0]!.$scores).toEqualTypeOf<Record<string, IndexScore>>();
    // @ts-expect-error -- take is required
    await db.usHit.findSimilar({ vector: [1, 0, 0] });
    // @ts-expect-error -- UsPerson has no vector index
    await db.usParty.findSimilar({ vector: [1, 0, 0], take: 1, fields: { UsPerson: "embedding" } });
  });

  it("has no search on a union whose members have no index", () => {
    // @ts-expect-error -- no member of SearchHit has a @@fulltext index
    void unions.searchHit.search;
    // @ts-expect-error -- nor a vector index
    void unions.searchHit.findSimilar;
  });
});
