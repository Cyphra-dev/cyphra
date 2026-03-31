import type { CompiledGraphQuery } from "./compiled.js";
import type { CyphraManagedTransaction, CyphraSession } from "./session.js";

/**
 * Client contract used by `@cyphra/migrator` and tooling. Each graph provider implements this
 * (e.g. `@cyphra/provider-neo4j` / `CyphraClient`).
 */
export type CyphraDriverClient = {
  withSession<T>(fn: (session: CyphraSession) => Promise<T>): Promise<T>;
  withReadTransaction<T>(fn: (tx: CyphraManagedTransaction) => Promise<T>): Promise<T>;
  withWriteTransaction<T>(fn: (tx: CyphraManagedTransaction) => Promise<T>): Promise<T>;
  runCypher(
    session: CyphraSession,
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): PromiseLike<unknown>;
  runCompiled(session: CyphraSession, compiled: CompiledGraphQuery): PromiseLike<unknown>;
  runCompiledTx(tx: CyphraManagedTransaction, compiled: CompiledGraphQuery): PromiseLike<unknown>;
};
