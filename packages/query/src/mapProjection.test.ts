import { describe, expect, it } from "vitest";
import { compileMapProjection } from "./mapProjection.js";

describe("compileMapProjection", () => {
  it("emits property selections", () => {
    expect(compileMapProjection("n", ["name"])).toBe("n { .name }");
    expect(compileMapProjection("person", ["id", "email"])).toBe("person { .id, .email }");
  });

  it("rejects invalid input", () => {
    expect(() => compileMapProjection("", ["a"])).toThrow(/variable/);
    expect(() => compileMapProjection("n", [])).toThrow(/at least one property/);
    expect(() => compileMapProjection("n", ["ok", "bad-name"])).toThrow(/properties/);
  });
});
