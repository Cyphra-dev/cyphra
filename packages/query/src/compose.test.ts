import { describe, expect, it } from "vitest";
import { cypher } from "./cypher.js";
import { concatCompiledCypher } from "./compose.js";

describe("concatCompiledCypher", () => {
  it("returns a shallow copy for a single part", () => {
    const a = cypher`RETURN ${1} AS n`;
    const c = concatCompiledCypher([a]);
    expect(c).toEqual(a);
    expect(c.params).not.toBe(a.params);
  });

  it("joins parts and remaps params from index 1", () => {
    const a = cypher`MATCH (n:N) WHERE n.id = ${"x"}`;
    const b = cypher`RETURN ${2} AS k`;
    const c = concatCompiledCypher([a, b]);
    expect(c.text).toBe("MATCH (n:N) WHERE n.id = $p0 RETURN $f1_p0 AS k");
    expect(c.params).toEqual({ p0: "x", f1_p0: 2 });
  });

  it("accepts custom separator", () => {
    const c = concatCompiledCypher([cypher`RETURN 1`, cypher`RETURN 2`], { separator: "\n" });
    expect(c.text).toBe("RETURN 1\nRETURN 2");
  });

  it("rejects empty parts", () => {
    expect(() => concatCompiledCypher([])).toThrow(/at least one part/);
  });
});
