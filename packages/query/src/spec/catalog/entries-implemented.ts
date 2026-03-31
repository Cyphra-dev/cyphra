import {
  bareVar,
  between,
  eq,
  exists,
  gt,
  gte,
  inList,
  isNull,
  isNotNull,
  lt,
  lte,
  neq,
  node,
  not,
  or,
  prop,
  startsWith,
  endsWith,
  contains,
  matches,
  rel,
  select,
} from "../../builder.js";
import { callSubqueryCompiled, callSubqueryCompiledWith } from "../../call.js";
import { compileCaseExpression } from "../../caseExpr.js";
import { concatCompiledCypher } from "../../compose.js";
import { compileComprehensionFilterClause } from "../../comprehension.js";
import { compileCypher, cypher, remapCompiledCypherParamKeys } from "../../cypher.js";
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
} from "../../cypher25.js";
import {
  absExpr,
  avgExpr,
  ceilExpr,
  collectExpr,
  countDistinct,
  countStar,
  countVariable,
  floorExpr,
  maxExpr,
  minExpr,
  randExpr,
  roundExpr,
  sizeExpr,
  sqrtExpr,
  sumExpr,
  toLowerExpr,
  toUpperExpr,
} from "../../exprBuiltins.js";
import {
  matchHintUsingPointIndex,
  matchHintUsingRangeIndex,
  matchHintUsingTextIndex,
} from "../../hints.js";
import { compileLoadCsvFrom } from "../../loadCsv.js";
import { lengthPath, nodesPath, relationshipsPath } from "../../pathExpr.js";
import { usingPeriodicCommitClause } from "../../periodicCommit.js";
import { compilePointCartesian2D, compilePointWGS84 } from "../../spatialPoint.js";
import {
  currentDateExpr,
  currentDateTimeExpr,
  currentLocalDateTimeExpr,
  currentLocalTimeExpr,
  currentTimeExpr,
} from "../../temporalExpr.js";
import {
  compileCreateLinkedNodes,
  compileRootOptionalOutgoingSelect,
} from "../../graphQuery.js";
import { compileMapProjection } from "../../mapProjection.js";
import { compilePatternComprehension } from "../../patternComprehension.js";
import {
  compileDenyAccessOnDatabase,
  compileGrantRole,
  compileRevokeRole,
} from "../../securityAdmin.js";
import { compileShowAdmin } from "../../showAdmin.js";
import { compileCountBlock, compileExistsBlock } from "../../subqueryExpression.js";
import { compileShowTransactions, compileTerminateTransactions } from "../../transactionAdmin.js";
import { unionAllCompiled, unionCompiled } from "../../union.js";
import {
  compileCreate,
  compileCreateRelationship,
  compileCreateRelationshipIn,
  compileDeleteRelationshipWhere,
  compileDeleteWhere,
  compileDetachDeleteWhere,
  compileForeachDeleteRelationshipsFromPath,
  compileForeachMergeSet,
  compileMergeRelationship,
  compileMergeRelationshipIn,
  compileMergeSet,
  compileRemoveProperties,
  compileSetRelationshipWhere,
  compileUnwindDetachDelete,
  compileUnwindMergeSet,
} from "../../write.js";
import { normalizeCypher } from "../normalizeCypher.js";
import type { CatalogEntryImplemented } from "./types.js";

function norm(text: string): string {
  return normalizeCypher(text);
}

