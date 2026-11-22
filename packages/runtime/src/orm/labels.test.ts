import { describe, expect, it } from "vitest";
import { schemaModel } from "./__fixtures__/labels.gen.js";
import { ModelEngine, type Executor, type Runner } from "./engine.js";
import { CyphraValidationError } from "./errors.js";

type Call = { text: string; params: Record<string, unknown> };

function engine(
  name: string,
  answer: (text: string, params: Record<string, unknown>) => Record<string, unknown>[] = () => [],
) {
  const calls: Call[] = [];
  const exec: Executor = async (text, params) => {
    calls.push({ text, params });
    return answer(text, params);
  };
  const runner: Runner = { read: (fn) => fn(exec), write: (fn) => fn(exec) };
  const node = schemaModel.nodes.find((n) => n.name === name)!;
  return { calls, e: new ModelEngine(schemaModel, node, runner) };
}

const row = (r: Record<string, unknown>) => () => [{ row: r, c: 1, id: "x", created: true }];

describe("dynamic labels: schema model", () => {
  it("inherits the interface's labels before the node's own", () => {
    const article = schemaModel.nodes.find((n) => n.name === "Article")!;
    expect(article.dynamicLabels).toEqual(["Archived", "Featured", "Pinned"]);
    expect(article.labels).toEqual(["Article", "Content"]);
  });
});

