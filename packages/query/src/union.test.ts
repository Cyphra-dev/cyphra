import { describe, expect, it } from "vitest";
import { cypher } from "./cypher.js";
import { unionAllCompiled } from "./union.js";

describe("unionAllCompiled", () => {
  it("namespaces parameters per branch", () => {
    const a = cypher`MATCH (u:User { id: ${"u1"} }) RETURN u.id AS id`;
    const b = cypher`MATCH (p:Post { slug: ${"s1"} }) RETURN p.slug AS id`;
    const u = unionAllCompiled([a, b]);
    expect(u.text).toContain(" UNION ALL ");
    expect(u.text).toContain("$u0_p0");
    expect(u.text).toContain("$u1_p0");
    expect(u.params.u0_p0).toBe("u1");
    expect(u.params.u1_p0).toBe("s1");
  });
});
