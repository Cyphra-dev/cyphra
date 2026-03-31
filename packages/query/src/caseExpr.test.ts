import { describe, expect, it } from "vitest";
import { bareVar, gt, lt } from "./builder.js";
import { compileCaseExpression } from "./caseExpr.js";

describe("compileCaseExpression", () => {
  it("builds CASE with remapped WHEN params and THEN/ELSE params", () => {
    const c = compileCaseExpression(
      [
        { when: [gt(bareVar("x"), 0)], then: "positive" },
        { when: [lt(bareVar("x"), 0)], then: "negative" },
      ],
      "zero",
    );
    expect(c.text).toBe("CASE WHEN x > $b0_p0 THEN $t0 WHEN x < $b1_p0 THEN $t1 ELSE $e END");
    expect(c.params).toEqual({
      t0: "positive",
      b0_p0: 0,
      t1: "negative",
      b1_p0: 0,
      e: "zero",
    });
  });

  it("rejects empty branches", () => {
    expect(() => compileCaseExpression([], "x")).toThrow(/at least one WHEN/);
    expect(() => compileCaseExpression([{ when: [], then: 1 }], 0)).toThrow(
      /at least one WHEN predicate/,
    );
  });
});
