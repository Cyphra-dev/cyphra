import type { CyphraDialect } from "@cyphra/runtime";

/**
 * Neo4j 5+ batching: wrap `inner` in `CALL { … } IN TRANSACTIONS OF n ROWS`.
 *
 * @param innerCypher - Subquery body (without `CALL {` / `}` wrapper).
 * @param batchSize - Rows per transaction.
 * @param dialect - `"memgraph"`: `USING PERIODIC COMMIT n <inner>` instead. `"falkordb"`: `inner`
 *   alone, as one statement (FalkorDB has no batched commits: every statement is atomic on its own,
 *   and `batchSize` only has to be valid).
 * @returns Full Cypher string to pass to `session.run`.
 *
 * @example
 * ```ts
 * const cypher = wrapInTransactions(
 *   "MATCH (u:User) WITH u LIMIT $batchSize SET u.processed = true",
 *   1000,
 * );
 * ```
 */
export function wrapInTransactions(
  innerCypher: string,
  batchSize: number,
  dialect: CyphraDialect = "neo4j",
): string {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`batchSize must be a positive integer, got ${batchSize}`);
  }
  // Memgraph cannot DELETE inside CALL { } IN TRANSACTIONS: its own batching directive commits
  // every `batchSize` rows of the whole statement.
  if (dialect === "memgraph") return `USING PERIODIC COMMIT ${batchSize}\n${innerCypher.trim()}`;
  if (dialect === "falkordb") return innerCypher.trim();
  return `CALL {\n${innerCypher.trim()}\n} IN TRANSACTIONS OF ${batchSize} ROWS`;
}
