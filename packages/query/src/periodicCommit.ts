/**
 * Prefix for **`USING PERIODIC COMMIT`** before **`LOAD CSV`** (Neo4j batching).
 *
 * @see https://neo4j.com/docs/cypher-manual/current/clauses/load-csv/
 */

export function usingPeriodicCommitClause(batchSize: number): string {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("usingPeriodicCommitClause: batchSize must be a positive integer");
  }
  return `USING PERIODIC COMMIT ${batchSize} `;
}
