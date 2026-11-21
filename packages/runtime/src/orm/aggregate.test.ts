import { describe, expect, it } from "vitest";
import { schemaModel } from "./__fixtures__/blog.gen.js";
import { compileAggregate, compileGroupBy } from "./aggregate.js";
import { QueryContext } from "./compile.js";
import { CyphraValidationError } from "./errors.js";

const post = schemaModel.nodes.find((n) => n.name === "Post")!;
const user = schemaModel.nodes.find((n) => n.name === "User")!;

const aggregate = (args: Record<string, unknown>, model = post) =>
  compileAggregate(new QueryContext(schemaModel), model, args);
const groupBy = (args: Record<string, unknown>, model = post) =>
  compileGroupBy(new QueryContext(schemaModel), model, args);

describe("compileAggregate", () => {
  it("compiles every aggregate into one parameterised statement", () => {
    const c = aggregate({
      where: { published: true },
      _count: true,
      _sum: { views: true },
      _avg: { views: true },
      _min: { title: true },
      _max: { views: true },
    });
    expect(c.text).toBe(
      "MATCH (n:`Post`) WHERE n.`published` = $p0 RETURN count(n) AS a0, " +
        "CASE WHEN count(n.`views`) = 0 THEN null ELSE sum(n.`views`) END AS a1, " +
        "avg(n.`views`) AS a2, min(n.`title`) AS a3, max(n.`views`) AS a4",
    );
    expect(c.params).toEqual({ p0: true });
  });

  it("deduplicates columns and applies paging before aggregating", () => {
    const c = aggregate({
      _count: { _all: true, views: true },
      _sum: { views: true },
      orderBy: { views: "desc" },
      take: 2,
    });
    expect(c.text).toBe(
      "MATCH (n:`Post`) WITH n ORDER BY n.`views` DESC LIMIT $p0 RETURN count(n) AS a0, " +
        "count(n.`views`) AS a1, CASE WHEN count(n.`views`) = 0 THEN null ELSE sum(n.`views`) END AS a2",
    );
  });

  it("decodes counts, nulls and empty selections", () => {
    const c = aggregate({ _count: { _all: true }, _sum: { views: true }, _min: {} });
    expect(c.decode([{ a0: 0, a1: null }])).toEqual({
      _count: { _all: 0 },
      _sum: { views: null },
      _min: {},
    });
  });

  it("rejects unknown fields and aggregates that do not fit the field type", () => {
    expect(() => aggregate({ _sum: { title: true } })).toThrow(CyphraValidationError);
    expect(() => aggregate({ _avg: { published: true } })).toThrow(CyphraValidationError);
    expect(() => aggregate({ _min: { published: true } })).toThrow(CyphraValidationError);
    expect(() => aggregate({ _max: { tags: true } }, user)).toThrow(CyphraValidationError);
    expect(() => aggregate({ _count: { "x` OR 1=1 //": true } })).toThrow(CyphraValidationError);
    expect(() => aggregate({ _sum: { _all: true } })).toThrow(CyphraValidationError);
    expect(() => aggregate({ _sum: { views: "yes" } })).toThrow(CyphraValidationError);
    expect(() => aggregate({ _median: { views: true } })).toThrow(CyphraValidationError);
  });
});

describe("compileGroupBy", () => {
  it("groups, filters with having and orders by aggregates", () => {
    const c = groupBy({
      by: ["published"],
      where: { views: { gte: 0 } },
      _count: { _all: true },
      having: { views: { _avg: { gt: 10 } }, published: true },
      orderBy: [{ _count: { id: "desc" } }, { published: "asc" }],
      skip: 1,
      take: 5,
    });
    expect(c.text).toBe(
      "MATCH (n:`Post`) WHERE n.`views` >= $p0 " +
        "WITH n.`published` AS k0, count(n) AS a1, avg(n.`views`) AS a2, count(n.`id`) AS a3 " +
        "WHERE (a2 > $p1) AND (k0 = $p2) " +
        "RETURN k0, a1, a2, a3 ORDER BY a3 DESC, k0 ASC SKIP $p3 LIMIT $p4",
    );
    expect(c.params.p1).toBe(10);
    expect(c.params.p2).toBe(true);
    expect(c.decode([{ k0: true, a1: 2, a2: 15, a3: 2 }])).toEqual([
      { published: true, _count: { _all: 2 } },
    ]);
  });

  it("groups by a field of a to-one relation", () => {
    const c = groupBy({
      by: "author.name",
      _sum: { views: true },
      having: { author: { name: { not: null } } },
      orderBy: { author: { name: "asc" } },
    });
    expect(c.text).toBe(
      "MATCH (n:`Post`) WITH n, head(COLLECT { MATCH (n)<-[:`AUTHORED`]-(m2:`User`) RETURN m2 }) AS g1 " +
        "WITH g1.`name` AS k0, CASE WHEN count(n.`views`) = 0 THEN null ELSE sum(n.`views`) END AS a3 " +
        "WHERE k0 IS NOT NULL RETURN k0, a3 ORDER BY k0 ASC",
    );
    expect(c.decode([{ k0: "Alice", a3: 7 }])).toEqual([
      { author: { name: "Alice" }, _sum: { views: 7 } },
    ]);
  });

  it("groups without aggregates (distinct keys)", () => {
    expect(groupBy({ by: ["published"] }).text).toBe(
      "MATCH (n:`Post`) WITH n.`published` AS k0, count(n) AS a1 RETURN k0, a1",
    );
  });

  it("rejects invalid by, having and orderBy", () => {
    expect(() => groupBy({ by: [] })).toThrow(CyphraValidationError);
    expect(() => groupBy({ by: ["nope"] })).toThrow(CyphraValidationError);
    expect(() => groupBy({ by: ["posts.title"] }, user)).toThrow(/to-one/);
    expect(() => groupBy({ by: ["author.nope"] })).toThrow(CyphraValidationError);
    expect(() => groupBy({ by: ["published"], orderBy: { title: "asc" } })).toThrow(
      /must be listed in by/,
    );
    expect(() => groupBy({ by: ["published"], having: { title: "x" } })).toThrow(
      /must be listed in by/,
    );
    expect(() => groupBy({ by: ["published"], having: { title: { _sum: { gt: 1 } } } })).toThrow(
      CyphraValidationError,
    );
    expect(() => groupBy({ by: ["published"], orderBy: { _avg: { views: "up" } } })).toThrow(
      CyphraValidationError,
    );
    expect(() => groupBy({ by: ["published"], select: {} })).toThrow(/Unknown groupBy argument/);
  });
});
