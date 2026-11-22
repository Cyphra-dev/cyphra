/**
 * The dialect integration tests run against: `CYPHRA_TEST_DIALECT=memgraph` (with `NEO4J_TEST_URI`
 * pointing at a Memgraph server) runs the shared suites on Memgraph, skipping what Memgraph does
 * not support and adapting checks that read Neo4j-specific values (`valueType` text, `.offset`).
 * `CYPHRA_TEST_DIALECT=falkordb` (with `FALKORDB_TEST_URL`, e.g. `redis://127.0.0.1:6379`) runs
 * them on FalkorDB, through the FalkorDB transport.
 */
import { parseDialect } from "../../dialect.js";
import type { CyphraFalkorDBOptions } from "../../client.js";

export const testDialect = parseDialect(process.env.CYPHRA_TEST_DIALECT || undefined);

/** `true` when the suites target Memgraph. */
export const onMemgraph = testDialect === "memgraph";

/** `true` when the suites target FalkorDB. */
export const onFalkorDB = testDialect === "falkordb";

/** The graph the FalkorDB suites use. */
export const FALKORDB_TEST_GRAPH = process.env.FALKORDB_TEST_GRAPH || "cyphra_test";

/** `true` when the environment names a test database for {@link testDialect}. */
export const hasTestDb = onFalkorDB
  ? Boolean(process.env.FALKORDB_TEST_URL)
  : Boolean(
      process.env.NEO4J_TEST_URI && process.env.NEO4J_TEST_USER && process.env.NEO4J_TEST_PASSWORD,
    );

/**
 * Client options for the test database: `NEO4J_TEST_URI` / `_USER` / `_PASSWORD` with the test
 * dialect, or `FALKORDB_TEST_URL` on FalkorDB.
 */
export function testConnection():
  | { uri: string; user: string; password: string; dialect: "neo4j" | "memgraph" }
  | CyphraFalkorDBOptions {
  if (onFalkorDB) {
    return { falkordb: { url: process.env.FALKORDB_TEST_URL!, graph: FALKORDB_TEST_GRAPH } };
  }
  return {
    uri: process.env.NEO4J_TEST_URI!,
    user: process.env.NEO4J_TEST_USER!,
    password: process.env.NEO4J_TEST_PASSWORD!,
    dialect: testDialect as "neo4j" | "memgraph",
  };
}

/** Neo4j's `valueType()` text for a stored (non-null) value, as the target database writes it. */
export function storedType(neo4jType: string): string {
  if (onFalkorDB) return falkordbType(neo4jType);
  if (!onMemgraph) return neo4jType;
  const t = neo4jType.replace(/ NOT NULL/g, "");
  if (t.startsWith("LIST")) return "LIST";
  return (
    {
      "ZONED DATETIME": "ZONED_DATE_TIME",
      "LOCAL DATETIME": "LOCAL_DATE_TIME",
      "LOCAL TIME": "LOCAL_TIME",
    }[t] ?? t
  );
}

const ID = "`?([A-Za-z_][A-Za-z0-9_]*)`?";
const props = (text: string) =>
  text
    .replace(/^\(|\)$/g, "")
    .split(",")
    .map((p) =>
      p
        .trim()
        .replace(/^\w+\./, "")
        .replace(/`/g, ""),
    );

/** FalkorDB's `typeOf()` text for what the ORM stores as `neo4jType` (temporal values are text). */
function falkordbType(neo4jType: string): string {
  const t = neo4jType.replace(/ NOT NULL/g, "");
  if (t.startsWith("LIST")) return "List";
  return (
    {
      INTEGER: "Integer",
      FLOAT: "Float",
      STRING: "String",
      BOOLEAN: "Boolean",
      "ZONED DATETIME": "String",
      "LOCAL DATETIME": "String",
      "LOCAL TIME": "String",
      "ZONED TIME": "String",
      DATE: "String",
      DURATION: "String",
    }[t] ?? t
  );
}

/** Memgraph statement that drops what a translated `CREATE` made, by the Neo4j name. */
const drops = new Map<string, string>();

/**
 * The test suites' Neo4j DDL (the forms `cyphra push` writes) for the target database: itself on
 * Neo4j, Memgraph's equivalent on Memgraph, or `null` when Memgraph has no equivalent
 * (relationship constraints) or nothing to drop. Run it outside a transaction (Memgraph rejects
 * DDL in explicit transactions).
 */
export function testDdl(statement: string): string | null {
  const text = statement.trim().replace(/\s+/g, " ");
  if (onFalkorDB && /^(CREATE|DROP) /.test(text)) return falkordbDdl(text);
  if (!onMemgraph || !/^(CREATE|DROP) /.test(text)) return text;
  const drop = new RegExp(`^DROP (?:CONSTRAINT|INDEX) ${ID}(?: IF EXISTS)?$`).exec(text);
  if (drop) return drops.get(drop[1]!) ?? null;
  const unique = new RegExp(
    `^CREATE CONSTRAINT ${ID} IF NOT EXISTS FOR \\((\\w+):${ID}\\) REQUIRE (.+) IS UNIQUE$`,
  ).exec(text);
  if (unique) {
    const body = `(n:${unique[3]}) ASSERT ${props(unique[4]!)
      .map((p) => `n.${p}`)
      .join(", ")} IS UNIQUE`;
    drops.set(unique[1]!, `DROP CONSTRAINT ON ${body}`);
    return `CREATE CONSTRAINT ON ${body}`;
  }
  if (/^CREATE CONSTRAINT .* FOR \(\)-\[/.test(text)) return null;
  const index = new RegExp(
    `^CREATE (?:RANGE )?INDEX ${ID} IF NOT EXISTS FOR \\((\\w+):${ID}\\) ON (.+)$`,
  ).exec(text);
  if (index) {
    const body = `:${index[3]}(${props(index[4]!).join(", ")})`;
    drops.set(index[1]!, `DROP INDEX ON ${body}`);
    return `CREATE INDEX ON ${body}`;
  }
  const vector = new RegExp(
    `^CREATE VECTOR INDEX ${ID} IF NOT EXISTS FOR \\((\\w+):${ID}\\) ON \\w+\\.${ID} OPTIONS (.*)$`,
  ).exec(text);
  if (vector) {
    const dims = /vector\.dimensions`?: (\d+)/.exec(vector[5]!)![1];
    const metric = /euclidean/.test(vector[5]!) ? "l2sq" : "cos";
    drops.set(vector[1]!, `DROP VECTOR INDEX ${vector[1]}`);
    return `CREATE VECTOR INDEX ${vector[1]} ON :${vector[3]}(${vector[4]}) WITH CONFIG {'dimension': ${dims}, 'capacity': 1000, 'metric': '${metric}'}`;
  }
  const fulltext = new RegExp(
    `^CREATE FULLTEXT INDEX ${ID} IF NOT EXISTS FOR \\((\\w+):${ID}\\) ON EACH \\[([^\\]]+)\\]`,
  ).exec(text);
  if (fulltext) {
    drops.set(fulltext[1]!, `DROP TEXT INDEX ${fulltext[1]}`);
    return `CREATE TEXT INDEX ${fulltext[1]} ON :${fulltext[3]}(${props(fulltext[4]!).join(", ")})`;
  }
  throw new Error(`testDdl: no Memgraph translation for ${text}`);
}

