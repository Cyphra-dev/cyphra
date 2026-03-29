import { describe, expect, it } from "vitest";
import { compileCypher, cypher } from "./cypher.js";

describe("compileCypher", () => {
  it("binds interpolated values as parameters", () => {
    const { text, params } = compileCypher(
      ["MATCH (u:User) WHERE u.id = ", " RETURN u"] as unknown as TemplateStringsArray,
      ["admin-1"],
    );
    expect(text).toBe("MATCH (u:User) WHERE u.id = $p0 RETURN u");
    expect(params).toEqual({ p0: "admin-1" });
  });

  it("does not embed malicious string as Cypher syntax", () => {
    const malicious = `x) RETURN 1 //`;
    const { text, params } = compileCypher(
      ["MATCH (u:User) WHERE u.id = ", " RETURN u"] as unknown as TemplateStringsArray,
      [malicious],
    );
    expect(text).toContain("$p0");
    expect(text).not.toContain(malicious);
    expect(params.p0).toBe(malicious);
  });

  it("cypher tag matches compileCypher", () => {
    const a = cypher`RETURN ${1} AS n`;
    const b = compileCypher(["RETURN ", " AS n"] as unknown as TemplateStringsArray, [1]);
    expect(a).toEqual(b);
  });
});
