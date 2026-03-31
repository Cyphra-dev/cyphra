import { describe, expect, it } from "vitest";
import { lengthPath, nodesPath, relationshipsPath } from "./pathExpr.js";

describe("pathExpr", () => {
  it("emits path builtins for a valid variable", () => {
    expect(lengthPath("p")).toBe("length(p)");
    expect(nodesPath("p")).toBe("nodes(p)");
    expect(relationshipsPath("p")).toBe("relationships(p)");
  });

  it("rejects invalid identifiers", () => {
    expect(() => lengthPath("0p")).toThrow(/invalid path variable/);
  });
});