describe("dynamic labels: writes", () => {
  it("creates a node with its labels in the CREATE pattern", async () => {
    const { calls, e } = engine("Article", row({ id: "a" }));
    await e.create({ data: { title: "T", $labels: ["Featured", "Archived", "Featured"] } });
    expect(calls[0]!.text).toMatch(/^CREATE \(n:`Article`:`Content`:`Featured`:`Archived` \$p0\)/);
    expect(calls[0]!.params.p0).not.toHaveProperty("$labels");
  });

  it("creates nested nodes with their labels, batching the ones that share them", async () => {
    const { calls, e } = engine("Author", row({ id: "u" }));
    await e.create({
      data: {
        name: "U",
        articles: {
          create: [
            { title: "a", $labels: ["Pinned"] },
            { title: "b", $labels: ["Pinned"] },
            { title: "c" },
            { title: "d", tags: { create: { name: "x", $labels: ["Hidden"] } } },
          ],
        },
      },
    });
    const text = calls[0]!.text;
    expect(text).toContain("CREATE (c1:`Article`:`Content`:`Pinned`) SET c1 = x0.p");
    expect(text).toContain("CREATE (c4:`Article`:`Content`) SET c4 = x3.p");
    expect(text).toContain("CREATE (c6:`Article`:`Content` $p3)");
    expect(text).toMatch(/CREATE \(c\d+:`Tag`:`Hidden`\) SET/);
    // The two Pinned articles are one batch.
    expect((text.match(/:`Pinned`/g) ?? []).length).toBe(1);
  });

  it("groups createMany rows by labels, one UNWIND each", async () => {
    const { calls, e } = engine("Page", () => [{ c: 3 }]);
    const res = await e.createMany({
      data: [
        { title: "a", path: "/a" },
        { title: "b", path: "/b", $labels: ["Archived"] },
        { title: "c", path: "/c" },
      ],
    });
    expect(res).toEqual({ count: 3 });
    expect(calls[0]!.text).toBe(
      "UNWIND $p0 AS row CREATE (n:`Page`:`Content`) SET n = row WITH count(n) AS c0 " +
        "UNWIND $p1 AS row CREATE (n:`Page`:`Content`:`Archived`) SET n = row WITH c0, count(n) AS c1 " +
        "RETURN c0 + c1 AS c",
    );
    expect(calls[0]!.params.p0).toHaveLength(2);
  });

  it("keeps createMany without labels as it was", async () => {
    const { calls, e } = engine("Page", () => [{ c: 1 }]);
    await e.createMany({ data: [{ title: "a", path: "/a" }] });
    expect(calls[0]!.text).toBe(
      "UNWIND $p0 AS row CREATE (n:`Page`:`Content`) SET n = row RETURN count(n) AS c",
    );
  });

  it("adds and removes labels on update", async () => {
    const { calls, e } = engine("Article", row({ id: "a" }));
    await e.update({
      where: { id: "a" },
      data: { title: "T2", $labels: { add: ["Archived"], remove: ["Featured", "Pinned"] } },
    });
    expect(calls[0]!.text).toMatch(
      /^MATCH \(n:`Article`:`Content`\) WHERE n.`id` = \$p0 WITH n LIMIT 1 SET n.`title` = \$p1, n:`Archived` REMOVE n:`Featured`:`Pinned` RETURN/,
    );
  });

  it("sets exactly the given labels", async () => {
    const { calls, e } = engine("Article", row({ id: "a" }));
    await e.update({ where: { id: "a" }, data: { $labels: { set: ["Pinned"] } } });
    expect(calls[0]!.text).toContain(
      "WITH n LIMIT 1 SET n:`Pinned` REMOVE n:`Archived`:`Featured` RETURN",
    );
    await e.update({ where: { id: "a" }, data: { $labels: { set: [] } } });
    expect(calls[1]!.text).toContain(
      "WITH n LIMIT 1 REMOVE n:`Archived`:`Featured`:`Pinned` RETURN",
    );
  });

  it("changes labels only when the @min / @max checks pass", async () => {
    const { calls, e } = engine("Article", () => [{ row: { id: "a" }, bad: [] }]);
    await e.update({
      where: { id: "a" },
      data: { views: { decrement: 1 }, $labels: { add: ["Featured"], remove: ["Archived"] } },
    });
    expect(calls[0]!.text).toContain(
      "FOREACH (x IN CASE WHEN size(bad) = 0 THEN [1] ELSE [] END | SET n.`views` = n.`views` - $p1, n:`Featured` REMOVE n:`Archived`)",
    );
  });

  it("updates labels of many nodes", async () => {
    const { calls, e } = engine("Content", () => [{ c: 4 }]);
    await e.updateMany({
      where: { $labels: { has: "Archived" } },
      data: { $labels: { remove: ["Archived"] } },
    });
    expect(calls[0]!.text).toBe(
      "MATCH (n:`Content`) WHERE n:`Archived` REMOVE n:`Archived` RETURN count(n) AS c",
    );
  });

  it("applies create labels on create and update labels on match in an upsert", async () => {
    const { calls, e } = engine("Page", row({ id: "p" }));
    await e.upsert({
      where: { path: "/a" },
      create: { title: "A", $labels: ["Archived"] },
      update: { $labels: { add: ["Archived"] } },
    });
    expect(calls[0]!.text).toMatch(
      /^MERGE \(n:`Page`:`Content` \{`path`: \$p0\}\) ON CREATE SET n \+= \$p1, n:`Archived` ON MATCH SET n:`Archived` RETURN/,
    );
    await e.upsert({
      where: { path: "/a" },
      create: { title: "A" },
      update: { $labels: { remove: ["Archived"] } },
    });
    // ON MATCH SET cannot remove a label: the update runs in a FOREACH on matched nodes.
    expect(calls[1]!.text).toContain(
      "WITH n, n.`__cyphraUpsertCreated` IS NOT NULL AS created REMOVE n.`__cyphraUpsertCreated` " +
        "FOREACH (x IN CASE WHEN created THEN [] ELSE [1] END | REMOVE n:`Archived`)",
    );
  });

  it("works through an interface on the interface's labels", async () => {
    const { calls, e } = engine("Content", row({ id: "a", __labels: ["Page", "Content"] }));
    await e.update({ where: { id: "a" }, data: { $labels: { add: ["Archived"] } } });
    expect(calls[0]!.text).toContain(
      "MATCH (n:`Content`) WHERE n.`id` = $p0 WITH n LIMIT 1 SET n:`Archived`",
    );
    await expect(
      e.update({ where: { id: "a" }, data: { $labels: { add: ["Featured" as never] } } }),
    ).rejects.toThrow(/expected "Archived", got "Featured"/);
  });

  it("rejects labels outside the allow-list, and $labels on models without one", async () => {
    const { e } = engine("Article", row({ id: "a" }));
    const bad = async (p: Promise<unknown>, re: RegExp) => {
      const err = await p.catch((x: unknown) => x);
      expect(err).toBeInstanceOf(CyphraValidationError);
      expect(String((err as Error).message)).toMatch(re);
    };
    await bad(
      e.create({ data: { title: "x", $labels: ["Archived`) DETACH DELETE n //"] } }),
      /expected "Archived" \| "Featured" \| "Pinned", got/,
    );
    await bad(e.create({ data: { title: "x", $labels: "Archived" } }), /expects an array/);
    await bad(
      e.update({ where: { id: "a" }, data: { $labels: { add: ["Pinned"], remove: ["Pinned"] } } }),
      /Pinned is both added and removed/,
    );
    await bad(
      e.update({ where: { id: "a" }, data: { $labels: { set: ["Pinned"], add: ["Featured"] } } }),
      /use set alone/,
    );
    await bad(
      e.update({ where: { id: "a" }, data: { $labels: { toggle: ["Pinned"] } } }),
      /Unknown .*operation "toggle"/,
    );
    await bad(
      e.update({ where: { id: "a" }, data: { $labels: ["Pinned"] } }),
      /takes \{ add, remove \} or \{ set \}/,
    );
    const author = engine("Author", row({ id: "u" })).e;
    await bad(
      author.create({ data: { name: "U", $labels: ["Archived"] } }),
      /Author declares no dynamic labels/,
    );
    await bad(
      author.findMany({ where: { $labels: { has: "Archived" } } }),
      /Author declares no dynamic labels/,
    );
    await bad(author.findMany({ select: { $labels: true } }), /Author declares no dynamic labels/);
  });
});

