import { describe, expect, it, vi } from "vitest";
import { createFluentQueryRoot } from "./fluentReadQuery.js";

describe("createFluentQueryRoot", () => {
  it("compiles MATCH + OPTIONAL MATCH + WHERE + RETURN + LIMIT and flattens root + optional node", async () => {
    const readQuery = vi.fn(async (compiled: { text: string; params: Record<string, unknown> }) => {
      expect(compiled.text).toContain("MATCH (p:Post)");
      expect(compiled.text).toContain("OPTIONAL MATCH (p)-[r:WRITTEN_BY]->(a:Author)");
      expect(compiled.text).toContain("WHERE");
      expect(compiled.text).toContain("RETURN");
      expect(compiled.text).toContain("p AS p");
      expect(compiled.text).toContain("a AS a");
      expect(compiled.text).toMatch(/LIMIT/i);
      expect(compiled.params).toMatchObject({ p0: "hi" });
      return [
        {
          p: { properties: { title: "Hi", slug: "hi", body: "x", createdAt: "2020-01-01" } },
          a: { properties: { name: "Ann" } },
        },
      ];
    });

    const root = createFluentQueryRoot({ readQuery });
    const row = await root
      .match((p) => p.label("Post").prop("slug").eq("hi"))
      .optionalOut("WRITTEN_BY", "Author")
      .return("p")
      .limit(1)
      .first();

    expect(readQuery).toHaveBeenCalledTimes(1);
    expect(row).toEqual({
      title: "Hi",
      slug: "hi",
      body: "x",
      createdAt: "2020-01-01",
      author: { name: "Ann" },
    });
  });

  it("returns only root properties when optional target is absent from RETURN", async () => {
    const readQuery = vi.fn(async () => [
      { p: { properties: { title: "Only" } }, a: { properties: {} } },
    ]);
    const root = createFluentQueryRoot({ readQuery });
    const row = await root
      .match((p) => p.label("Post").prop("slug").eq("x"))
      .optionalOut("WRITTEN_BY", "Author")
      .return("p", "a")
      .first();
    expect(row).toEqual({
      title: "Only",
      author: null,
    });
  });

  it("throws if .label() was not called", async () => {
    const root = createFluentQueryRoot({ readQuery: vi.fn() });
    const chain = root.match((p) => {
      p.prop("x").eq(1);
    });
    await expect(chain.return("p").first()).rejects.toThrow(/\.label\(/);
  });

  it("rejects invalid identifiers in label/optionalOut/return", () => {
    const root = createFluentQueryRoot({ readQuery: vi.fn() });
    expect(() => root.match((p) => p.label("Bad-Label")).return("p")).toThrow(/invalid identifier/);

    expect(() =>
      root
        .match((p) => p.label("Post"))
        .optionalOut("WRITTEN-BY", "Author")
        .return("p"),
    ).toThrow(/invalid identifier/);

    expect(() => root.match((p) => p.label("Post")).return("bad-alias")).toThrow(
      /invalid identifier/,
    );
  });
});
