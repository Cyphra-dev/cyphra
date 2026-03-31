import { describe, expect, it } from "vitest";
import { bareVar, compileWhereFragment, gt, prop } from "./builder.js";
import { compileComprehensionFilterClause } from "./comprehension.js";

describe("compileComprehensionFilterClause", () => {
  it("emits IN $list WHERE with predicates", () => {
    const nums = [1, 2, 3];
    const c = compileComprehensionFilterClause("n", "nums", nums, [gt(bareVar("n"), 1)]);
    expect(c.text).toBe("n IN $nums WHERE n > $p0");
    expect(c.params).toEqual({ nums, p0: 1 });
  });

  it("supports property on comprehension item", () => {
    const rows = [{ id: "a" }];
    const c = compileComprehensionFilterClause("row", "rows", rows, [gt(prop("row", "score"), 10)]);
    expect(c.text).toBe("row IN $rows WHERE row.score > $p0");
    expect(c.params).toEqual({ rows, p0: 10 });
  });

  it("rejects empty predicates", () => {
    expect(() => compileComprehensionFilterClause("x", "xs", [], [])).toThrow(/at least one predicate/);
  });

  it("rejects param key collision", () => {
    expect(() =>
      compileComprehensionFilterClause("n", "p0", [], [gt(bareVar("n"), 0)]),
    ).toThrow(/collides/);
  });
});

describe("bareVar", () => {
  it("appears in WHERE fragment", () => {
    const { text } = compileWhereFragment([gt(bareVar("x"), 5)]);
    expect(text).toBe("x > $p0");
  });
});