describe("dynamic labels: filters", () => {
  const where = async (filter: unknown) => {
    const { calls, e } = engine("Article", () => []);
    await e.findMany({ where: { $labels: filter } });
    return calls[0]!.text
      .replace(/^MATCH \(n:`Article`:`Content`\)( WHERE )?/, "")
      .replace(/ RETURN .*$/, "");
  };

  it("compiles has / hasSome / hasEvery / hasNone / isEmpty to label predicates", async () => {
    expect(await where({ has: "Pinned" })).toBe("n:`Pinned`");
    expect(await where({ hasSome: ["Pinned", "Featured"] })).toBe("(n:`Pinned`) OR (n:`Featured`)");
    expect(await where({ hasSome: [] })).toBe("false");
    expect(await where({ hasEvery: ["Pinned", "Featured"] })).toBe("n:`Pinned`:`Featured`");
    expect(await where({ hasEvery: [] })).toBe("");
    expect(await where({ hasNone: ["Archived"] })).toBe("NOT (n:`Archived`)");
    expect(await where({ isEmpty: true })).toBe(
      "NOT ((n:`Archived`) OR (n:`Featured`) OR (n:`Pinned`))",
    );
    expect(await where({ has: "Pinned", hasNone: ["Archived"] })).toBe(
      "(n:`Pinned`) AND (NOT (n:`Archived`))",
    );
  });

  it("filters related nodes by their labels", async () => {
    const { calls, e } = engine("Author", () => []);
    await e.findMany({ where: { articles: { some: { $labels: { has: "Featured" } } } } });
    expect(calls[0]!.text).toContain(
      "EXISTS { MATCH (n)-[:`WROTE`]->(m0:`Article`:`Content`) WHERE m0:`Featured` }",
    );
  });

  it("rejects unknown operators and labels", async () => {
    await expect(where({ contains: "Pinned" })).rejects.toThrow(/Unknown filter "contains"/);
    await expect(where({ has: "Hidden" })).rejects.toThrow(/got "Hidden"/);
    await expect(where("Pinned")).rejects.toThrow(/takes \{ has, hasSome/);
  });
});

describe("dynamic labels: results", () => {
  it("returns $labels when selected, in declaration order, without other labels", async () => {
    const { calls, e } = engine("Article", () => [
      { row: { title: "T", __labels: ["Pinned", "Article", "Content", "Archived", "Other"] } },
    ]);
    const res = await e.findMany({ select: { title: true, $labels: true } });
    expect(calls[0]!.text).toBe(
      "MATCH (n:`Article`:`Content`) RETURN n{.`title`, `__labels`: labels(n)} AS row",
    );
    expect(res).toEqual([{ title: "T", $labels: ["Archived", "Pinned"] }]);
  });

  it("returns $labels with include, on relations and on interface results", async () => {
    const { calls, e } = engine("Author", () => [
      {
        row: {
          id: "u",
          name: "U",
          articles: [
            { id: "a", title: "T", views: 1, __labels: ["Article", "Content", "Featured"] },
          ],
        },
      },
    ]);
    const res = await e.findMany({ include: { articles: { include: { $labels: true } } } });
    expect(calls[0]!.text).toContain(
      "RETURN m0{.`id`, .`title`, .`views`, `__labels`: labels(m0)}",
    );
    expect(res[0]!.articles).toEqual([{ id: "a", title: "T", views: 1, $labels: ["Featured"] }]);

    const content = engine("Content", () => [
      {
        row: {
          id: "p",
          title: "P",
          path: "/p",
          views: null,
          __labels: ["Page", "Content", "Archived"],
        },
      },
    ]);
    const pages = await content.e.findMany({ include: { $labels: true } });
    expect(content.calls[0]!.text.match(/__labels/g)).toHaveLength(1);
    expect(pages).toEqual([
      { __typename: "Page", id: "p", title: "P", path: "/p", $labels: ["Archived"] },
    ]);
  });
});
