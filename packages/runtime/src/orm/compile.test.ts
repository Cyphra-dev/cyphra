import { describe, expect, it } from "vitest";
import neo4j from "neo4j-driver";
import { schemaModel } from "./__fixtures__/blog.gen.js";
import {
  QueryContext,
  compileOrderBy,
  compileProjection,
  compileWhere,
  decodeRow,
  q,
} from "./compile.js";
import { CyphraValidationError } from "./errors.js";

const user = schemaModel.nodes.find((n) => n.name === "User")!;

function where(w: unknown) {
  const ctx = new QueryContext(schemaModel);
  return { text: compileWhere(ctx, user, "n", w), params: ctx.params };
}

describe("compileWhere", () => {
  it("parameterizes every value", () => {
    const { text, params } = where({ email: "a@x.io", name: { startsWith: "A" } });
    expect(text).toBe("(n.`email` = $p0) AND (n.`name` STARTS WITH $p1)");
    expect(params).toEqual({ p0: "a@x.io", p1: "A" });
  });

  it("compiles null, not, in and list filters", () => {
    expect(where({ name: null }).text).toBe("n.`name` IS NULL");
    expect(where({ name: { not: null } }).text).toBe("n.`name` IS NOT NULL");
    expect(where({ email: { in: ["a", "b"] } }).text).toBe("n.`email` IN $p0");
    expect(where({ tags: { has: "x" } }).text).toBe("$p0 IN n.`tags`");
  });

  it("compiles relation filters to EXISTS subqueries", () => {
    expect(where({ posts: { some: { published: true } } }).text).toBe(
      "EXISTS { MATCH (n)-[:`AUTHORED`]->(m0:`Post`) WHERE m0.`published` = $p0 }",
    );
    expect(where({ followers: { none: {} } }).text).toBe(
      "NOT EXISTS { MATCH (n)<-[:`FOLLOWS`]-(m0:`User`) }",
    );
  });

  it("encodes Int values as driver integers", () => {
    const { params } = where({ age: 3 });
    expect((params.p0 as { toNumber(): number }).toNumber()).toBe(3);
  });

  it("compiles lt / lte / gt / gte on strings (lexicographic)", () => {
    const { text, params } = where({ email: { gt: "b", lte: "m" }, name: { lt: "Z", gte: "A" } });
    expect(text).toBe(
      "((n.`email` > $p0) AND (n.`email` <= $p1)) AND ((n.`name` < $p2) AND (n.`name` >= $p3))",
    );
    expect(params).toEqual({ p0: "b", p1: "m", p2: "Z", p3: "A" });
    expect(() => where({ email: { lt: 3 } })).toThrow(CyphraValidationError);
  });

  it("encodes DateTime filter values at UTC offset 0, whatever the process TZ", () => {
    const at = new Date("2024-03-10T07:30:15.123Z");
    const { params } = where({ createdAt: { gte: at } });
    const dt = params.p0 as InstanceType<typeof neo4j.types.DateTime>;
    expect(dt.timeZoneOffsetSeconds).toBe(0);
    expect(dt.toString()).toBe("2024-03-10T07:30:15.123000000Z");
    expect(dt.toStandardDate().getTime()).toBe(at.getTime());
  });

  it('compiles mode: "insensitive" with toLower() on both sides', () => {
    const { text, params } = where({
      email: { equals: "A@X.io", mode: "insensitive" },
      name: { startsWith: "Al", not: { in: ["BOB"] }, mode: "insensitive" },
    });
    expect(text).toBe(
      "(toLower(n.`email`) = $p0) AND ((toLower(n.`name`) STARTS WITH $p1) AND (NOT (toLower(n.`name`) IN $p2)))",
    );
    expect(params).toEqual({ p0: "a@x.io", p1: "al", p2: ["bob"] });
    // Range filters stay case-sensitive; mode "default" is the plain comparison.
    expect(where({ name: { gt: "B", mode: "insensitive" } }).text).toBe("n.`name` > $p0");
    expect(where({ email: { contains: "X", mode: "default" } }).text).toBe(
      "n.`email` CONTAINS $p0",
    );
  });

  it("rejects mode on non-String fields and unknown modes", () => {
    expect(() => where({ age: { equals: 3, mode: "insensitive" } })).toThrow(CyphraValidationError);
    expect(() => where({ email: { equals: "a", mode: "loose" } })).toThrow(CyphraValidationError);
  });

  it("rejects unknown fields and operators (no identifier injection)", () => {
    expect(() => where({ "x` OR 1=1 //": 1 })).toThrow(CyphraValidationError);
    expect(() => where({ email: { regex: ".*" } })).toThrow(CyphraValidationError);
    expect(() => where({ age: "3" })).toThrow(CyphraValidationError);
  });
});

