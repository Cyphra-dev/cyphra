import { CYPHER_NODE, isCypherFragment, type CypherFragment } from "@cyphra/runtime";
import { describe, expect, it } from "vitest";
import {
  expressionList,
  expressionValue,
  filterNodes,
  filterValue,
  listCall,
  nodesCall,
  rootNodesCall,
  rootScalarStatement,
  scalarCall,
  statementShape,
  statementVariables,
} from "./cypher.js";
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
    // Names an engine write statement may use (a subquery cannot shadow them).
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
    expect(text(nodesCall(c, args, { year: 2000 }, { sub: "u" }))).toBe(
      'CALL (<n>) {\n  WITH <n> AS this\n  MATCH (b:Book) WHERE b.year >= $<"2000n"> AND b.by = $<{"sub":"u"}>.sub AND b.t = NULL RETURN b\n}\nRETURN `b`',
    );
    expect(() => nodesCall(cypher("RETURN $other AS x"), [], {}, {})).toThrow(Fallback);
    expect(() => nodesCall(cypher("RETURN '$jwt' AS x"), [], {}, {})).toThrow(Fallback);
  });

  it("runs statements as CALL clauses, marks those that aggregate", () => {
    const rows = cypher("MATCH (this)-->(m) RETURN m.a AS x");
    const count = cypher("MATCH (this)-->(m) RETURN count(m) AS x");
    expect(text(scalarCall(rows, [], {}, {}))).toBe(
      "CALL (<n>) {\n  WITH <n> AS this\n  MATCH (this)-->(m) RETURN m.a AS x\n}\nRETURN `x`",
    );
    expect(text(listCall(rows, [], {}, {}))).toContain(
      "\nUNWIND `x` AS cyphra_value_\nRETURN collect(cyphra_value_)",
    );
    expect(text(scalarCall(count, [], {}, {}))).toMatch(
      /^\/\* cyphra:aggregates \*\/\nCALL \(<n>\)/,
    );
    expect(text(filterValue(count, false, {}))).toContain("cyphra:aggregates");
    expect(text(filterValue(rows, true, {}))).toContain("UNWIND `x` AS cyphra_value_\nRETURN");
    expect(text(filterNodes(rows, {}))).toBe(text(scalarCall(rows, [], {}, {})));
  });

  it("runs root statements on their own", () => {
    const c = cypher("MATCH (b:Book) RETURN b.title AS t", "t");
    expect(text(rootScalarStatement(c, [], {}, {}, true))).toBe(
      "CALL () {\n  MATCH (b:Book) RETURN b.title AS t\n}\nUNWIND `t` AS cyphra_value_\nRETURN cyphra_value_ AS value",
    );
    expect(text(rootScalarStatement(c, [], {}, {}, false))).toContain("\nRETURN `t` AS value");
    expect(text(rootNodesCall(cypher("MATCH (b:Book) RETURN b", "b"), [], {}, {}))).toBe(
      "CALL () {\n  MATCH (b:Book) RETURN b\n}\nRETURN `b`",
    );
  });

  it("keeps mutation projections to expressions that evaluate like the compiler's", () => {
    const one = cypher("RETURN this.a AS x");
    const rows = cypher("MATCH (this)-->(m) RETURN m.a AS x");
    const count = cypher("MATCH (this)-->(m) RETURN count(m) AS x");
    expect(text(expressionValue(one, [], {}, {}))).toContain("head(COLLECT {");
    expect(() => expressionValue(rows, [], {}, {})).toThrow(Fallback);
    expect(() => expressionValue(count, [], {}, {})).toThrow(Fallback);
    expect(() => expressionValue(cypher("MATCH (this)-->(n) RETURN n.a AS x"), [], {}, {})).toThrow(
      Fallback,
    );
    expect(text(expressionList(rows, [], {}, {}))).toContain(
      "UNWIND `x` AS cyphra_value_\nWITH cyphra_value_ WHERE cyphra_value_ IS NOT NULL",
    );
    expect(() => expressionList(count, [], {}, {})).toThrow(Fallback);
  });

  it("collects every name the statements use", () => {
    const names = statementVariables({
      nodes: [
        {
          attributes: [{ cypher: cypher("MATCH (this)<-[:R]-(r) RETURN count(r) AS n // m0") }],
          cypherNodes: [{ cypher: cypher("MATCH (this)-->(`b c`) RETURN 'x y' AS score") }],
        },
      ],
      properties: new Map(),
      query: { fields: [] },
      mutation: { fields: [] },
    } as never);
    expect([...names].sort()).toEqual(
      ["AS", "MATCH", "R", "RETURN", "_", "count", "n", "r", "score", "this"].sort(),
    );
  });
});
