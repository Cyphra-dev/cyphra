import { describe, expect, it } from "vitest";
import {
  appendFinish,
  compileCreateConstraintNodeUnique,
  compileCreateConstraintRelationshipUnique,
  compileCreateRangeIndexNode,
  compileCreateRangeIndexRelationship,
  compileLetClause,
  compileMatchFilterReturn,
  compileSequentialNext,
  compileWhenThenElse,
} from "./cypher25.js";

describe("cypher25", () => {
  it("compileLetClause remaps params per binding", () => {
    expect(
      compileLetClause([
        { variable: "a", expression: { text: "c.age > $p0", params: { p0: 30 } } },
        { variable: "b", expression: { text: "c.score * $p0", params: { p0: 2 } } },
      ]),
    ).toEqual({
      text: "LET a = c.age > $l0_p0, b = c.score * $l1_p0",
      params: { l0_p0: 30, l1_p0: 2 },
    });
  });

  it("appendFinish", () => {
    expect(appendFinish({ text: "MATCH (p:Person)", params: {} })).toEqual({
      text: "MATCH (p:Person) FINISH",
      params: {},
    });
  });

  it("compileSequentialNext remaps rhs params", () => {
    const left = { text: "MATCH (n) RETURN n AS x", params: {} };
    const right = { text: "RETURN x AS y WHERE y.id = $p0", params: { p0: 1 } };
    expect(compileSequentialNext(left, right)).toEqual({
      text: "MATCH (n) RETURN n AS x NEXT RETURN x AS y WHERE y.id = $next_p0",
      params: { next_p0: 1 },
    });
  });

  it("compileWhenThenElse", () => {
    expect(
      compileWhenThenElse(
        [
          { predicate: "false", then: { text: "RETURN 1 AS x", params: {} } },
          { predicate: "true", then: { text: "RETURN 2 AS x", params: {} } },
        ],
        { text: "RETURN 3 AS x", params: {} },
      ),
    ).toEqual({
      text: "WHEN false THEN RETURN 1 AS x WHEN true THEN RETURN 2 AS x ELSE RETURN 3 AS x",
      params: {},
    });
  });

  it("compileMatchFilterReturn", () => {
    expect(
      compileMatchFilterReturn(
        { text: "MATCH (n)", params: {} },
        { text: "n.age < $p0", params: { p0: 35 } },
        { text: "RETURN n.name AS name", params: {} },
      ),
    ).toEqual({
      text: "MATCH (n) FILTER n.age < $f_p0 RETURN n.name AS name",
      params: { f_p0: 35 },
    });
  });

  it("compileCreateConstraintNodeUnique", () => {
    expect(
      compileCreateConstraintNodeUnique({
        constraintName: "c_person_name",
        variable: "p",
        label: "Person",
        property: "name",
        ifNotExists: true,
      }),
    ).toEqual({
      text: "CREATE CONSTRAINT c_person_name IF NOT EXISTS FOR (p:Person) REQUIRE p.name IS UNIQUE",
      params: {},
    });
  });

  it("compileCreateConstraintRelationshipUnique", () => {
    expect(
      compileCreateConstraintRelationshipUnique({
        constraintName: "r_k_unique",
        relVariable: "r",
        relType: "KNOWS",
        property: "since",
        ifNotExists: true,
      }),
    ).toEqual({
      text: "CREATE CONSTRAINT r_k_unique IF NOT EXISTS FOR ()-[r:KNOWS]-() REQUIRE r.since IS UNIQUE",
      params: {},
    });
  });

  it("compileCreateRangeIndexNode and Relationship", () => {
    expect(
      compileCreateRangeIndexNode({
        indexName: "n_x",
        variable: "n",
        label: "N",
        property: "x",
      }),
    ).toEqual({
      text: "CREATE RANGE INDEX n_x FOR (n:N) ON (n.x)",
      params: {},
    });
    expect(
      compileCreateRangeIndexRelationship({
        indexName: "r_x",
        relVariable: "r",
        relType: "R",
        property: "p",
      }),
    ).toEqual({
      text: "CREATE RANGE INDEX r_x FOR ()-[r:R]-() ON (r.p)",
      params: {},
    });
  });
});