describe("compileProjection", () => {
  it("nests COLLECT subqueries and edge properties", () => {
    const ctx = new QueryContext(schemaModel);
    const { expr } = compileProjection(ctx, user, "n", {
      select: { email: true, following: { select: { email: true }, take: 2 } },
    });
    expect(expr).toBe(
      "n{.`email`, `following`: COLLECT { MATCH (n)-[r1:`FOLLOWS`]->(m0:`User`) WITH m0, r1 LIMIT $p0 RETURN m0{.`email`, `$edge`: properties(r1)} }}",
    );
  });
});

describe("relation counts", () => {
  const post = schemaModel.nodes.find((n) => n.name === "Post")!;
  const project = (model: typeof user, args: Record<string, unknown>) => {
    const ctx = new QueryContext(schemaModel);
    return { ...compileProjection(ctx, model, "n", args), params: ctx.params };
  };

  it("_count: true counts every to-many relation, in their direction", () => {
    const { expr, shape } = project(user, { select: { email: true, _count: true } });
    expect(expr).toBe(
      "n{.`email`, `_count`: {`posts`: COUNT { MATCH (n)-[:`AUTHORED`]->(m0:`Post`) }, " +
        "`following`: COUNT { MATCH (n)-[:`FOLLOWS`]->(m1:`User`) }, " +
        "`followers`: COUNT { MATCH (n)<-[:`FOLLOWS`]-(m2:`User`) }}}",
    );
    expect(shape.counts?.map((f) => f.name)).toEqual(["posts", "following", "followers"]);
  });

  it("_count.select counts the listed relations, with filters incl. nested relation filters", () => {
    const { expr, params } = project(user, {
      include: {
        _count: {
          select: {
            posts: { where: { published: true, author: { is: { name: "A" } } } },
            followers: true,
            following: false,
          },
        },
      },
    });
    expect(expr).toContain(
      "`_count`: {`posts`: COUNT { MATCH (n)-[:`AUTHORED`]->(m0:`Post`) WHERE (m0.`published` = $p0) AND " +
        "(EXISTS { MATCH (m0)<-[:`AUTHORED`]-(m1:`User`) WHERE m1.`name` = $p1 }) }, " +
        "`followers`: COUNT { MATCH (n)<-[:`FOLLOWS`]-(m2:`User`) }}",
    );
    expect(expr.startsWith("n{.`id`, .`email`")).toBe(true);
    expect(params).toEqual({ p0: true, p1: "A" });
  });

  it("counts inside nested relations and decodes the numbers", () => {
    const { expr, shape } = project(post, {
      select: { title: true, author: { select: { _count: { select: { posts: true } } } } },
    });
    expect(expr).toBe(
      "n{.`title`, `author`: head(COLLECT { MATCH (n)<-[r1:`AUTHORED`]-(m0:`User`) RETURN " +
        "m0{`_count`: {`posts`: COUNT { MATCH (m0)-[:`AUTHORED`]->(m2:`Post`) }}} })}",
    );
    const row = decodeRow(shape, {
      title: "T",
      author: { _count: { posts: neo4j.int(3) } },
    });
    expect(row).toEqual({ title: "T", author: { _count: { posts: 3 } } });
  });

  it("an empty _count.select yields an empty object; false omits it", () => {
    const { expr, shape } = project(user, { select: { id: true, _count: { select: {} } } });
    expect(expr).toBe("n{.`id`, `_count`: {}}");
    expect(decodeRow(shape, { id: "x", _count: {} })).toEqual({ id: "x", _count: {} });
    expect(project(user, { include: { _count: false } }).shape.counts).toBeUndefined();
  });

  it("rejects to-one relations, unknown relations and malformed specs", () => {
    const bad = [
      [post, { include: { _count: { select: { author: true } } } }],
      [user, { include: { _count: { select: { email: true } } } }],
      [user, { include: { _count: { select: { nope: true } } } }],
      [user, { include: { _count: { posts: true } } }],
      [user, { include: { _count: { select: { posts: { take: 1 } } } } }],
      [user, { select: { _count: "yes" } }],
    ] as const;
    for (const [model, args] of bad) {
      expect(() => project(model, args)).toThrow(CyphraValidationError);
    }
  });

  it("orders by relation count", () => {
    const ctx = new QueryContext(schemaModel);
    expect(
      compileOrderBy(ctx, user, "n", [{ followers: { _count: "desc" } }, { email: "asc" }]),
    ).toBe("COUNT { MATCH (n)<-[:`FOLLOWS`]-(m0:`User`) } DESC, n.`email` ASC");
    expect(() => compileOrderBy(ctx, post, "n", { author: { _count: "asc" } })).toThrow(
      CyphraValidationError,
    );
    expect(() => compileOrderBy(ctx, user, "n", { posts: "asc" })).toThrow(CyphraValidationError);
    expect(() => compileOrderBy(ctx, user, "n", { posts: { _count: "up" } })).toThrow(
      CyphraValidationError,
    );
  });

  it("orders by a filtered relation count", () => {
    const ctx = new QueryContext(schemaModel);
    expect(
      compileOrderBy(ctx, user, "n", {
        posts: { _count: "desc", where: { published: true, author: { is: { age: { gt: 1 } } } } },
      }),
    ).toBe(
      "COUNT { MATCH (n)-[:`AUTHORED`]->(m0:`Post`) WHERE (m0.`published` = $p0) AND " +
        "(EXISTS { MATCH (m0)<-[:`AUTHORED`]-(m1:`User`) WHERE m1.`age` > $p1 }) } DESC",
    );
    expect(ctx.params.p0).toBe(true);
    // An empty filter counts every related node; a where alone does not sort.
    expect(compileOrderBy(ctx, user, "n", { posts: { _count: "asc", where: {} } })).toBe(
      "COUNT { MATCH (n)-[:`AUTHORED`]->(m2:`Post`) } ASC",
    );
    expect(compileOrderBy(ctx, user, "n", { posts: { where: { published: true } } })).toBeNull();
    expect(() =>
      compileOrderBy(ctx, user, "n", { posts: { _count: "asc", where: { nope: 1 } } }),
    ).toThrow('Unknown field "Post.nope"');
    expect(() => compileOrderBy(ctx, user, "n", { posts: { _count: "asc", take: 1 } })).toThrow(
      'takes { _count: "asc" | "desc", where? }',
    );
  });

  it("orders by a scalar of a to-one related node", () => {
    const ctx = new QueryContext(schemaModel);
    expect(compileOrderBy(ctx, post, "n", [{ author: { email: "desc" } }, { title: "asc" }])).toBe(
      "head(COLLECT { MATCH (n)<-[:`AUTHORED`]-(m0:`User`) RETURN m0.`email` }) DESC, n.`title` ASC",
    );
    expect(compileOrderBy(ctx, post, "n", { author: { email: undefined } })).toBeNull();
    for (const bad of [
      { author: "asc" },
      { author: { nope: "asc" } },
      { author: { posts: "asc" } },
      { author: { email: "up" } },
    ]) {
      expect(() => compileOrderBy(ctx, post, "n", bad)).toThrow(CyphraValidationError);
    }
  });
});

describe("q", () => {
  it("escapes backticks", () => {
    expect(q("a`b")).toBe("`a``b`");
  });
});

describe("generated fixture", () => {
  it.each([
    "blog",
    "compat",
    "vector",
    "search",
    "types",
    "geo",
    "compound",
    "rules",
    "zod",
    "interfaces",
    "graph",
    "labels",
  ])("is in sync with %s.cyphra (run the generator if this fails)", async (name) => {
    const { readFile } = await import("node:fs/promises");
    const { parseSchema, renderCyphraGenSource } = await import("@cyphra/schema");
    const dir = new URL("./__fixtures__/", import.meta.url);
    const src = await readFile(new URL(`${name}.cyphra`, dir), "utf8");
    const gen = await readFile(new URL(`${name}.gen.ts`, dir), "utf8");
    expect(renderCyphraGenSource(parseSchema(src), { runtimeImport: "../../index.js" })).toBe(gen);
  });
});
