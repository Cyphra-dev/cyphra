/**
 * Compile-time tests for dynamic labels (`@@labels([...])`), checked by `tsc --noEmit` /
 * `pnpm typecheck`. The bodies never run against a database.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { Db } from "./__fixtures__/labels.gen.js";

declare const db: Db;

type ArticleLabel = "Archived" | "Featured" | "Pinned";

describe("dynamic label types", () => {
  it("takes the declared labels on create, createMany, update, updateMany and upsert", async () => {
    await db.article.create({ data: { title: "T", $labels: ["Featured", "Archived"] } });
    // @ts-expect-error not a dynamic label of Article
    await db.article.create({ data: { title: "T", $labels: ["Hidden"] } });
    await db.page.createMany({ data: [{ title: "T", path: "/", $labels: ["Archived"] }] });
    await db.article.update({
      where: { id: "a" },
      data: { $labels: { add: ["Pinned"], remove: ["Featured"] } },
    });
    await db.article.update({ where: { id: "a" }, data: { $labels: { set: ["Pinned"] } } });
    await db.article.update({
      where: { id: "a" },
      // @ts-expect-error set cannot be combined with add / remove
      data: { $labels: { set: ["Pinned"], add: ["Featured"] } },
    });
    await db.content.updateMany({ data: { $labels: { remove: ["Archived"] } } });
    await db.page.upsert({
      where: { path: "/" },
      create: { title: "T", path: "/", $labels: ["Archived"] },
      update: { $labels: { remove: ["Archived"] } },
    });
    // Nested creates take the target's labels.
    await db.tag.create({
      data: {
        name: "t",
        $labels: ["Hidden"],
        articles: { create: { title: "a", $labels: ["Pinned"] } },
      },
    });
  });

  it("filters by label", async () => {
    await db.article.findMany({ where: { $labels: { has: "Pinned", hasNone: ["Archived"] } } });
    await db.article.findMany({
      where: { $labels: { hasSome: ["Pinned"], hasEvery: ["Featured"] } },
    });
    await db.content.count({ where: { $labels: { isEmpty: true } } });
    await db.tag.findMany({ where: { articles: { some: { $labels: { has: "Featured" } } } } });
    // @ts-expect-error Featured is not a label of the Content interface
    await db.content.findMany({ where: { $labels: { has: "Featured" } } });
  });

  it("returns $labels only when selected", async () => {
    const [plain] = await db.article.findMany({});
    // @ts-expect-error no $labels without select / include
    void plain!.$labels;
    const selected = await db.article.findMany({ select: { title: true, $labels: true } });
    expectTypeOf(selected).toEqualTypeOf<{ title: string; $labels: ArticleLabel[] }[]>();
    const [included] = await db.article.findMany({ include: { $labels: true } });
    expectTypeOf(included!.$labels).toEqualTypeOf<ArticleLabel[]>();
    expectTypeOf(included!.views).toEqualTypeOf<number>();
    const tags = await db.tag.findMany({
      include: { articles: { select: { id: true, $labels: true } } },
    });
    expectTypeOf(tags[0]!.articles[0]!.$labels).toEqualTypeOf<ArticleLabel[]>();
    const contents = await db.content.findMany({ include: { $labels: true } });
    expectTypeOf(contents[0]!.$labels).toEqualTypeOf<"Archived"[]>();
  });

  it("has no $labels on models without @@labels", async () => {
    // @ts-expect-error Author declares no dynamic labels
    await db.author.create({ data: { name: "A", $labels: ["Archived"] } });
    // @ts-expect-error Author declares no dynamic labels
    await db.author.findMany({ where: { $labels: { has: "Archived" } } });
    // @ts-expect-error Author declares no dynamic labels
    await db.author.findMany({ select: { $labels: true } });
  });
});
