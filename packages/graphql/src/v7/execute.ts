import type { CyphraClient } from "@cyphra/runtime";
import neo4j, { type Driver, type ManagedTransaction, type Session } from "neo4j-driver";

/** Runs one statement and returns the values of its `this` column. */
export type ReadExecutor = (cypher: string, params: Record<string, unknown>) => Promise<unknown[]>;

/**
 * Runs one statement in a write transaction and passes the values of its `this` column to
 * `consume` inside it: when `consume` throws, the transaction is rolled back.
 */
export type WriteExecutor = <T>(
  cypher: string,
  params: Record<string, unknown>,
  consume: (rows: unknown[]) => T,
) => Promise<T>;

/** Read statements run in read transactions, writes in write transactions (one per statement). */
export type Executors = { read: ReadExecutor; write: WriteExecutor };

export type ExecutorOptions = {
  /** A `neo4j-driver` driver. */
  driver?: Driver;
  /** Or a Cyphra client (`new CyphraClient(...)`). */
  client?: CyphraClient;
  /** Database name for `driver` (default database when omitted). */
  database?: string;
  /** Log each generated statement and its parameter keys (never values). */
  debug?: boolean;
};

export function createReadExecutor(opts: ExecutorOptions): ReadExecutor {
  return createExecutors(opts).read;
}

export function createExecutors(opts: ExecutorOptions): Executors {
  const log = (cypher: string, params: Record<string, unknown>) => {
    if (opts.debug)
      console.debug("[cyphra/graphql] cypher:", cypher, "param keys:", Object.keys(params));
  };
  type Tx = Pick<ManagedTransaction, "run">;
  const rows = async (tx: Tx, cypher: string, params: Record<string, unknown>) =>
    (await tx.run(cypher, params)).records.map((r) => r.get("this") as unknown);
  if (opts.client) {
    // Through the client's instrumentation: `query` / `error` events, OpenTelemetry spans and
    // missing-index warnings configured on the CyphraClient apply to GraphQL statements too.
    const client = opts.client;
    const clientRows = async (
      tx: Tx,
      cypher: string,
      params: Record<string, unknown>,
      op: string,
    ) =>
      (
        (await client.runCompiledTx(
          tx,
          { text: cypher, params },
          { operation: op, transaction: false },
        )) as unknown as { records: { get(key: string): unknown }[] }
      ).records.map((r) => r.get("this"));
    return {
      read: async (cypher, params) => {
        log(cypher, params);
        return client.instrumentation.operation({ operation: "graphql.read" }, () =>
          client.withReadTransaction((tx) => clientRows(tx, cypher, params, "graphql.read")),
        );
      },
      write: async (cypher, params, consume) => {
        log(cypher, params);
        return client.instrumentation.operation({ operation: "graphql.write" }, () =>
          client.withWriteTransaction(async (tx) =>
            consume(await clientRows(tx, cypher, params, "graphql.write")),
          ),
        );
      },
    };
  }
  if (opts.driver) {
    const driver = opts.driver;
    const withSession = async <T>(mode: "READ" | "WRITE", fn: (s: Session) => Promise<T>) => {
      const session = driver.session({
        database: opts.database,
        defaultAccessMode: neo4j.session[mode],
      });
      try {
        return await fn(session);
      } finally {
        await session.close();
      }
    };
    return {
      read: async (cypher, params) => {
        log(cypher, params);
        return withSession("READ", (s) => s.executeRead((tx) => rows(tx, cypher, params)));
      },
      write: async (cypher, params, consume) => {
        log(cypher, params);
        return withSession("WRITE", (s) =>
          s.executeWrite(async (tx) => consume(await rows(tx, cypher, params))),
        );
      },
    };
  }
  throw new TypeError("@cyphra/graphql: pass `driver` (neo4j-driver) or `client` (CyphraClient).");
}