/** Golden rows: DSL → CompiledCypher must match Neo4j Cypher Manual–aligned expectations. */
export const implementedCatalogEntries: readonly CatalogEntryImplemented[] = [
  {
    status: "implemented",
    id: "cypher-template-param",
    manualSection: "Parameters / expressions",
    compile: () => cypher`MATCH (n:Person) WHERE n.id = ${"x"} RETURN n`,
    expectedText: norm("MATCH (n:Person) WHERE n.id = $p0 RETURN n"),
    expectedParams: { p0: "x" },
  },
  {
    status: "implemented",
    id: "cypher-remap-param-keys",
    manualSection: "Parameters (composition)",
    compile: () => remapCompiledCypherParamKeys(cypher`RETURN ${1} AS x`, "x_"),
    expectedText: norm("RETURN $x_p0 AS x"),
    expectedParams: { x_p0: 1 },
  },
  {
    status: "implemented",
    id: "union-all-compiled",
    manualSection: "UNION / UNION ALL",
    compile: () => unionAllCompiled([cypher`RETURN ${1} AS n`, cypher`RETURN ${2} AS n`]),
    expectedText: norm("RETURN $u0_p0 AS n UNION ALL RETURN $u1_p0 AS n"),
    expectedParams: { u0_p0: 1, u1_p0: 2 },
  },
  {
    status: "implemented",
    id: "union-compiled-distinct",
    manualSection: "UNION / UNION ALL",
    compile: () => unionCompiled([cypher`RETURN ${1} AS n`, cypher`RETURN ${2} AS n`]),
    expectedText: norm("RETURN $u0_p0 AS n UNION RETURN $u1_p0 AS n"),
    expectedParams: { u0_p0: 1, u1_p0: 2 },
  },
  {
    status: "implemented",
    id: "concat-compiled-cypher",
    manualSection: "Query composition",
    compile: () => concatCompiledCypher([cypher`WHERE n.x = ${1}`, cypher`AND n.y = ${2}`]),
    expectedText: norm("WHERE n.x = $p0 AND n.y = $f1_p0"),
    expectedParams: { p0: 1, f1_p0: 2 },
  },
  {
    status: "implemented",
    id: "call-subquery-compiled",
    manualSection: "CALL subquery",
    compile: () => callSubqueryCompiled(cypher`RETURN ${42} AS n`),
    expectedText: norm("CALL { RETURN $c0_p0 AS n }"),
    expectedParams: { c0_p0: 42 },
  },
  {
    status: "implemented",
    id: "subquery-correlated",
    manualSection: "CALL { } correlated",
    compile: () =>
      callSubqueryCompiledWith(
        ["u"],
        cypher`MATCH (u)-[:WROTE]->(p:Post) RETURN p AS post`,
      ),
    expectedText: norm("CALL { WITH u MATCH (u)-[:WROTE]->(p:Post) RETURN p AS post }"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "expr-map-projection",
    manualSection: "Map projection",
    compile: () => ({ text: compileMapProjection("n", ["name", "email"]), params: {} }),
    expectedText: norm("n { .name, .email }"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "expr-pattern-comprehension",
    manualSection: "Pattern comprehension",
    compile: () =>
      compilePatternComprehension({
        pattern: "(n:N)-[:REL]->(m:M)",
        where: [eq(prop("m", "active"), true)],
        projectionExpression: "m.name",
      }),
    expectedText: norm("[(n:N)-[:REL]->(m:M) WHERE m.active = $p0 | m.name]"),
    expectedParams: { p0: true },
  },
  {
    status: "implemented",
    id: "expr-pattern-comprehension-no-where",
    manualSection: "Pattern comprehension",
    compile: () =>
      compilePatternComprehension({
        pattern: "(a:A)-[:R]->(b:B)",
        projectionExpression: "b.id",
      }),
    expectedText: norm("[(a:A)-[:R]->(b:B) | b.id]"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "case-expression-simple",
    manualSection: "CASE expression",
    compile: () => compileCaseExpression([{ when: [gt(bareVar("n"), 1)], then: "a" }], "b"),
    expectedText: norm("CASE WHEN n > $b0_p0 THEN $t0 ELSE $e END"),
    expectedParams: { b0_p0: 1, t0: "a", e: "b" },
  },
  {
    status: "implemented",
    id: "list-comprehension-filter-clause",
    manualSection: "Lists / comprehensions",
    compile: () => compileComprehensionFilterClause("n", "nums", [1, 2], [gt(bareVar("n"), 0)]),
    expectedText: norm("n IN $nums WHERE n > $p0"),
    expectedParams: { nums: [1, 2], p0: 0 },
  },
  {
    status: "implemented",
    id: "load-csv-with-headers-pipe",
    manualSection: "LOAD CSV",
    compile: () =>
      compileLoadCsvFrom("https://x/y.csv", "row", {
        withHeaders: true,
        fieldTerminator: "pipe",
      }),
    expectedText: norm("LOAD CSV WITH HEADERS FROM $csvUrl AS row FIELDTERMINATOR '|'"),
    expectedParams: { csvUrl: "https://x/y.csv" },
  },
  {
    status: "implemented",
    id: "load-csv-default-headers",
    manualSection: "LOAD CSV",
    compile: () => compileLoadCsvFrom("file:///tmp/x.csv", "row"),
    expectedText: norm("LOAD CSV WITH HEADERS FROM $csvUrl AS row"),
    expectedParams: { csvUrl: "file:///tmp/x.csv" },
  },
  {
    status: "implemented",
    id: "create-relationship-directed",
    manualSection: "CREATE",
    compile: () => compileCreateRelationship("x", "r", "T", "y"),
    expectedText: norm("CREATE (x)-[r:T]->(y)"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "merge-relationship-with-props",
    manualSection: "MERGE",
    compile: () => compileMergeRelationship("a", "r", "R", "b", { x: 1 }),
    expectedText: norm("MERGE (a)-[r:R]->(b) SET r += $props"),
    expectedParams: { props: { x: 1 } },
  },
  {
    status: "implemented",
    id: "merge-relationship-incoming",
    manualSection: "MERGE",
    compile: () => compileMergeRelationshipIn("b", "r", "R", "a", { k: 2 }),
    expectedText: norm("MERGE (b)<-[r:R]-(a) SET r += $props"),
    expectedParams: { props: { k: 2 } },
  },
  {
    status: "implemented",
    id: "create-relationship-incoming",
    manualSection: "CREATE",
    compile: () => compileCreateRelationshipIn("b", "r", "T", "a"),
    expectedText: norm("CREATE (b)<-[r:T]-(a)"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "delete-relationship-where",
    manualSection: "DELETE",
    compile: () => compileDeleteRelationshipWhere("T", "r", [eq(prop("r", "id"), "x")]),
    expectedText: norm("MATCH ()-[r:T]->() WHERE r.id = $p0 DELETE r"),
    expectedParams: { p0: "x" },
  },
  {
    status: "implemented",
    id: "set-relationship-where",
    manualSection: "SET",
    compile: () => compileSetRelationshipWhere("T", "r", [eq(prop("r", "k"), 1)], { a: true }),
    expectedText: norm("MATCH ()-[r:T]->() WHERE r.k = $p0 SET r += $props"),
    expectedParams: { p0: 1, props: { a: true } },
  },
  {
    status: "implemented",
    id: "create-node-labeled",
    manualSection: "CREATE",
    compile: () => compileCreate("Person", { name: "Ada" }),
    expectedText: norm("CREATE (n:Person) SET n += $props"),
    expectedParams: { props: { name: "Ada" } },
  },
  {
    status: "implemented",
    id: "merge-node-set",
    manualSection: "MERGE",
    compile: () => compileMergeSet("Person", "id", "u1", { name: "Bob" }),
    expectedText: norm("MERGE (n:Person { id: $keyVal }) SET n += $props"),
    expectedParams: { keyVal: "u1", props: { name: "Bob" } },
  },
  {
    status: "implemented",
    id: "merge-node-on-create-on-match",
    manualSection: "ON CREATE / ON MATCH",
    compile: () =>
      compileMergeSet("Person", "id", "u1", {}, { onCreate: { name: "New" }, onMatch: { touched: true } }),
    expectedText: norm(
      "MERGE (n:Person { id: $keyVal }) ON CREATE SET n += $onCreateProps ON MATCH SET n += $onMatchProps",
    ),
    expectedParams: {
      keyVal: "u1",
      onCreateProps: { name: "New" },
      onMatchProps: { touched: true },
    },
  },
  {
    status: "implemented",
    id: "hint-range-index-node",
    manualSection: "USING RANGE INDEX",
    compile: () => ({ text: matchHintUsingRangeIndex("p", "Pioneer", ["born"]), params: {} }),
    expectedText: norm("USING RANGE INDEX p:Pioneer(born)"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "hint-text-index-node",
    manualSection: "USING TEXT INDEX",
    compile: () => ({ text: matchHintUsingTextIndex("c", "Country", ["name"]), params: {} }),
    expectedText: norm("USING TEXT INDEX c:Country(name)"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "hint-point-index-node",
    manualSection: "USING POINT INDEX",
    compile: () => ({ text: matchHintUsingPointIndex("l", "Location", ["coord"]), params: {} }),
    expectedText: norm("USING POINT INDEX l:Location(coord)"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "unwind-merge-set-batch",
    manualSection: "UNWIND / MERGE",
    compile: () => compileUnwindMergeSet("Person", "id", [{ id: "a", patch: { name: "A" } }]),
    expectedText: norm(
      "UNWIND $rows AS row MERGE (n:Person { id: row.id }) SET n += coalesce(row.patch, {})",
    ),
    expectedParams: { rows: [{ id: "a", patch: { name: "A" } }] },
  },
  {
    status: "implemented",
    id: "foreach-merge-set-batch",
    manualSection: "FOREACH",
    compile: () => compileForeachMergeSet("Person", "id", [{ id: "a", patch: { name: "A" } }]),
    expectedText: norm(
      "FOREACH (row IN $rows | MERGE (n:Person { id: row.id }) SET n += coalesce(row.patch, {}))",
    ),
    expectedParams: { rows: [{ id: "a", patch: { name: "A" } }] },
  },
  {
    status: "implemented",
    id: "foreach-delete-relationships-from-path",
    manualSection: "FOREACH / DELETE",
    compile: () => compileForeachDeleteRelationshipsFromPath("p"),
    expectedText: norm("FOREACH (r IN relationships(p) | DELETE r)"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "unwind-detach-delete-batch",
    manualSection: "UNWIND / DETACH DELETE",
    compile: () => compileUnwindDetachDelete("Tag", "name", ["x"]),
    expectedText: norm("UNWIND $ids AS id MATCH (n:Tag) WHERE n.name = id DETACH DELETE n"),
    expectedParams: { ids: ["x"] },
  },
  {
    status: "implemented",
    id: "detach-delete-where",
    manualSection: "DETACH DELETE",
    compile: () => compileDetachDeleteWhere("X", "n", [eq(prop("n", "id"), 9)]),
    expectedText: norm("MATCH (n:X) WHERE n.id = $p0 DETACH DELETE n"),
    expectedParams: { p0: 9 },
  },
  {
    status: "implemented",
    id: "delete-where",
    manualSection: "DELETE",
    compile: () => compileDeleteWhere("X", "n", [eq(prop("n", "id"), 9)]),
    expectedText: norm("MATCH (n:X) WHERE n.id = $p0 DELETE n"),
    expectedParams: { p0: 9 },
  },
  {
    status: "implemented",
    id: "remove-node-properties",
    manualSection: "REMOVE",
    compile: () => compileRemoveProperties("Person", "n", [eq(prop("n", "id"), 1)], ["legacy"]),
    expectedText: norm("MATCH (n:Person) WHERE n.id = $p0 REMOVE n.legacy"),
    expectedParams: { p0: 1 },
  },
  {
    status: "implemented",
    id: "select-exists-with-order-limit",
    manualSection: "MATCH / WITH / EXISTS",
    compile: () =>
      select()
        .match("(u:User)")
        .withOrderLimit(["u"], [{ prop: prop("u", "score"), direction: "DESC" }], 5)
        .where(exists("(u)-[:OWNS]->(a:Asset)", eq(prop("a", "active"), true)))
        .returnStar()
        .toCypher(),
    expectedText: norm(
      "MATCH (u:User) WITH u ORDER BY u.score DESC LIMIT toInteger($p0) WHERE EXISTS { MATCH (u)-[:OWNS]->(a:Asset) WHERE a.active = $p1 } RETURN *",
    ),
    expectedParams: { p0: 5, p1: true },
  },
  {
    status: "implemented",
    id: "select-match-where-return-pattern",
    manualSection: "MATCH / WHERE / RETURN",
    compile: () => {
      const u = node("User", "u");
      const o = node("Organization", "o");
      const m = rel("MEMBER_OF", "m");
      return select()
        .match(u.out(m, o))
        .where(eq(prop(m.alias, "role"), "admin"))
        .returnFields({ userId: prop(u.alias, "id"), orgName: prop(o.alias, "name") })
        .toCypher();
    },
    expectedText: norm(
      "MATCH (u:User)-[m:MEMBER_OF]->(o:Organization) WHERE m.role = $p0 RETURN u.id AS userId, o.name AS orgName",
    ),
    expectedParams: { p0: "admin" },
  },
  {
    status: "implemented",
    id: "select-optional-match-chain",
    manualSection: "OPTIONAL MATCH",
    compile: () =>
      select()
        .match("(a:A)")
        .optionalMatch("(a)-[:R1]->(b:B)")
        .optionalMatch("(a)-[:R2]->(c:C)")
        .returnStar()
        .toCypher(),
    expectedText: norm(
      "MATCH (a:A) OPTIONAL MATCH (a)-[:R1]->(b:B) OPTIONAL MATCH (a)-[:R2]->(c:C) RETURN *",
    ),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "select-order-skip-limit-params",
    manualSection: "ORDER BY / SKIP / LIMIT",
    compile: () => {
      const u = node("User", "u");
      return select()
        .match(`(${u.alias}:${u.label})`)
        .returnFields({ id: prop(u.alias, "id") })
        .orderBy({ prop: prop(u.alias, "createdAt"), direction: "DESC" })
        .skip(10)
        .limit(5)
        .toCypher();
    },
    expectedText: norm(
      "MATCH (u:User) RETURN u.id AS id ORDER BY u.createdAt DESC SKIP toInteger($p0) LIMIT toInteger($p1)",
    ),
    expectedParams: { p0: 10, p1: 5 },
  },
  {
    status: "implemented",
    id: "select-return-distinct-order-nulls",
    manualSection: "RETURN DISTINCT / ORDER BY NULLS",
    compile: () =>
      select()
        .match("(n:N)")
        .returnDistinct()
        .returnFields({ v: prop("n", "v") })
        .orderBy({ prop: prop("n", "v"), direction: "ASC", nulls: "LAST" })
        .toCypher(),
    expectedText: norm("MATCH (n:N) RETURN DISTINCT n.v AS v ORDER BY n.v ASC NULLS LAST"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "clause-use",
    manualSection: "USE",
    compile: () =>
      select().use("composite.primary").match("(n:N)").returnStar().toCypher(),
    expectedText: norm("USE composite.primary MATCH (n:N) RETURN *"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "return-order-grouping",
    manualSection: "RETURN … ORDER BY aggregating",
    compile: () =>
      select()
        .match("(n:N)")
        .returnRawFields({ role: "n.role", total: "count(*)" })
        .orderBy({ expression: "total", direction: "DESC" })
        .toCypher(),
    expectedText: norm("MATCH (n:N) RETURN n.role AS role, count(*) AS total ORDER BY total DESC"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "show-constraints",
    manualSection: "SHOW",
    compile: () => compileShowAdmin("CONSTRAINTS"),
    expectedText: norm("SHOW CONSTRAINTS"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "show-indexes",
    manualSection: "SHOW",
    compile: () => compileShowAdmin("INDEXES"),
    expectedText: norm("SHOW INDEXES"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "show-databases",
    manualSection: "SHOW DATABASES",
    compile: () => compileShowAdmin("DATABASES"),
    expectedText: norm("SHOW DATABASES"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "show-users",
    manualSection: "SHOW USERS",
    compile: () => compileShowAdmin("USERS"),
    expectedText: norm("SHOW USERS"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "show-roles",
    manualSection: "SHOW ROLES",
    compile: () => compileShowAdmin("ROLES"),
    expectedText: norm("SHOW ROLES"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "show-current-user",
    manualSection: "SHOW CURRENT USER",
    compile: () => compileShowAdmin("CURRENT_USER"),
    expectedText: norm("SHOW CURRENT USER"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "subquery-exists-block-embed",
    manualSection: "EXISTS { }",
    compile: () => {
      const ex = compileExistsBlock({
        text: "MATCH (m:Person) WHERE m.id = $p0",
        params: { p0: "alice" },
      });
      return {
        text: `MATCH (n:N) WHERE ${ex.text} RETURN n`,
        params: ex.params,
      };
    },
    expectedText: norm(
      "MATCH (n:N) WHERE EXISTS { MATCH (m:Person) WHERE m.id = $ex_p0 } RETURN n",
    ),
    expectedParams: { ex_p0: "alice" },
  },
  {
    status: "implemented",
    id: "subquery-count-block-return",
    manualSection: "COUNT { }",
    compile: () => {
      const inner = compileCountBlock({
        text: "MATCH (u:User) WHERE u.k = $p0 RETURN u",
        params: { p0: 1 },
      });
      return {
        text: `MATCH (p:Post) RETURN ${inner.text} AS c`,
        params: inner.params,
      };
    },
    expectedText: norm(
      "MATCH (p:Post) RETURN COUNT { MATCH (u:User) WHERE u.k = $ct_p0 RETURN u } AS c",
    ),
    expectedParams: { ct_p0: 1 },
  },
  {
    status: "implemented",
    id: "expr-builtins-aggregates",
    manualSection: "Aggregating functions",
    compile: () =>
      select()
        .match("(n:N)")
        .returnRawFields({
          c: countStar(),
          d: countDistinct(prop("n", "id")),
          s: sumExpr(prop("n", "v")),
          a: avgExpr(prop("n", "v")),
          mn: minExpr(prop("n", "v")),
          mx: maxExpr(prop("n", "v")),
          col: collectExpr(prop("n", "name")),
          cv: countVariable("n"),
        })
        .toCypher(),
    expectedText: norm(
      "MATCH (n:N) RETURN count(*) AS c, count(DISTINCT n.id) AS d, sum(n.v) AS s, avg(n.v) AS a, min(n.v) AS mn, max(n.v) AS mx, collect(n.name) AS col, count(n) AS cv",
    ),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "expr-builtins-list-size",
    manualSection: "List functions",
    compile: () =>
      select()
        .match("(n:N)")
        .returnRawFields({ sz: sizeExpr(prop("n", "tags")) })
        .toCypher(),
    expectedText: norm("MATCH (n:N) RETURN size(n.tags) AS sz"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "expr-builtins-string-case",
    manualSection: "String functions",
    compile: () =>
      select()
        .match("(n:N)")
        .returnRawFields({
          lo: toLowerExpr(prop("n", "email")),
          up: toUpperExpr(prop("n", "code")),
        })
        .toCypher(),
    expectedText: norm("MATCH (n:N) RETURN toLower(n.email) AS lo, toUpper(n.code) AS up"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "select-with-distinct-pipe",
    manualSection: "WITH DISTINCT",
    compile: () =>
      select()
        .match("(n:N)")
        .withDistinct(["n"])
        .where(eq(prop("n", "k"), 1))
        .returnStar()
        .toCypher(),
    expectedText: norm("MATCH (n:N) WITH DISTINCT n WHERE n.k = $p0 RETURN *"),
    expectedParams: { p0: 1 },
  },
  {
    status: "implemented",
    id: "select-with-distinct-order-limit",
    manualSection: "WITH DISTINCT / ORDER BY / LIMIT",
    compile: () =>
      select()
        .match("(u:User)")
        .withOrderLimit(["u"], [{ prop: prop("u", "score"), direction: "DESC" }], 5, { distinct: true })
        .returnStar()
        .toCypher(),
    expectedText: norm("MATCH (u:User) WITH DISTINCT u ORDER BY u.score DESC LIMIT toInteger($p0) RETURN *"),
    expectedParams: { p0: 5 },
  },
  {
    status: "implemented",
    id: "select-where-or-precedence",
    manualSection: "WHERE / AND / OR precedence",
    compile: () =>
      select()
        .match("(n:N)")
        .where(eq(prop("n", "a"), 1), or(eq(prop("n", "b"), 2), eq(prop("n", "c"), 3)))
        .returnStar()
        .toCypher(),
    expectedText: norm("MATCH (n:N) WHERE n.a = $p0 AND (n.b = $p1 OR n.c = $p2) RETURN *"),
    expectedParams: { p0: 1, p1: 2, p2: 3 },
  },
  {
    status: "implemented",
    id: "select-where-not-in-starts-contains",
    manualSection: "WHERE / predicates",
    compile: () =>
      select()
        .match("(n:N)")
        .where(
          not(inList(prop("n", "role"), ["guest"])),
          eq(prop("n", "name"), "x"),
        )
        .returnStar()
        .toCypher(),
    expectedText: norm("MATCH (n:N) WHERE NOT (n.role IN $p0) AND n.name = $p1 RETURN *"),
    expectedParams: { p0: ["guest"], p1: "x" },
  },
  {
    status: "implemented",
    id: "select-where-predicate-families",
    manualSection: "WHERE / comparison and strings",
    compile: () =>
      select()
        .match("(n:N)")
        .where(
          neq(prop("n", "a"), 1),
          gt(prop("n", "b"), 2),
          gte(prop("n", "c"), 3),
          lt(prop("n", "d"), 4),
          lte(prop("n", "e"), 5),
          between(prop("n", "x"), 0, 10),
          isNull(prop("n", "p")),
          isNotNull(prop("n", "q")),
        )
        .returnStar()
        .toCypher(),
    expectedText: norm(
      "MATCH (n:N) WHERE n.a <> $p0 AND n.b > $p1 AND n.c >= $p2 AND n.d < $p3 AND n.e <= $p4 AND (n.x >= $p5 AND n.x <= $p6) AND n.p IS NULL AND n.q IS NOT NULL RETURN *",
    ),
    expectedParams: { p0: 1, p1: 2, p2: 3, p3: 4, p4: 5, p5: 0, p6: 10 },
  },
  {
    status: "implemented",
    id: "select-where-string-predicates",
    manualSection: "WHERE / string predicates",
    compile: () =>
      select()
        .match("(n:N)")
        .where(
          startsWith(prop("n", "email"), "a"),
          endsWith(prop("n", "email"), "z"),
          contains(prop("n", "email"), "@"),
          matches(prop("n", "email"), ".*@.*"),
        )
        .returnStar()
        .toCypher(),
    expectedText: norm(
      "MATCH (n:N) WHERE n.email STARTS WITH $p0 AND n.email ENDS WITH $p1 AND n.email CONTAINS $p2 AND n.email =~ $p3 RETURN *",
    ),
    expectedParams: { p0: "a", p1: "z", p2: "@", p3: ".*@.*" },
  },
  {
    status: "implemented",
    id: "variable-length-rel-quantifiers",
    manualSection: "Patterns / variable-length paths",
    compile: () => {
      const a = node("Person", "a");
      const b = node("Person", "b");
      return {
        text: [
          a.out(rel("KNOWS", "r", "any"), b),
          a.out(rel("KNOWS", "r", 2), b),
          a.out(rel("KNOWS", "r", { min: 1, max: 3 }), b),
          a.out(rel("KNOWS", "r", { max: 5 }), b),
          a.out(rel("KNOWS", "r", { min: 2 }), b),
        ].join(" | "),
        params: {},
      };
    },
    expectedText: norm(
      "(a:Person)-[r:KNOWS*]->(b:Person) | (a:Person)-[r:KNOWS*2]->(b:Person) | (a:Person)-[r:KNOWS*1..3]->(b:Person) | (a:Person)-[r:KNOWS*..5]->(b:Person) | (a:Person)-[r:KNOWS*2..]->(b:Person)",
    ),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "compile-cypher-api",
    manualSection: "Parameters / expressions",
    compile: () =>
      compileCypher(["RETURN ", " AS n"] as unknown as TemplateStringsArray, [99]),
    expectedText: norm("RETURN $p0 AS n"),
    expectedParams: { p0: 99 },
  },
  {
    status: "implemented",
    id: "func-math-all",
    manualSection: "Mathematical functions",
    compile: () =>
      select()
        .match("(n:N)")
        .returnRawFields({
          a: absExpr(prop("n", "x")),
          r: roundExpr(prop("n", "x")),
          c: ceilExpr(prop("n", "y")),
          f: floorExpr(prop("n", "z")),
          s: sqrtExpr(prop("n", "w")),
          rd: randExpr(),
        })
        .toCypher(),
    expectedText: norm(
      "MATCH (n:N) RETURN abs(n.x) AS a, round(n.x) AS r, ceil(n.y) AS c, floor(n.z) AS f, sqrt(n.w) AS s, rand() AS rd",
    ),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "func-temporal-all",
    manualSection: "Temporal functions",
    compile: () =>
      select()
        .match("(n:N)")
        .returnRawFields({
          d: currentDateExpr(),
          dt: currentDateTimeExpr(),
          t: currentTimeExpr(),
          ldt: currentLocalDateTimeExpr(),
          lt: currentLocalTimeExpr(),
        })
        .toCypher(),
    expectedText: norm(
      "MATCH (n:N) RETURN date() AS d, datetime() AS dt, time() AS t, localdatetime() AS ldt, localtime() AS lt",
    ),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "func-spatial-all",
    manualSection: "Spatial functions",
    compile: () => {
      const c = compilePointCartesian2D(1.5, -2.25);
      const w = remapCompiledCypherParamKeys(compilePointWGS84(48.8566, 2.3522, 35), "w_");
      return {
        text: `RETURN ${c.text} AS c, ${w.text} AS w`,
        params: { ...c.params, ...w.params },
      };
    },
    expectedText: norm(
      "RETURN point({ x: $px, y: $py }) AS c, point({ latitude: $w_plat, longitude: $w_plon, height: $w_pheight }) AS w",
    ),
    expectedParams: {
      px: 1.5,
      py: -2.25,
      w_plat: 48.8566,
      w_plon: 2.3522,
      w_pheight: 35,
    },
  },
  {
    status: "implemented",
    id: "func-path-all",
    manualSection: "Path functions",
    compile: () =>
      select()
        .match("p = ()--()")
        .returnRawFields({
          len: lengthPath("p"),
          ns: nodesPath("p"),
          rs: relationshipsPath("p"),
        })
        .toCypher(),
    expectedText: norm(
      "MATCH p = ()--() RETURN length(p) AS len, nodes(p) AS ns, relationships(p) AS rs",
    ),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "periodic-commit",
    manualSection: "LOAD CSV / USING PERIODIC COMMIT",
    compile: () => {
      const load = compileLoadCsvFrom("file:///batch.csv", "row", { withHeaders: true });
      return {
        text: usingPeriodicCommitClause(1000) + load.text,
        params: load.params,
      };
    },
    expectedText: norm(
      "USING PERIODIC COMMIT 1000 LOAD CSV WITH HEADERS FROM $csvUrl AS row",
    ),
    expectedParams: { csvUrl: "file:///batch.csv" },
  },
  {
    status: "implemented",
    id: "clause-finisher",
    manualSection: "FINISH",
    compile: () => appendFinish({ text: "MATCH (p:Person)", params: {} }),
    expectedText: norm("MATCH (p:Person) FINISH"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "clause-when-next",
    manualSection: "NEXT / WHEN (composed queries)",
    compile: () => {
      const part1 = select()
        .match("(c:Customer)-[:BUYS]->(:Product)<-[:SUPPLIES]-(s:Supplier)")
        .returnRawFields({ customer: "c.firstName", supplier: "s.name" })
        .toCypher();
      const part2 = compileWhenThenElse([
        {
          predicate: 'supplier = "TechCorp"',
          then: { text: 'RETURN customer, "Tech enjoyer" AS personality', params: {} },
        },
        {
          predicate: 'supplier = "Foodies Inc."',
          then: {
            text: 'RETURN customer, "Tropical plant enjoyer" AS personality',
            params: {},
          },
        },
      ]);
      return compileSequentialNext(part1, part2);
    },
    expectedText: norm(
      'MATCH (c:Customer)-[:BUYS]->(:Product)<-[:SUPPLIES]-(s:Supplier) RETURN c.firstName AS customer, s.name AS supplier NEXT WHEN supplier = "TechCorp" THEN RETURN customer, "Tech enjoyer" AS personality WHEN supplier = "Foodies Inc." THEN RETURN customer, "Tropical plant enjoyer" AS personality',
    ),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "clause-filter",
    manualSection: "FILTER",
    compile: () =>
      compileMatchFilterReturn(
        { text: "MATCH (n)", params: {} },
        { text: "n:Swedish", params: {} },
        { text: "RETURN n.name AS name", params: {} },
      ),
    expectedText: norm("MATCH (n) FILTER n:Swedish RETURN n.name AS name"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "clause-for",
    manualSection: "CREATE CONSTRAINT … FOR",
    compile: () =>
      compileCreateConstraintNodeUnique({
        constraintName: "person_name_unique",
        variable: "p",
        label: "Person",
        property: "name",
        ifNotExists: true,
      }),
    expectedText: norm(
      "CREATE CONSTRAINT person_name_unique IF NOT EXISTS FOR (p:Person) REQUIRE p.name IS UNIQUE",
    ),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "clause-let",
    manualSection: "LET",
    compile: () =>
      concatCompiledCypher(
        [
          { text: "MATCH (c:Customer)", params: {} },
          compileLetClause([
            {
              variable: "fullName",
              expression: { text: "c.firstName + ' ' + c.lastName", params: {} },
            },
          ]),
          { text: "RETURN fullName", params: {} },
        ],
        { separator: " " },
      ),
    expectedText: norm(
      "MATCH (c:Customer) LET fullName = c.firstName + ' ' + c.lastName RETURN fullName",
    ),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "ddl-constraint-relationship-unique",
    manualSection: "CREATE CONSTRAINT / relationship",
    compile: () =>
      compileCreateConstraintRelationshipUnique({
        constraintName: "liked_when_unique",
        relVariable: "r",
        relType: "LIKED",
        property: "when",
        ifNotExists: true,
      }),
    expectedText: norm(
      "CREATE CONSTRAINT liked_when_unique IF NOT EXISTS FOR ()-[r:LIKED]-() REQUIRE r.when IS UNIQUE",
    ),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "ddl-range-index-node",
    manualSection: "CREATE RANGE INDEX / node",
    compile: () =>
      compileCreateRangeIndexNode({
        indexName: "person_age_idx",
        variable: "n",
        label: "Person",
        property: "age",
        ifNotExists: true,
      }),
    expectedText: norm(
      "CREATE RANGE INDEX person_age_idx IF NOT EXISTS FOR (n:Person) ON (n.age)",
    ),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "ddl-range-index-relationship",
    manualSection: "CREATE RANGE INDEX / relationship",
    compile: () =>
      compileCreateRangeIndexRelationship({
        indexName: "buys_since_rel_idx",
        relVariable: "r",
        relType: "BUYS",
        property: "since",
        ifNotExists: true,
      }),
    expectedText: norm(
      "CREATE RANGE INDEX buys_since_rel_idx IF NOT EXISTS FOR ()-[r:BUYS]-() ON (r.since)",
    ),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "admin-show-transactions",
    manualSection: "SHOW TRANSACTIONS",
    compile: () => compileShowTransactions(),
    expectedText: norm("SHOW TRANSACTIONS"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "clause-terminate",
    manualSection: "TERMINATE TRANSACTIONS",
    compile: () => compileTerminateTransactions(["neo4j-transaction-1", "mydb-transaction-2"]),
    expectedText: norm(
      'TERMINATE TRANSACTIONS "neo4j-transaction-1", "mydb-transaction-2"',
    ),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "clause-grant",
    manualSection: "GRANT",
    compile: () => compileGrantRole("reader", "alice"),
    expectedText: norm("GRANT ROLE reader TO alice"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "clause-revoke",
    manualSection: "REVOKE",
    compile: () => compileRevokeRole("reader", "alice"),
    expectedText: norm("REVOKE ROLE reader FROM alice"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "clause-deny",
    manualSection: "DENY",
    compile: () => compileDenyAccessOnDatabase("neo4j", "guest"),
    expectedText: norm("DENY ACCESS ON DATABASE neo4j TO guest"),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "js-graph-read-optional-rel",
    manualSection: "OPTIONAL MATCH (structured facade)",
    compile: () =>
      compileRootOptionalOutgoingSelect({
        rootLabel: "Post",
        rootAlias: "p",
        outgoing: {
          relType: "WRITTEN_BY",
          relAlias: "r",
          targetLabel: "Author",
          targetAlias: "a",
        },
        returnMaps: [
          { resultKey: "post", variable: "p", pick: ["id", "title", "slug", "createdAt"] },
        ],
        scalars: { authorName: { variable: "a", property: "name" } },
        orderBy: { variable: "p", property: "createdAt", direction: "DESC" },
      }),
    expectedText: norm(
      "MATCH (p:Post) OPTIONAL MATCH (p:Post)-[r:WRITTEN_BY]->(a:Author) RETURN p { .id, .title, .slug, .createdAt } AS post, a.name AS authorName ORDER BY p.createdAt DESC",
    ),
    expectedParams: {},
  },
  {
    status: "implemented",
    id: "js-graph-create-linked-nodes",
    manualSection: "CREATE (linked nodes facade)",
    compile: () =>
      compileCreateLinkedNodes({
        primary: {
          label: "Post",
          alias: "p",
          props: { id: "pid", title: "t", slug: "s", body: "b" },
          serverTimestamp: "createdAt",
        },
        secondary: { label: "Author", alias: "a", props: { id: "aid", name: "Alice" } },
        link: { type: "WRITTEN_BY", alias: "r" },
      }),
    expectedText: norm(
      "CREATE (p:Post) SET p += $props, p.createdAt = datetime() CREATE (a:Author) SET a += $f1_props CREATE (p)-[r:WRITTEN_BY]->(a)",
    ),
    expectedParams: {
      props: { id: "pid", title: "t", slug: "s", body: "b" },
      f1_props: { id: "aid", name: "Alice" },
    },
  },
];
