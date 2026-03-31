import type { EagerResult, Record as Neo4jRecord, QueryResult, Result } from "neo4j-driver";

/** Map {@link EagerResult.records} to plain objects (e.g. after {@link Driver.executeQuery}). */
export function eagerResultToPlainRecords(result: EagerResult): Record<string, unknown>[] {
  return result.records.map((r: Neo4jRecord) => r.toObject());
}

/**
 * Consume a driver {@link Result} (or an already-awaited {@link QueryResult}) and map rows to plain objects.
 *
 * @param result - From `session.run` / `CyphraClient.runCompiled` (awaited or not, depending on driver typings).
 * @returns Plain objects keyed by Cypher return aliases.
 */
export async function toPlainRecords(
  result: Result | QueryResult,
): Promise<Record<string, unknown>[]> {
  const summary = (await (result as PromiseLike<QueryResult>)) as QueryResult;
  return summary.records.map((r: Neo4jRecord) => r.toObject());
}

/**
 * First row as a plain object, or `undefined` if the result is empty.
 */
export async function toPlainRecord(
  result: Result | QueryResult,
): Promise<Record<string, unknown> | undefined> {
  const rows = await toPlainRecords(result);
  return rows[0];
}
