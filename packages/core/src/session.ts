/**
 * Minimal session shape Cyphra uses for migrations and DDL (provider-agnostic).
 * Neo4j’s `Session` satisfies this structurally (`run` returns a thenable `Result`).
 */
export type CyphraSession = {
  run(text: string, params?: Record<string, unknown>): PromiseLike<unknown>;
  close(): void | Promise<void>;
};

/**
 * Managed transaction handle (read or write) with parameterized Cypher execution.
 */
export type CyphraManagedTransaction = {
  run(text: string, params?: Record<string, unknown>): PromiseLike<unknown>;
};
