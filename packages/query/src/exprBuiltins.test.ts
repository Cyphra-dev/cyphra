import { describe, expect, it } from "vitest";
import { bareVar, prop } from "./builder.js";
import {
  absExpr,
  avgExpr,
  ceilExpr,
  collectExpr,
  countDistinct,
  countStar,
  countVariable,
  floorExpr,
  maxExpr,
  minExpr,
  randExpr,
  roundExpr,
  sizeExpr,
  sqrtExpr,
  sumExpr,
  toLowerExpr,
  toUpperExpr,
} from "./exprBuiltins.js";

describe("exprBuiltins", () => {
  it("countStar and countVariable", () => {
    expect(countStar()).toBe("count(*)");
    expect(countVariable("n")).toBe("count(n)");
    expect(() => countVariable("1n")).toThrow(/invalid identifier/);
  });

  it("countDistinct and aggregates on prop", () => {
    const p = prop("n", "v");
    expect(countDistinct(p)).toBe("count(DISTINCT n.v)");
    expect(sumExpr(p)).toBe("sum(n.v)");
    expect(avgExpr(p)).toBe("avg(n.v)");
    expect(minExpr(p)).toBe("min(n.v)");
    expect(maxExpr(p)).toBe("max(n.v)");
    expect(collectExpr(p)).toBe("collect(n.v)");
  });

  it("bareVar in countDistinct", () => {
    expect(countDistinct(bareVar("x"))).toBe("count(DISTINCT x)");
  });

  it("size, toLower, toUpper", () => {
    expect(sizeExpr(prop("n", "tags"))).toBe("size(n.tags)");
    expect(toLowerExpr(prop("u", "email"))).toBe("toLower(u.email)");
    expect(toUpperExpr(prop("u", "code"))).toBe("toUpper(u.code)");
  });

  it("math on prop and rand", () => {
    const x = prop("n", "x");
    expect(absExpr(x)).toBe("abs(n.x)");
    expect(ceilExpr(x)).toBe("ceil(n.x)");
    expect(floorExpr(x)).toBe("floor(n.x)");
    expect(roundExpr(x)).toBe("round(n.x)");
    expect(sqrtExpr(x)).toBe("sqrt(n.x)");
    expect(randExpr()).toBe("rand()");
  });
});
