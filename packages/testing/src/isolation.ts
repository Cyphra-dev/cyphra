import { CYPHRA_MIGRATION_LABEL } from "@cyphra/migrator";
import type { CyphraClient, ManagedTransaction } from "@cyphra/runtime";
import { lowLevelClient, type ClientLike } from "./schema.js";

/** Rows per transaction when Neo4j deletes nodes (`CALL { … } IN TRANSACTIONS`). */
const WIPE_BATCH_SIZE = 10_000;

export type WipeOptions = {
  /**
   * Only delete nodes with one of these labels (for suites that share a database with others).
   * Default: every node.
   */
  labels?: readonly string[];
  /**
   * Keep Cyphra's `__CyphraMigration` records (default `true`), so the migrations already applied
   * are not run again. Ignored with `labels`.
   */
  keepMigrations?: boolean;
};

function quoteLabel(label: string): string {
  return "`" + label.replace(/`/g, "``") + "`";
}

/**
 * Delete nodes and their relationships; constraints and indexes are kept. The isolation that
 * works everywhere (Neo4j Community has a single user database, FalkorDB has no multi-statement
 * transactions): call it in `beforeEach` (or `afterEach`).
 *
 * @example
 * ```ts
 * beforeEach(() => wipeDatabase(db));
 * ```
 */
export async function wipeDatabase(target: ClientLike, options: WipeOptions = {}): Promise<void> {
  const client = lowLevelClient(target);
  const keepMigrations = options.keepMigrations ?? true;
  const patterns = options.labels
    ? options.labels.map((l) => `MATCH (n:${quoteLabel(l)})`)
    : [keepMigrations ? `MATCH (n) WHERE NOT n:${CYPHRA_MIGRATION_LABEL}` : "MATCH (n)"];
  await client.withSession(async (session) => {
    for (const match of patterns) {
      // `session.run` is an auto-commit transaction, which Neo4j's IN TRANSACTIONS requires.
      await session.run(
        client.dialect === "neo4j"
          ? `${match} CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF ${WIPE_BATCH_SIZE} ROWS`
          : `${match} DETACH DELETE n`,
      );
    }
  });
}

/** Thrown inside the transaction to roll it back; never escapes {@link withRollback}. */
class Rollback extends Error {
  constructor() {
    super("@cyphra/testing: rollback");
    this.name = "Rollback";
  }
}

function isRollback(e: unknown, signal: Rollback): boolean {
  for (let cur = e, depth = 0; cur && depth < 5; depth++) {
    if (cur === signal) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** A client with `$transaction`: an ORM client (generated `createClient`), extended or not. */
export type TransactionalClient<Tx> = {
  $transaction(fn: (tx: Tx) => Promise<unknown>): Promise<unknown>;
};

/**
 * Run `fn` in a write transaction that is always rolled back, and return what `fn` returned.
 * Everything written through `tx` is visible inside `fn` and gone afterwards, so tests do not see
 * each other's data and nothing needs cleaning up. Works on Neo4j (Community included) and
 * Memgraph; FalkorDB has no multi-statement transactions (use {@link wipeDatabase}).
 *
 * Only writes made through `tx` are rolled back: the code under test must take the client as a
 * parameter (pass it `tx`). Code that calls `db.$transaction` itself opens its own transaction,
 * which commits: wipe the database for those tests instead.
 *
 * @example
 * ```ts
 * it("creates a post", () =>
 *   withRollback(db, async (tx) => {
 *     await createPost(tx, { title: "Hello" });
 *     expect(await tx.post.count()).toBe(1);
 *   }));
 * ```
 */
export function withRollback<Tx, T>(
  db: TransactionalClient<Tx>,
  fn: (tx: Tx) => Promise<T>,
): Promise<T>;
/** {@link withRollback} on a `CyphraClient`: `fn` gets the driver's managed transaction. */
export function withRollback<T>(
  client: CyphraClient,
  fn: (tx: ManagedTransaction) => Promise<T>,
): Promise<T>;
export async function withRollback<T>(
  db: TransactionalClient<unknown> | CyphraClient,
  fn: (tx: never) => Promise<T>,
): Promise<T> {
  const signal = new Rollback();
  let result: T | undefined;
  const work = async (tx: unknown) => {
    result = await fn(tx as never);
    throw signal;
  };
  try {
    if ("$transaction" in db) await db.$transaction(work);
    else await db.withWriteTransaction(work);
  } catch (e) {
    if (!isRollback(e, signal)) throw e;
  }
  return result as T;
}
