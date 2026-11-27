import { CYPHER_NODE, isCypherFragment, type CypherFragment } from "@cyphra/runtime";
import { describe, expect, it } from "vitest";
import { filterValue, listValue, nodesValue, scalarValue, statementShape } from "./cypher.js";
import { Fallback } from "./where.js";

/** The fragment's text, `$<value>` for each value and `<n>` for the node. */
function text(f: CypherFragment): string {
  expect(isCypherFragment(f)).toBe(true);
  return f.strings.reduce(
    (out, s, i) =>
      out +
      s +
      (i < f.values.length
        ? f.values[i] === CYPHER_NODE
          ? "<n>"
          : `$<${JSON.stringify(f.values[i], (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v))}>`
        : ""),
    "",
  );
}

const cypher = (statement: string, columnName = "x") => ({ statement, columnName });

describe("@cypher statements as engine expressions", () => {
  it("tells statements that aggregate and lone RETURNs (one row) apart", () => {
    expect(statementShape("RETURN this.title + '!' AS r")).toEqual({
      aggregates: false,
      oneRow: true,
      clashes: false,
    });
    expect(
      statementShape("RETURN EXISTS { MATCH (this)<-[:R]-(r) WHERE r.by = $jwt.sub } AS x"),
    ).toEqual({ aggregates: false, oneRow: true, clashes: false });
    expect(statementShape("MATCH (this)<-[:R]-(r) RETURN count(r) AS n")).toEqual({
      aggregates: true,
      oneRow: false,
      clashes: true,
    });
    // Names the engine's statements may use (a subquery expression cannot shadow them).
    expect(statementShape("MATCH (this)-->(m0) RETURN m0").clashes).toBe(true);
    expect(statementShape("MATCH (this)-->(m:Node) RETURN m.score0 AS x").clashes).toBe(false);
    expect(statementShape("MATCH (this)-->(s) RETURN DISTINCT s").oneRow).toBe(false);
    expect(statementShape("RETURN 1 AS x LIMIT 0").oneRow).toBe(false);
    expect(statementShape("RETURN 1 AS x UNION RETURN 2 AS x").oneRow).toBe(false);
    expect(statementShape("RETURN apoc.agg.first(this) AS x").aggregates).toBe(true);
    // Literals, comments, properties and parameters are not keywords.
    expect(
      statementShape("RETURN 'MATCH (n) count(n)' /* WITH */ + this.limit AS `count(`").oneRow,
    ).toBe(true);
    expect(statementShape("RETURN 'count(x)' AS x").aggregates).toBe(false);
  });

  it("binds $jwt and the arguments as values (Int as integers, missing as NULL)", () => {
    const c = cypher(
      "MATCH (b:Book) WHERE b.year >= $year AND b.by = $jwt.sub AND b.t = $t RETURN b",
      "b",
    );
    const args = [
      { name: "year", kind: "scalar", type: { name: "Int", list: false, required: true } },
      { name: "t", kind: "scalar", type: { name: "String", list: false, required: false } },
    ] as never;
    expect(text(nodesValue(c, args, { year: 2000 }, { sub: "u" }))).toBe(
      'COLLECT {\nCALL (<n>) {\n  WITH <n> AS this\n  MATCH (b:Book) WHERE b.year >= $<"2000n"> AND b.by = $<{"sub":"u"}>.sub AND b.t = NULL RETURN b\n}\nRETURN `b`\n}',
    );
    expect(() => nodesValue(cypher("RETURN $other AS x"), [], {}, {})).toThrow(Fallback);
    expect(() => nodesValue(cypher("RETURN '$jwt' AS x"), [], {}, {})).toThrow(Fallback);
  });

  it("uses each statement only where it evaluates like the compiler's", () => {
    const one = cypher("RETURN this.a AS x");
    const rows = cypher("MATCH (this)-->(m) RETURN m.a AS x");
    const count = cypher("MATCH (this)-->(m) RETURN count(m) AS x");
    expect(text(scalarValue(one, [], {}, {}))).toContain("head(COLLECT {");
    expect(() => scalarValue(rows, [], {}, {})).toThrow(Fallback);
    expect(() => scalarValue(count, [], {}, {})).toThrow(Fallback);
    expect(text(listValue(rows, [], {}, {}))).toContain(
      "UNWIND `x` AS cyphra_value_\nWITH cyphra_value_ WHERE cyphra_value_ IS NOT NULL",
    );
    expect(() => listValue(count, [], {}, {})).toThrow(Fallback);
    expect(text(filterValue(count, false, {}, true))).toContain("head(COLLECT {");
    expect(() => filterValue(count, false, {}, false)).toThrow(Fallback);
    expect(text(filterValue(rows, true, {}, false))).toContain(
      "UNWIND `x` AS cyphra_value_\nRETURN",
    );
  });
});
