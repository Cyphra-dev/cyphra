import type { CompiledCypher } from "./cypher.js";

/**
 * Transaction IDs in Neo4j look like **`neo4j-transaction-12`**; we only emit quoted string literals
 * for a safe character subset (no escaping needed).
 *
 * @see https://neo4j.com/docs/cypher-manual/current/clauses/transaction-clauses/
 */
function assertTransactionId(id: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
    throw new Error(`compileTerminateTransactions: invalid transaction id ${JSON.stringify(id)}`);
  }
}

function transactionIdLiteral(id: string): string {
  assertTransactionId(id);
  return `"${id}"`;
}

/** **`SHOW TRANSACTIONS`** (default columns, no parameters). */
export function compileShowTransactions(): CompiledCypher {
  return { text: "SHOW TRANSACTIONS", params: {} };
}

/**
 * **`TERMINATE TRANSACTIONS "id1", "id2", …`** — quoted string form from the Cypher manual.
 */
export function compileTerminateTransactions(transactionIds: readonly string[]): CompiledCypher {
  if (transactionIds.length === 0) {
    throw new Error("compileTerminateTransactions: at least one transaction id is required");
  }
  const literals = transactionIds.map(transactionIdLiteral);
  return {
    text: `TERMINATE TRANSACTIONS ${literals.join(", ")}`,
    params: {},
  };
}
