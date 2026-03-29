import type { Record as Neo4jRecord, Result } from "neo4j-driver";

/**
 * Consume a driver {@link Result} and map each row to a plain object (`record.toObject()`).
 *
 * @param result - Value returned from `session.run` / {@link import("./client.js").CyphraClient.runCompiled}.
 * @returns Plain objects keyed by Cypher return aliases.
 *
 * @example
 * ```ts
 * const result = await client.runCompiled(session, cypher`RETURN 1 AS n`);
 * const rows = await toPlainRecords(result);
 * ```
 */
export async function toPlainRecords(result: Result): Promise<Record<string, unknown>[]> {
  const summary = await result;
  return summary.records.map((r: Neo4jRecord) => r.toObject());
}

/**
 * First row as a plain object, or `undefined` if the result is empty.
 *
 * @param result - Driver result from `run` / `runCompiled`.
 */
export async function toPlainRecord(result: Result): Promise<Record<string, unknown> | undefined> {
  const rows = await toPlainRecords(result);
  return rows[0];
}
