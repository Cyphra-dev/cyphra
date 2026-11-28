import type { Session } from "neo4j-driver";
import { toNative, type CyphraClient } from "@cyphra/runtime";
import { wrapInTransactions } from "./batch.js";
import {
  compileRenameLabel,
  compileRenameProperty,
  compileRenameRelationshipType,
  type RenameRelationshipTypeOptions,
} from "./rename.js";
import { isMemgraphDdl, memgraphDdl } from "./memgraph.js";
import { withMemgraphStorageAccess } from "./memgraphAccess.js";
import { falkordbDdl, isFalkorDBDdl, runFalkorDBDdl } from "./falkordb.js";

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
  /**
   * Execute a Cypher statement given as **trusted text** (used by generated migrations for DDL, which
   * cannot be parameterized). Pass values through `params`, never by string concatenation.
   *
   * @returns Rows as plain JS objects (integers → number, temporals → Date).
   */
  execute(text: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  /** Structural / data helpers (validated identifiers only). */
  readonly migrate: MigrationMigrateHelpers;
};

export type MigrationMigrateHelpers = {
  renameLabel(opts: { from: string; to: string }): Promise<void>;
  renameProperty(opts: { label: string; from: string; to: string }): Promise<void>;
  /**
   * Rename a relationship type: recreate each `from` edge (between `startLabel` and `endLabel`
   * nodes, when given) as a `to` edge with the same properties.
   */
  renameRelationshipType(opts: RenameRelationshipTypeOptions): Promise<void>;
};

/**
 * Build a {@link MigrationDb} bound to one open session (one migration transaction policy).
 *
 * @param client - Cyphra runtime client.
 * @param session - Neo4j session (caller manages lifecycle).
 */
export function createMigrationDb(client: CyphraClient, session: Session): MigrationDb {
  const dialect = (client as { dialect?: string }).dialect;
  const memgraph = dialect === "memgraph";
  const falkordb = dialect === "falkordb";
  // On Memgraph and FalkorDB, Cyphra's DDL in Neo4j syntax (a migration generated before
  // `"dialect"` was set) is translated; everything else runs as written.
  const ddl = (text: string) =>
    memgraph
      ? (memgraphDdl(text)?.create ?? text)
      : falkordb
        ? (falkordbDdl(text)?.create ?? text)
        : text;
  // FalkorDB DDL has no IF [NOT] EXISTS: run it with those semantics (see runFalkorDBDdl).
  const runDdl = async (text: string): Promise<boolean> => {
    if (!falkordb || !isFalkorDBDdl(text)) return false;
    await runFalkorDBDdl((t) => session.run(t), text);
    return true;
  };
  const run = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<void> => {
    if (falkordb && values.length === 0 && (await runDdl(ddl(strings.join(""))))) return;
    if (memgraph && values.length === 0) {
      const text = strings.join("");
      const translated = ddl(text);
      if (translated !== text || isMemgraphDdl(text)) {
        await withMemgraphStorageAccess(() => session.run(translated));
        return;
      }
    }
    const result = await client.runCypher(session, strings, ...values);
    await result;
  };

  const runInTransactionBatches = async (opts: {
    inner: string;
    batchSize: number;
    params?: Record<string, unknown>;
  }): Promise<void> => {
    const text = wrapInTransactions(
      opts.inner,
      opts.batchSize,
      memgraph ? "memgraph" : falkordb ? "falkordb" : "neo4j",
    );
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
    async renameRelationshipType(opts) {
      const { text, params } = compileRenameRelationshipType(opts);
      await session.run(text, params);
    },
  };

  const execute = async (
    text: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> => {
    const statement = ddl(text);
    if (Object.keys(params).length === 0 && (await runDdl(statement))) return [];
    // Memgraph DDL waits for running transactions: see withMemgraphStorageAccess.
    const result =
      memgraph && isMemgraphDdl(statement)
        ? await withMemgraphStorageAccess(() => session.run(statement, params))
        : await session.run(statement, params);
    return result.records.map((r) => toNative(r.toObject()) as Record<string, unknown>);
  };

  return { run, runInTransactionBatches, execute, migrate };
}
