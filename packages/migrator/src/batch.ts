/**
 * Neo4j 5+ batching: wrap `inner` in `CALL { … } IN TRANSACTIONS OF n ROWS`.
 *
 * @param innerCypher - Subquery body (without `CALL {` / `}` wrapper).
 * @param batchSize - Rows per transaction.
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
export function wrapInTransactions(innerCypher: string, batchSize: number): string {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`batchSize must be a positive integer, got ${batchSize}`);
  }
  return `CALL {\n${innerCypher.trim()}\n} IN TRANSACTIONS OF ${batchSize} ROWS`;
}
