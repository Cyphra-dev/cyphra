import type { Record as Neo4jRecord, QueryResult, Result } from "neo4j-driver";

/**
 * Consume a driver {@link Result} (or an already-awaited {@link QueryResult}) and map rows to plain objects.
 *
 * @param result - From `session.run` / {@link import("./client.js").CyphraClient.runCompiled} (awaited or not, depending on driver typings).
 * @returns Plain objects keyed by Cypher return aliases.
 *
 * @example
 * ```ts
 * const result = await client.runCompiled(session, cypher`RETURN 1 AS n`);
 * const rows = await toPlainRecords(result);
 * ```
 */
export async function toPlainRecords(
  result: Result | QueryResult,
): Promise<Record<string, unknown>[]> {
  const summary = (await (result as PromiseLike<QueryResult>)) as QueryResult;
  return summary.records.map((r: Neo4jRecord) => r.toObject());
}

/**
 * First row as a plain object, or `undefined` if the result is empty.
 *
 * @param result - Driver result from `run` / `runCompiled`.
 */
export async function toPlainRecord(
  result: Result | QueryResult,
): Promise<Record<string, unknown> | undefined> {
  const rows = await toPlainRecords(result);
  return rows[0];
}
