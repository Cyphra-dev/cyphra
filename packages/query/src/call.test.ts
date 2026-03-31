import { describe, expect, it } from "vitest";
import { cypher } from "./cypher.js";
import { callSubqueryCompiled, callSubqueryCompiledWith } from "./call.js";
import { select } from "./builder.js";

describe("callSubqueryCompiled", () => {
  it("wraps inner query and prefixes params", () => {
    const inner = cypher`MATCH (n:N) WHERE n.id = ${"x"} RETURN n`;
    const c = callSubqueryCompiled(inner);
    expect(c.text).toBe("CALL { MATCH (n:N) WHERE n.id = $c0_p0 RETURN n }");
    expect(c.params).toEqual({ c0_p0: "x" });
  });

  it("uses branchIndex for param namespace", () => {
    const inner = cypher`RETURN ${1} AS n`;
    const a = callSubqueryCompiled(inner, { branchIndex: 0 });
    const b = callSubqueryCompiled(inner, { branchIndex: 1 });
    expect(a.text).toContain("$c0_p0");
    expect(b.text).toContain("$c1_p0");
    expect(a.params).toEqual({ c0_p0: 1 });
    expect(b.params).toEqual({ c1_p0: 1 });
  });

  it("works with SelectQuery inner", () => {
    const inner = select().match("(m:M)").returnStar().toCypher();
    const c = callSubqueryCompiled(inner);
    expect(c.text).toBe("CALL { MATCH (m:M) RETURN * }");
    expect(c.params).toEqual({});
  });

  it("rejects invalid branchIndex", () => {
    expect(() => callSubqueryCompiled(cypher`RETURN 1 AS n`, { branchIndex: -1 })).toThrow(/branchIndex/);
    expect(() => callSubqueryCompiled(cypher`RETURN 1 AS n`, { branchIndex: 1.5 })).toThrow(/branchIndex/);
  });

  it("callSubqueryCompiledWith prefixes WITH for correlation", () => {
    const inner = cypher`MATCH (u)-[:T]->(v) WHERE v.id = ${1} RETURN v`;
    const c = callSubqueryCompiledWith(["u"], inner);
    expect(c.text).toBe("CALL { WITH u MATCH (u)-[:T]->(v) WHERE v.id = $c0_p0 RETURN v }");
    expect(c.params).toEqual({ c0_p0: 1 });
  });

  it("callSubqueryCompiledWith empty import matches plain callSubqueryCompiled", () => {
    const inner = cypher`RETURN ${2} AS x`;
    expect(callSubqueryCompiledWith([], inner)).toEqual(callSubqueryCompiled(inner));
  });

  it("callSubqueryCompiledWith rejects bad variable names", () => {
    expect(() => callSubqueryCompiledWith(["1a"], cypher`RETURN 1`)).toThrow(/import variable/);
  });
});
