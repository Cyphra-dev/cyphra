import { describe, expect, it } from "vitest";
import { formatCliError } from "./formatCliError.js";

describe("formatCliError", () => {
  it("returns non-Error values as string", () => {
    expect(formatCliError("x")).toBe("x");
    expect(formatCliError(null)).toBe("null");
  });

  it("prints Error.message", () => {
    expect(formatCliError(new Error("top"))).toBe("top");
  });

  it("appends Caused by lines for a cause chain", () => {
    const inner = new Error("Neo4j: SyntaxException");
    const outer = new Error("DDL failed (CREATE …)", { cause: inner });
    const text = formatCliError(outer);
    expect(text).toContain("DDL failed");
    expect(text).toContain("Caused by: Neo4j: SyntaxException");
  });

  it("limits cause depth", () => {
    let e: Error = new Error("d0");
    for (let i = 1; i <= 10; i += 1) {
      e = new Error(`d${i}`, { cause: e });
    }
    const text = formatCliError(e, 2);
    const caused = text.split("Caused by:").length - 1;
    expect(caused).toBe(2);
  });
});
