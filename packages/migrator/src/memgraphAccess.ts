/**
 * Waiting for Memgraph's storage access on DDL: Memgraph runs index and constraint DDL only when no
 * other transaction is running (text index DDL needs unique access to the storage) and gives up
 * after `--storage-access-timeout-sec` (1 s by default) with a transient error. Kept apart from
 * `memgraph.ts` so that `tracker.ts` can use it without an import cycle.
 *
 * @packageDocumentation
 */

/**
 * Memgraph's error when a statement cannot get the storage access it needs within
 * `--storage-access-timeout-sec` (1 s by default): index and constraint DDL waits for every other
 * running transaction (and for a periodic snapshot) to finish, text index DDL needs unique access.
 * Memgraph raises it before running anything, so running the statement again is safe.
 */
export function isMemgraphStorageAccessError(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  return (
    typeof err?.code === "string" &&
    err.code.startsWith("Memgraph.TransientError") &&
    typeof err.message === "string" &&
    /cannot get (?:unique|read-only|read) access to the storage/i.test(err.message)
  );
}

/** Retry policy of {@link withMemgraphStorageAccess}. */
export type MemgraphStorageAccessRetry = {
  /** Give up after this long (default 60 000 ms); the last error is raised. */
  readonly timeoutMs?: number;
  /** First delay between attempts (default 100 ms), doubled up to 2 s. */
  readonly initialDelayMs?: number;
  /** For tests. */
  readonly sleep?: (ms: number) => Promise<void>;
};

/**
 * `run()` (one DDL statement in its own auto-commit transaction), run again with exponential
 * backoff while Memgraph reports {@link isMemgraphStorageAccessError}: a migration or `cyphra db
 * push` on a Memgraph that is serving other transactions waits for them instead of failing.
 * Other errors are raised at once.
 */
export async function withMemgraphStorageAccess<T>(
  run: () => Promise<T>,
  opts: MemgraphStorageAccessRetry = {},
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let waited = 0;
  let delay = opts.initialDelayMs ?? 100;
  const timeout = opts.timeoutMs ?? 60_000;
  for (;;) {
    try {
      return await run();
    } catch (e) {
      if (!isMemgraphStorageAccessError(e) || waited + delay > timeout) throw e;
      await sleep(delay);
      waited += delay;
      delay = Math.min(delay * 2, 2_000);
    }
  }
}
