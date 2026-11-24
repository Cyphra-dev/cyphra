import type { CyphraClient } from "@cyphra/runtime";
import { GraphQLError } from "graphql";
import neo4j, {
  type Driver,
  type ManagedTransaction,
  type Session,
  type SessionConfig as DriverSessionConfig,
} from "neo4j-driver";
import { APP_ID } from "./subscriptions/engine.js";

/** Transaction metadata of every statement (CDC `onlyGraphQLEvents` selects on `app`). */
const TX_CONFIG = { metadata: { app: APP_ID } };

/**
 * v7 `context.sessionConfig`: the session options of one request (`database`, `impersonatedUser`,
 * `auth`), spread over the defaults when the statement runs through `driver`.
 */
export type SessionConfig = Pick<DriverSessionConfig, "database" | "impersonatedUser" | "auth">;

/** Runs one statement and returns the values of its `this` column. */
export type ReadExecutor = (
  cypher: string,
  params: Record<string, unknown>,
  sessionConfig?: SessionConfig,
) => Promise<unknown[]>;

/**
 * Runs one statement in a write transaction and passes the values of its `this` column to
 * `consume` inside it: when `consume` throws, the transaction is rolled back.
 */
export type WriteExecutor = <T>(
  cypher: string,
  params: Record<string, unknown>,
  consume: (rows: unknown[]) => T,
  sessionConfig?: SessionConfig,
) => Promise<T>;

/**
 * The defined entries of a request's `sessionConfig` (undefined when it sets nothing). A
 * `CyphraClient` owns its sessions: a request that needs other session options throws instead of
 * running on the client's database.
 */
function sessionOverrides(
  sessionConfig: SessionConfig | undefined,
  client: boolean,
): Record<string, unknown> | undefined {
  if (!sessionConfig) return undefined;
  const set = Object.entries(sessionConfig).filter(([, v]) => v !== undefined);
  if (!set.length) return undefined;
  if (client) {
    throw new GraphQLError(
      `context.sessionConfig (${set.map(([k]) => k).join(", ")}) needs makeSchema({ driver }): a CyphraClient runs every statement in its own sessions.`,
    );
  }
  return Object.fromEntries(set);
}

/** Read statements run in read transactions, writes in write transactions (one per statement). */
export type Executors = { read: ReadExecutor; write: WriteExecutor };

export type ExecutorOptions = {
  /** A `neo4j-driver` driver. */
  driver?: Driver;
  /** Or a Cyphra client (`new CyphraClient(...)`). */
  client?: CyphraClient;
  /**
   * Database name for `driver` (default database when omitted). A request's
   * `context.sessionConfig.database` takes precedence, like in v7.
   */
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
      read: async (cypher, params, sessionConfig) => {
        sessionOverrides(sessionConfig, true);
        log(cypher, params);
        return client.instrumentation.operation({ operation: "graphql.read" }, () =>
          client.withReadTransaction((tx) => clientRows(tx, cypher, params, "graphql.read")),
        );
      },
      write: async (cypher, params, consume, sessionConfig) => {
        sessionOverrides(sessionConfig, true);
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
    // Like v7: the request's `sessionConfig` is spread over the defaults (its `database` wins
    // over the one passed to `makeSchema`); the access mode is always the statement's.
    const withSession = async <T>(
      mode: "READ" | "WRITE",
      sessionConfig: SessionConfig | undefined,
      fn: (s: Session) => Promise<T>,
    ) => {
      const session = driver.session({
        database: opts.database,
        ...sessionOverrides(sessionConfig, false),
        defaultAccessMode: neo4j.session[mode],
      });
      try {
        return await fn(session);
      } finally {
        await session.close();
      }
    };
    return {
      read: async (cypher, params, sessionConfig) => {
        log(cypher, params);
        return withSession("READ", sessionConfig, (s) =>
          s.executeRead((tx) => rows(tx, cypher, params), TX_CONFIG),
        );
      },
      write: async (cypher, params, consume, sessionConfig) => {
        log(cypher, params);
        return withSession("WRITE", sessionConfig, (s) =>
          s.executeWrite(async (tx) => consume(await rows(tx, cypher, params)), TX_CONFIG),
        );
      },
    };
  }
  throw new TypeError("@cyphra/graphql: pass `driver` (neo4j-driver) or `client` (CyphraClient).");
}
