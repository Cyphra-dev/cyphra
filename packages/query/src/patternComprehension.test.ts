import { describe, expect, it } from "vitest";
import { eq, prop } from "./builder.js";
import { compilePatternComprehension } from "./patternComprehension.js";

describe("compilePatternComprehension", () => {
  it("emits pattern without WHERE", () => {
    const c = compilePatternComprehension({
      pattern: "(a:A)-[:R]->(b:B)",
      projectionExpression: "b.id",
    });
    expect(c.text).toBe("[(a:A)-[:R]->(b:B) | b.id]");
    expect(c.params).toEqual({});
  });

  it("emits parameterized WHERE", () => {
    const c = compilePatternComprehension({
      pattern: "(n)-[:X]->(m)",
      where: [eq(prop("m", "k"), "v")],
      projectionExpression: "m",
    });
    expect(c.text).toBe("[(n)-[:X]->(m) WHERE m.k = $p0 | m]");
    expect(c.params).toEqual({ p0: "v" });
  });

  it("rejects empty pattern or projection", () => {
    expect(() =>
      compilePatternComprehension({ pattern: "  ", projectionExpression: "x" }),
    ).toThrow(/pattern/);
    expect(() =>
      compilePatternComprehension({ pattern: "(n)", projectionExpression: "" }),
    ).toThrow(/projectionExpression/);
  });
});