/** FalkorDB statement that drops what a translated `CREATE` made, by the Neo4j name. */
const falkordbDrops = new Map<string, string>();

/** {@link testDdl} on FalkorDB (the forms `cyphra push` writes there). */
function falkordbDdl(text: string): string | null {
  const drop = new RegExp(`^DROP (?:CONSTRAINT|INDEX) ${ID}(?: IF EXISTS)?$`).exec(text);
  if (drop) return falkordbDrops.get(drop[1]!) ?? null;
  const quote = (p: string) => `\`${p}\``;
  const unique = new RegExp(
    `^CREATE CONSTRAINT ${ID} IF NOT EXISTS FOR (?:\\((\\w+):${ID}\\)|\\(\\)-\\[(\\w+):${ID}\\]-\\(\\)) REQUIRE (.+) IS UNIQUE$`,
  ).exec(text);
  if (unique) {
    const node = unique[3] !== undefined;
    const label = node ? unique[3]! : unique[5]!;
    const ps = props(unique[6]!);
    const body = `UNIQUE ${node ? "NODE" : "RELATIONSHIP"} ${quote(label)} PROPERTIES ${ps.length} ${ps.map(quote).join(" ")}`;
    falkordbDrops.set(unique[1]!, `GRAPH.CONSTRAINT DROP ${body}`);
    return `GRAPH.CONSTRAINT CREATE ${body}`;
  }
  const index = new RegExp(
    `^CREATE (?:RANGE )?INDEX ${ID} IF NOT EXISTS FOR \\((\\w+):${ID}\\) ON (.+)$`,
  ).exec(text);
  if (index) {
    const on = props(index[4]!)
      .map((p) => `n.${quote(p)}`)
      .join(", ");
    falkordbDrops.set(index[1]!, `DROP INDEX FOR (n:${quote(index[3]!)}) ON (${on})`);
    return `CREATE INDEX FOR (n:${quote(index[3]!)}) ON (${on})`;
  }
  const vector = new RegExp(
    `^CREATE VECTOR INDEX ${ID} IF NOT EXISTS FOR \\((\\w+):${ID}\\) ON \\w+\\.${ID} OPTIONS (.*)$`,
  ).exec(text);
  if (vector) {
    const dims = /vector\.dimensions`?: (\d+)/.exec(vector[5]!)![1];
    const fn = /euclidean/.test(vector[5]!) ? "euclidean" : "cosine";
    const target = `FOR (n:${quote(vector[3]!)}) ON (n.${quote(vector[4]!)})`;
    falkordbDrops.set(vector[1]!, `DROP VECTOR INDEX ${target}`);
    return `CREATE VECTOR INDEX ${target} OPTIONS {dimension: ${dims}, similarityFunction: '${fn}'}`;
  }
  const fulltext = new RegExp(
    `^CREATE FULLTEXT INDEX ${ID} IF NOT EXISTS FOR \\((\\w+):${ID}\\) ON EACH \\[([^\\]]+)\\]`,
  ).exec(text);
  if (fulltext) {
    const on = props(fulltext[4]!)
      .map((p) => `n.${quote(p)}`)
      .join(", ");
    const target = `FOR (n:${quote(fulltext[3]!)}) ON (${on})`;
    falkordbDrops.set(fulltext[1]!, `DROP FULLTEXT INDEX ${target}`);
    return `CREATE FULLTEXT INDEX ${target}`;
  }
  if (/^CREATE (?:POINT )?INDEX /.test(text)) return null;
  throw new Error(`testDdl: no FalkorDB translation for ${text}`);
}
