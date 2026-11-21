/**
 * The dialect integration tests run against: `CYPHRA_TEST_DIALECT=memgraph` (with `NEO4J_TEST_URI`
 * pointing at a Memgraph server) runs the shared suites on Memgraph, skipping what Memgraph does
 * not support and adapting checks that read Neo4j-specific values (`valueType` text, `.offset`).
 */
import { parseDialect } from "../../dialect.js";

export const testDialect = parseDialect(process.env.CYPHRA_TEST_DIALECT || undefined);

/** `true` when the suites target Memgraph. */
export const onMemgraph = testDialect === "memgraph";

/** Neo4j's `valueType()` text for a stored (non-null) value, as the target database writes it. */
export function storedType(neo4jType: string): string {
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
