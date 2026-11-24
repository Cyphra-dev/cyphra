import { describe, expect, it } from "vitest";
import { createdRelationshipTypes, rewriteForFalkorDB as rewrite, tokenize } from "./rewrite.js";
import { markVector } from "../cypher-values.js";

describe("rewriteForFalkorDB", () => {
  it("leaves statements without Neo4j-only constructs unchanged", () => {
    const text = "MATCH (n:`User`) WHERE n.`email` = $p0 RETURN n{.`id`} AS row";
    expect(rewrite(text, { p0: "a@x.io" })).toBe(text);
    expect(
      tokenize(text)
        .map((t) => t.text)
        .join(""),
    ).toBe(text);
  });

  it("maps element ids to FalkorDB ids, with an id seek for equality", () => {
    expect(rewrite("MATCH (a) WHERE elementId(a) = $p0 RETURN elementId(a) AS id")).toBe(
      "MATCH (a) WHERE id(a) = toInteger($p0) RETURN toString(id(a)) AS id",
    );
    expect(rewrite("MATCH (n) WHERE elementId(n) IN $p0 RETURN n")).toBe(
      "MATCH (n) WHERE toString(id(n)) IN $p0 RETURN n",
    );
    // Strings, quoted names and properties named elementId are not functions.
    expect(rewrite("RETURN 'elementId(x)' AS s, n.elementId AS e, `elementId` AS q")).toBe(
      "RETURN 'elementId(x)' AS s, n.elementId AS e, `elementId` AS q",
    );
  });

  it("turns subquery expressions in a WHERE into CALL subqueries, keeping seekable conjuncts", () => {
    expect(
      rewrite(
        "MATCH (n:`User`) WHERE (n.`email` = $p0) AND (EXISTS { MATCH (n)-[:`WROTE`]->(m0:`Post`) WHERE m0.`published` = $p1 }) RETURN n",
      ),
    ).toBe(
      "MATCH (n:`User`) WHERE (n.`email` = $p0) " +
        "CALL { WITH * MATCH (n)-[:`WROTE`]->(m0:`Post`) WHERE m0.`published` = $p1 WITH * LIMIT 1 RETURN count(*) > 0 AS __cyphra_e0 } " +
        "WITH * WHERE (__cyphra_e0) RETURN n",
    );
  });

  it("nests subqueries and collects COLLECT / COUNT results before the clause using them", () => {
    const out = rewrite(
      "MATCH (n:`User`) RETURN n{.`id`, `posts`: COLLECT { MATCH (n)-[r0:`WROTE`]->(m1:`Post`) WITH m1, r0 ORDER BY m1.`title` ASC RETURN m1{.`title`, `_count`: {`likes`: COUNT { MATCH (m1)<-[:`LIKED`]-(m2:`User`) }}} }} AS row",
    );
    expect(out).toBe(
      "MATCH (n:`User`) " +
        "CALL { WITH * MATCH (n)-[r0:`WROTE`]->(m1:`Post`) WITH m1, r0 ORDER BY m1.`title` ASC " +
        "CALL { WITH * MATCH (m1)<-[:`LIKED`]-(m2:`User`) RETURN count(*) AS __cyphra_n1 } " +
        "RETURN collect(m1{.`title`, `_count`: {`likes`: __cyphra_n1}}) AS __cyphra_c0 } " +
        "RETURN n{.`id`, `posts`: __cyphra_c0} AS row",
    );
  });

  it("hoists subqueries of a WITH projection whose WHERE needs none", () => {
    expect(
      rewrite(
        "MATCH (n:`Post`) WITH n, COUNT { MATCH (n)-->(m0) } AS k0 WHERE k0 > $p0 WITH n, k0 ORDER BY k0 ASC RETURN n",
      ),
    ).toBe(
      "MATCH (n:`Post`) CALL { WITH * MATCH (n)-->(m0) RETURN count(*) AS __cyphra_n0 } " +
        "WITH n, __cyphra_n0 AS k0 WHERE k0 > $p0 WITH n, k0 ORDER BY k0 ASC RETURN n",
    );
  });

  it("adds a WITH between an updating clause and a CALL", () => {
    expect(
      rewrite("CREATE (n:`A`) SET n.x = 1 RETURN n{`c`: COUNT { MATCH (n)-->(m) }} AS row"),
    ).toBe(
      "CREATE (n:`A`) SET n.x = 1 WITH * CALL { WITH * MATCH (n)-->(m) RETURN count(*) AS __cyphra_n0 } RETURN n{`c`: __cyphra_n0} AS row",
    );
  });

  it("expands map parameters of patterns, and writes vectors as vecf32", () => {
    const params = { p0: { id: "x", "odd key": 1, embedding: markVector([1, 0]) }, p1: [1, 2] };
    expect(rewrite("CREATE (n:`L` $p0) RETURN n", params)).toBe(
      "CREATE (n:`L` {id: $p0.id, `odd key`: $p0.`odd key`, embedding: vecf32($p0.embedding)}) RETURN n",
    );
    expect(
      rewrite("MATCH (n) SET n.e = $v, n += $m", { v: markVector([1]), m: { e: markVector([2]) } }),
    ).toBe("MATCH (n) SET n.e = vecf32($v), n += $m, n.e = vecf32($m.e)");
    expect(
      rewrite("UNWIND $rows AS row CREATE (n:`L`) SET n = row", {
        rows: [{ e: markVector([1]) }, { e: null }],
      }),
    ).toBe("UNWIND $rows AS row CREATE (n:`L`) SET n = row, n.e = vecf32(row.e)");
    // A plain list is not a vector.
    expect(rewrite("MATCH (n) SET n.l = $p1", params)).toBe("MATCH (n) SET n.l = $p1");
  });

  it("maps valueType() to typeOf()", () => {
    expect(rewrite("RETURN valueType(1) AS t")).toBe("RETURN typeOf(1) AS t");
  });

  it("refuses a subquery in the WHERE of an OPTIONAL MATCH", () => {
    expect(() =>
      rewrite("MATCH (a) OPTIONAL MATCH (a)-->(b) WHERE EXISTS { MATCH (b)-->() } RETURN b"),
    ).toThrow(/OPTIONAL MATCH/);
  });

  it("lists the relationship types a writing statement names", () => {
    expect(
      createdRelationshipTypes(
        "MATCH (a)-[:`A`|B*1..2]->(b) MERGE (a)-[r:`T x`]->(b) RETURN [(a)-[:C]-() | 1]",
      ),
    ).toEqual(["A", "B", "T x", "C"]);
    expect(createdRelationshipTypes("MATCH (a)-[:A]->(b) RETURN b")).toEqual([]);
  });
});
