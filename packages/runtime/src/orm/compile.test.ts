import { describe, expect, it } from "vitest";
import { schemaModel } from "./__fixtures__/blog.gen.js";
import { QueryContext, compileProjection, compileWhere, q } from "./compile.js";
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

describe("q", () => {
  it("escapes backticks", () => {
    expect(q("a`b")).toBe("`a``b`");
  });
});

describe("generated fixture", () => {
  it("is in sync with blog.cyphra (run the generator if this fails)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { parseSchema, renderCyphraGenSource } = await import("@cyphra/schema");
    const dir = new URL("./__fixtures__/", import.meta.url);
    const src = await readFile(new URL("blog.cyphra", dir), "utf8");
    const gen = await readFile(new URL("blog.gen.ts", dir), "utf8");
    expect(renderCyphraGenSource(parseSchema(src), { runtimeImport: "../../index.js" })).toBe(gen);
  });
});
