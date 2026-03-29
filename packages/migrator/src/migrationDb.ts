import type { Session } from "neo4j-driver";
import type { CyphraClient } from "@cyphra/runtime";
import { wrapInTransactions } from "./batch.js";
import { compileRenameLabel, compileRenameProperty } from "./rename.js";

/**
 * Database handle passed to `up()` in {@link defineMigration}.
 */
export type MigrationDb = {
  /**
   * Execute parameterized Cypher (tagged template); values are never concatenated as raw Cypher.
   */
  run(strings: TemplateStringsArray, ...values: unknown[]): Promise<void>;
  /**
   * Run a subquery inside `CALL { … } IN TRANSACTIONS OF n ROWS` (Neo4j 5+).
   * `inner` is the body only (no `CALL` wrapper); it should typically batch work with `LIMIT`/`WITH`.
   *
   * @param opts.inner - Cypher inside the implicit subquery.
   * @param opts.batchSize - Rows per transaction (must be ≥ 1).
   * @param opts.params - Optional parameters for the outer `run`.
   */
  runInTransactionBatches(opts: {
    inner: string;
    batchSize: number;
    params?: Record<string, unknown>;
  }): Promise<void>;
  /** Structural / data helpers (validated identifiers only). */
  readonly migrate: MigrationMigrateHelpers;
};

export type MigrationMigrateHelpers = {
  renameLabel(opts: { from: string; to: string }): Promise<void>;
  renameProperty(opts: { label: string; from: string; to: string }): Promise<void>;
};

/**
 * Build a {@link MigrationDb} bound to one open session (one migration transaction policy).
 *
 * @param client - Cyphra runtime client.
 * @param session - Neo4j session (caller manages lifecycle).
 */
export function createMigrationDb(client: CyphraClient, session: Session): MigrationDb {
  const run = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<void> => {
    const result = await client.runCypher(session, strings, ...values);
    await result;
  };

  const runInTransactionBatches = async (opts: {
    inner: string;
    batchSize: number;
    params?: Record<string, unknown>;
  }): Promise<void> => {
    const text = wrapInTransactions(opts.inner, opts.batchSize);
    const result = await session.run(text, opts.params ?? {});
    await result;
  };

  const migrate: MigrationMigrateHelpers = {
    async renameLabel(opts) {
      const { text, params } = compileRenameLabel(opts.from, opts.to);
      await session.run(text, params);
    },
    async renameProperty(opts) {
      const { text, params } = compileRenameProperty(opts.label, opts.from, opts.to);
      await session.run(text, params);
    },
  };

  return { run, runInTransactionBatches, migrate };
}
