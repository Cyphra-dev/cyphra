import {
  compileCreateLinkedNodes,
  compileRootOptionalOutgoingSelect,
  type CreateLinkedNodesSpec,
} from "@cyphra/query";
import type { CyphraClient } from "@cyphra/runtime";

export type { CreateLinkedNodesSpec };

type WriteTransaction = Parameters<Parameters<CyphraClient["withWriteTransaction"]>[0]>[0];

/**
 * Run {@link compileCreateLinkedNodes} inside an existing write transaction.
 */
export async function runCreateLinkedNodesTx(
  client: CyphraClient,
  tx: WriteTransaction,
  spec: CreateLinkedNodesSpec,
): Promise<void> {
  await client.runCompiledTx(tx, compileCreateLinkedNodes(spec));
}

/**
 * Run {@link compileCreateLinkedNodes} in a dedicated write transaction.
 */
export async function runCreateLinkedNodes(
  client: CyphraClient,
  spec: CreateLinkedNodesSpec,
): Promise<void> {
  await client.withWriteTransaction(async (tx) => {
    await runCreateLinkedNodesTx(client, tx, spec);
  });
}

export type RootOptionalOutgoingReadSpec = Parameters<typeof compileRootOptionalOutgoingSelect>[0];

/**
 * Read rows using the structured root + optional outgoing pattern (same compiler as `@cyphra/query` {@link compileRootOptionalOutgoingSelect}).
 */
export async function queryRecordsRootOptionalOutgoing(
  client: CyphraClient,
  spec: RootOptionalOutgoingReadSpec,
): Promise<Record<string, unknown>[]> {
  const compiled = compileRootOptionalOutgoingSelect(spec);
  return client.withSession((session) => client.queryRecords(session, compiled));
}

/**
 * Single row (first match) for {@link queryRecordsRootOptionalOutgoing}.
 */
export async function queryRecordRootOptionalOutgoing(
  client: CyphraClient,
  spec: RootOptionalOutgoingReadSpec,
): Promise<Record<string, unknown> | undefined> {
  const rows = await queryRecordsRootOptionalOutgoing(client, spec);
  return rows[0];
}
