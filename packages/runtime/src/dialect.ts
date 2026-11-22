/**
 * Database dialects: the Cypher flavour a client compiles to.
 *
 * - `"neo4j"` (default): Neo4j 5.x / 2025.x, over Bolt or the Query API (HTTP).
 * - `"memgraph"`: Memgraph 3.x over Bolt. Variable-length patterns with filter lambdas replace
 *   quantified path patterns, `*BFS` / `*ALLSHORTEST` replace the GQL shortest-path selectors,
 *   `vector_search.*` / `text_search.*` replace the `db.index.*` procedures, and the migrator writes
 *   Memgraph's DDL (`CREATE CONSTRAINT ON (n:L) ASSERT …`, `CREATE INDEX ON :L(p)`). Features
 *   Memgraph lacks throw an {@link UnsupportedFeatureError} before any statement runs.
 * - `"falkordb"`: FalkorDB 4.x over the Redis protocol (`GRAPH.QUERY`, optional `falkordb` peer
 *   dependency). Subquery expressions (`EXISTS {}`, `COUNT {}`, `COLLECT {}`) become pattern
 *   comprehensions, `elementId()` becomes `id()`, temporal values are stored as ISO 8601 text, and
 *   statements are atomic one by one (no multi-statement transactions): see `falkordb/`.
 *
 * The dialect is set explicitly (`dialect` in client options, `"dialect"` in `cyphra.json`): ORM
 * statements compile synchronously, without a round trip to ask the server what it is.
 * {@link detectDialect} reads the Bolt server agent (Memgraph announces itself as
 * `"Neo4j/v5.11.0 compatible graph database server - Memgraph"`); the CLI uses it when
 * `cyphra.json` sets no dialect.
 *
 * @packageDocumentation
 */

import { CyphraValidationError, UnsupportedFeatureError } from "./orm/errors.js";

/** The Cypher flavour a client compiles to. */
export type CyphraDialect = "neo4j" | "memgraph" | "falkordb";

/** Every supported dialect. */
export const DIALECTS: readonly CyphraDialect[] = ["neo4j", "memgraph", "falkordb"];

/** `value` as a dialect (`undefined` → `"neo4j"`), or a {@link CyphraValidationError}. */
export function parseDialect(value: unknown, where = "dialect"): CyphraDialect {
  if (value === undefined) return "neo4j";
  if (value === "neo4j" || value === "memgraph" || value === "falkordb") return value;
  throw new CyphraValidationError(
    `${where} must be "neo4j", "memgraph" or "falkordb" (got ${JSON.stringify(value)}).`,
  );
}

/** The dialect a Bolt server agent string (`ServerInfo.agent`) stands for. */
export function dialectFromServerAgent(agent: string | null | undefined): CyphraDialect {
  return typeof agent === "string" && /memgraph/i.test(agent) ? "memgraph" : "neo4j";
}

type ServerInfoSource = { getServerInfo?: () => Promise<{ agent?: string | null }> };

/**
 * Ask the server which dialect it speaks, from its Bolt agent string. Pass a `CyphraClient`
 * (`client.rawDriver`) or a `neo4j-driver` `Driver`. Anything without `getServerInfo` (the HTTP
 * transport, test stubs) is Neo4j: Memgraph has no Query API. A client on the FalkorDB transport is
 * FalkorDB (it speaks the Redis protocol, never Bolt).
 */
export async function detectDialect(
  target: ServerInfoSource | { rawDriver: unknown },
): Promise<CyphraDialect> {
  if ((target as { transport?: unknown }).transport === "falkordb") return "falkordb";
  const driver = ("rawDriver" in target ? (target as { rawDriver: unknown }).rawDriver : target) as
    ServerInfoSource | undefined;
  if (typeof driver?.getServerInfo !== "function") return "neo4j";
  const info = await driver.getServerInfo();
  return dialectFromServerAgent(info?.agent);
}

/** Shorthand for `new UnsupportedFeatureError(feature, "memgraph", hint)`. */
export function unsupportedOnMemgraph(feature: string, hint?: string): UnsupportedFeatureError {
  return new UnsupportedFeatureError(feature, "memgraph", hint);
}

/** Shorthand for `new UnsupportedFeatureError(feature, "falkordb", hint)`. */
export function unsupportedOnFalkorDB(feature: string, hint?: string): UnsupportedFeatureError {
  return new UnsupportedFeatureError(feature, "falkordb", hint);
}

/** The display name of a dialect's database. */
export function dialectName(dialect: CyphraDialect): string {
  return dialect === "memgraph" ? "Memgraph" : dialect === "falkordb" ? "FalkorDB" : "Neo4j";
}
