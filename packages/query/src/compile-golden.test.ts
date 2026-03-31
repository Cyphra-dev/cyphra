import { describe, expect, it } from "vitest";
import { cypher } from "./cypher.js";
import { bareVar, eq, exists, gt, prop, select } from "./builder.js";
import { compileCaseExpression } from "./caseExpr.js";
import { callSubqueryCompiled } from "./call.js";
import { concatCompiledCypher } from "./compose.js";
import { unionAllCompiled } from "./union.js";
import { compileComprehensionFilterClause } from "./comprehension.js";
import { compileLoadCsvFrom } from "./loadCsv.js";
import {
  compileCreate,
  compileCreateRelationship,
  compileDeleteRelationshipWhere,
  compileForeachDeleteRelationshipsFromPath,
  compileSetRelationshipWhere,
  compileForeachMergeSet,
  compileMergeRelationship,
  compileUnwindDetachDelete,
  compileUnwindMergeSet,
} from "./write.js";

/**
 * Regression guard: compiled Cypher text + param keys stay stable for common paths.
 */
describe("compile golden (Cypher + params)", () => {
  it("cypher template merges params", () => {
    const a = cypher`MATCH (n:Person) WHERE n.id = ${"x"} RETURN n`;
    expect(a.text).toMatchInlineSnapshot(`"MATCH (n:Person) WHERE n.id = $p0 RETURN n"`);
    expect(Object.keys(a.params)).toEqual(["p0"]);
  });

  it("unionAll prefixes param names per branch", () => {
    const left = cypher`RETURN ${1} AS n`;
    const right = cypher`RETURN ${2} AS n`;
    const u = unionAllCompiled([left, right]);
    expect(u.text.replace(/\s+/g, " ").trim()).toMatchInlineSnapshot(
      `"RETURN $u0_p0 AS n UNION ALL RETURN $u1_p0 AS n"`,
    );
    expect(Object.keys(u.params).sort()).toEqual(["u0_p0", "u1_p0"]);
  });

  it("concatCompiledCypher remaps trailing fragments", () => {
    const a = cypher`WHERE n.x = ${1}`;
    const b = cypher`AND n.y = ${2}`;
    const c = concatCompiledCypher([a, b]);
    expect(c.text.replace(/\s+/g, " ").trim()).toMatchInlineSnapshot(
      `"WHERE n.x = $p0 AND n.y = $f1_p0"`,
    );
    expect(Object.keys(c.params).sort()).toEqual(["f1_p0", "p0"]);
  });

  it("callSubqueryCompiled wraps and prefixes params", () => {
    const inner = cypher`RETURN ${42} AS n`;
    const c = callSubqueryCompiled(inner);
    expect(c.text.replace(/\s+/g, " ").trim()).toMatchInlineSnapshot(`"CALL { RETURN $c0_p0 AS n }"`);
    expect(Object.keys(c.params)).toEqual(["c0_p0"]);
  });

  it("compileCaseExpression shape", () => {
    const c = compileCaseExpression([{ when: [gt(bareVar("n"), 1)], then: "a" }], "b");
    expect(c.text).toMatchInlineSnapshot(`"CASE WHEN n > $b0_p0 THEN $t0 ELSE $e END"`);
    expect(Object.keys(c.params).sort()).toEqual(["b0_p0", "e", "t0"]);
  });

  it("compileComprehensionFilterClause shape", () => {
    const c = compileComprehensionFilterClause("n", "nums", [1, 2], [gt(bareVar("n"), 0)]);
    expect(c.text).toMatchInlineSnapshot(`"n IN $nums WHERE n > $p0"`);
    expect(Object.keys(c.params).sort()).toEqual(["nums", "p0"]);
  });

  it("compileLoadCsvFrom shape", () => {
    const c = compileLoadCsvFrom("https://x/y.csv", "row", {
      withHeaders: true,
      fieldTerminator: "pipe",
    });
    expect(c.text).toMatchInlineSnapshot(
      `"LOAD CSV WITH HEADERS FROM $csvUrl AS row FIELDTERMINATOR '|'"`,
    );
    expect(c.params).toEqual({ csvUrl: "https://x/y.csv" });
  });

  it("compileCreateRelationship shape", () => {
    const c = compileCreateRelationship("x", "r", "T", "y");
    expect(c.text).toMatchInlineSnapshot(`"CREATE (x)-[r:T]->(y)"`);
  });

  it("compileMergeRelationship shape", () => {
    const c = compileMergeRelationship("a", "r", "R", "b", { x: 1 });
    expect(c.text).toMatchInlineSnapshot(`"MERGE (a)-[r:R]->(b) SET r += $props"`);
    expect(c.params).toEqual({ props: { x: 1 } });
  });

  it("compileDeleteRelationshipWhere shape", () => {
    const c = compileDeleteRelationshipWhere("T", "r", [eq(prop("r", "id"), "x")]);
    expect(c.text).toMatchInlineSnapshot(`"MATCH ()-[r:T]->() WHERE r.id = $p0 DELETE r"`);
    expect(Object.keys(c.params)).toEqual(["p0"]);
  });

  it("compileSetRelationshipWhere shape", () => {
    const c = compileSetRelationshipWhere("T", "r", [eq(prop("r", "k"), 1)], { a: true });
    expect(c.text).toMatchInlineSnapshot(`"MATCH ()-[r:T]->() WHERE r.k = $p0 SET r += $props"`);
    expect(Object.keys(c.params).sort()).toEqual(["p0", "props"]);
  });

  it("compileCreate uses labeled parameters", () => {
    const c = compileCreate("Person", { name: "Ada" });
    expect(c.text).toMatchInlineSnapshot(`"CREATE (n:Person) SET n += $props"`);
    expect(c.params).toEqual({ props: { name: "Ada" } });
  });

  it("compileUnwindMergeSet shape", () => {
    const c = compileUnwindMergeSet("Person", "id", [{ id: "a", patch: { name: "A" } }]);
    expect(c.text).toMatchInlineSnapshot(
      `"UNWIND $rows AS row MERGE (n:Person { id: row.id }) SET n += coalesce(row.patch, {})"`,
    );
  });

  it("compileForeachMergeSet shape", () => {
    const c = compileForeachMergeSet("Person", "id", [{ id: "a", patch: { name: "A" } }]);
    expect(c.text).toMatchInlineSnapshot(
      `"FOREACH (row IN $rows | MERGE (n:Person { id: row.id }) SET n += coalesce(row.patch, {}))"`,
    );
  });

  it("compileForeachDeleteRelationshipsFromPath shape", () => {
    const c = compileForeachDeleteRelationshipsFromPath("p");
    expect(c.text).toMatchInlineSnapshot(`"FOREACH (r IN relationships(p) | DELETE r)"`);
  });

  it("compileUnwindDetachDelete shape", () => {
    const c = compileUnwindDetachDelete("Tag", "name", ["x"]);
    expect(c.text).toMatchInlineSnapshot(
      `"UNWIND $ids AS id MATCH (n:Tag) WHERE n.name = id DETACH DELETE n"`,
    );
  });

  it("SelectQuery exists + withOrderLimit param layout", () => {
    const q = select()
      .match("(u:User)")
      .withOrderLimit(["u"], [{ prop: prop("u", "score"), direction: "DESC" }], 5)
      .where(exists("(u)-[:OWNS]->(a:Asset)", eq(prop("a", "active"), true)))
      .returnStar();
    const { text, params } = q.toCypher();
    expect(text).toMatchInlineSnapshot(
      `"MATCH (u:User) WITH u ORDER BY u.score DESC LIMIT toInteger($p0) WHERE EXISTS { MATCH (u)-[:OWNS]->(a:Asset) WHERE a.active = $p1 } RETURN *"`,
    );
    expect(Object.keys(params).sort()).toEqual(["p0", "p1"]);
  });
});
