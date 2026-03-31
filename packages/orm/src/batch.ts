import type { CompiledCypher } from "@cyphra/query";
import type { CyphraClient } from "@cyphra/runtime";

/**
 * Run compiled statements in order inside a single **write** transaction.
 */
export async function runCompiledBatchWrite(
  client: CyphraClient,
  steps: readonly CompiledCypher[],
): Promise<void> {
  if (steps.length === 0) {
    return;
  }
  await client.withWriteTransaction(async (tx) => {
    for (const step of steps) {
      await client.runCompiledTx(tx, step);
    }
  });
}
