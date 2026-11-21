import neo4j, {
  type Config,
  type Driver,
  type ManagedTransaction,
  type Session,
} from "neo4j-driver";
import { compileCypher, type CompiledCypher, type SelectQuery } from "@cyphra/query";
import { toPlainRecord, toPlainRecords } from "./records.js";
import {
  Instrumentation,
  serverFromUri,
  type CyphraEvent,
  type LogLevel,
  type ObservabilityOptions,
  type QueryMeta,
} from "./observability.js";

type Params = Record<string, unknown>;

/**
 * Minimal structural shape of a `neo4j-driver` managed transaction, as Cyphra uses it.
 * Declared structurally so transactions from either supported driver major (5.x or 6.x) fit.
 */
export interface TransactionLike {
  run(query: string, parameters?: Params): PromiseLike<unknown>;
}

/** Minimal structural shape of a `neo4j-driver` session, as Cyphra uses it. */
export interface SessionLike {
  run(query: string, parameters?: Params): PromiseLike<unknown>;
  executeRead<T>(work: (tx: TransactionLike) => Promise<T> | T): Promise<T>;
  executeWrite<T>(work: (tx: TransactionLike) => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
}

/**
 * Minimal structural shape of a `neo4j-driver` `Driver`. Any `Driver` from `neo4j-driver` 5.28+ or
 * 6.x satisfies it, even when it comes from a different copy of the package than the one Cyphra
 * resolves (the driver's classes are not structurally assignable across copies, this type is).
 */
export interface DriverLike {
  session(config?: { database?: string }): SessionLike;
  close(): Promise<void>;
}

type CommonClientOptions = ObservabilityOptions & {
  /** Optional database name (Neo4j 4+). */
  database?: string;
};

/** Connect with a URI and credentials: the client creates (and owns) its own driver. */
export type CyphraConnectionOptions = CommonClientOptions & {
  /** Bolt / Neo4j URI, e.g. `neo4j+s://xxx.databases.neo4j.io`. */
  uri: string;
  user: string;
  password: string;
  /** Third argument to `neo4j.driver` — pool size, acquisition timeout, logging, etc. */
  driverConfig?: Config;
  driver?: never;
};

/**
 * Reuse a `Driver` your application already created (`neo4j-driver` 5.28+ or 6.x). The client
 * shares its connection pool and never closes it: {@link CyphraClient.close} is a no-op, close
 * the driver yourself on shutdown.
 */
export type CyphraDriverOptions = CommonClientOptions & {
  driver: DriverLike;
  uri?: never;
  user?: never;
  password?: never;
  driverConfig?: never;
};

export type CyphraClientOptions = CyphraConnectionOptions | CyphraDriverOptions;

/**
 * Thin facade over `neo4j-driver`: sessions, transactions, and the Cyphra `cypher` tag.
 *
 * @example
 * ```ts
 * const client = new CyphraClient({
 *   uri: process.env.NEO4J_URI!,
 *   user: process.env.NEO4J_USERNAME!,
 *   password: process.env.NEO4J_PASSWORD!,
 * });
 * const session = client.session();
 * try {
 *   import { cypher } from "@cyphra/query";
 *   await client.runCompiled(session, cypher`RETURN 1 AS n`);
 * } finally {
 *   await session.close();
 * }
 * await client.close();
 *
 * // Or share a driver your app already has (neo4j-driver 5.28+ or 6.x):
 * const shared = new CyphraClient({ driver: neo4j.driver(uri, neo4j.auth.basic(user, password)) });
 * ```
 */
export class CyphraClient {
  private readonly driver: Driver;
  private readonly ownsDriver: boolean;
  private readonly database?: string;
  /**
   * Query events, spans and index warnings for this client. Used by the ORM and
   * `@cyphra/graphql`; prefer {@link CyphraClient.on} in application code.
   */
  readonly instrumentation: Instrumentation;

  constructor(opts: CyphraClientOptions) {
    if (opts.driver) {
      // A driver from another copy (or major) of `neo4j-driver` is not assignable to this copy's
      // `Driver` class type, but it is the same API at runtime: values are recognised by the
      // driver's structural markers (`isInt`, `isDateTime`, ...), not by `instanceof`.
      this.driver = opts.driver as unknown as Driver;
      this.ownsDriver = false;
    } else {
      this.driver = neo4j.driver(
        opts.uri,
        neo4j.auth.basic(opts.user, opts.password),
        opts.driverConfig,
      );
      this.ownsDriver = true;
    }
    this.database = opts.database;
    this.instrumentation = new Instrumentation({
      log: opts.log,
      logParams: opts.logParams,
      tracer: opts.tracer,
      traceQueryText: opts.traceQueryText,
      warnMissingIndexes: opts.warnMissingIndexes,
      debug: opts.debug,
      database: opts.database,
      server: opts.uri ? serverFromUri(opts.uri) : undefined,
      openSession: () => this.driver.session({ database: this.database }),
    });
  }

  /**
   * Listen to `"query"`, `"warn"` or `"error"` events (see {@link ObservabilityOptions.log}).
   * Returns a function that removes the listener.
   *
   * @example
   * ```ts
   * client.on("query", (e) => metrics.observe(e.durationMs, { op: e.operation }));
   * ```
   */
  on<L extends LogLevel>(
    level: L,
    listener: (event: Extract<CyphraEvent, { type: L }>) => void,
  ): () => void {
    return this.instrumentation.on(level, listener);
  }

  /** Underlying driver for advanced use. */
  get rawDriver(): Driver {
    return this.driver;
  }

  /** Create a new session (caller must `close()`). */
  session(): Session {
    return this.driver.session({ database: this.database });
  }

  /**
   * Run a compiled query (auto-commit). Emits a `query` / `error` event and a statement span when
   * logging or tracing is on; parameter values are redacted unless `logParams` is set.
   */
  async runCompiled(
    session: Session,
    compiled: CompiledCypher,
    meta: QueryMeta = {},
  ): Promise<ReturnType<Session["run"]>> {
    const params = compiled.params as Record<string, unknown>;
    return this.instrumentation.run(compiled.text, params, { transaction: false, ...meta }, () =>
      session.run(compiled.text, params),
    ) as unknown as ReturnType<Session["run"]>;
  }

  /**
   * Like {@link runCompiled}, but on a managed transaction from {@link withWriteTransaction} /
   * {@link withReadTransaction}.
   */
  async runCompiledTx(
    tx: TransactionLike,
    compiled: CompiledCypher,
    meta: QueryMeta = {},
  ): Promise<ReturnType<ManagedTransaction["run"]>> {
    const params = compiled.params as Record<string, unknown>;
    return this.instrumentation.run(compiled.text, params, { transaction: true, ...meta }, () =>
      tx.run(compiled.text, params),
    ) as unknown as ReturnType<ManagedTransaction["run"]>;
  }

  /**
   * Tagged template executed on `tx` (values are parameterized).
   */
  async runCypherTx(
    tx: ManagedTransaction,
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<ReturnType<ManagedTransaction["run"]>> {
    const compiled = compileCypher(strings, values);
    return this.runCompiledTx(tx, compiled);
  }

  /**
   * Tagged template executed on `session` (values are parameterized).
   *
   * @param session - Open Neo4j session.
   * @param strings - Template literal static parts.
   * @param values - Interpolated parameter values.
   */
  async runCypher(
    session: Session,
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<ReturnType<Session["run"]>> {
    const compiled = compileCypher(strings, values);
    return this.runCompiled(session, compiled);
  }

  /**
   * Run compiled Cypher and map rows to plain objects (`record.toObject()`).
   *
   * @param session - Open session.
   * @param compiled - From {@link compileCypher}, {@link import("@cyphra/query").cypher}, or {@link SelectQuery.toCypher}.
   */
  async queryRecords(
    session: Session,
    compiled: CompiledCypher,
  ): Promise<Record<string, unknown>[]> {
    const result = await this.runCompiled(session, compiled);
    return toPlainRecords(result);
  }

  /**
   * First row as a plain object, or `undefined` if empty.
   *
   * @param session - Open session.
   * @param compiled - Compiled query.
   */
  async queryRecord(
    session: Session,
    compiled: CompiledCypher,
  ): Promise<Record<string, unknown> | undefined> {
    const result = await this.runCompiled(session, compiled);
    return toPlainRecord(result);
  }

  /** {@link queryRecords} on a managed transaction. */
  async queryRecordsTx(
    tx: ManagedTransaction,
    compiled: CompiledCypher,
  ): Promise<Record<string, unknown>[]> {
    const result = await this.runCompiledTx(tx, compiled);
    return toPlainRecords(result);
  }

  /** {@link queryRecord} on a managed transaction. */
  async queryRecordTx(
    tx: ManagedTransaction,
    compiled: CompiledCypher,
  ): Promise<Record<string, unknown> | undefined> {
    const result = await this.runCompiledTx(tx, compiled);
    return toPlainRecord(result);
  }

  /** Shorthand for {@link queryRecords} with a {@link SelectQuery}. */
  async selectRecords(session: Session, query: SelectQuery): Promise<Record<string, unknown>[]> {
    return this.queryRecords(session, query.toCypher());
  }

  /** Shorthand for {@link queryRecord} with a {@link SelectQuery}. */
  async selectRecord(
    session: Session,
    query: SelectQuery,
  ): Promise<Record<string, unknown> | undefined> {
    return this.queryRecord(session, query.toCypher());
  }

  /** {@link selectRecords} on a managed transaction. */
  async selectRecordsTx(
    tx: ManagedTransaction,
    query: SelectQuery,
  ): Promise<Record<string, unknown>[]> {
    return this.queryRecordsTx(tx, query.toCypher());
  }

  /** {@link selectRecord} on a managed transaction. */
  async selectRecordTx(
    tx: ManagedTransaction,
    query: SelectQuery,
  ): Promise<Record<string, unknown> | undefined> {
    return this.queryRecordTx(tx, query.toCypher());
  }

  /** Open a session, run `fn`, always close the session. */
  async withSession<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    const session = this.session();
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  }

  /**
   * Execute work inside a write transaction.
   *
   * @param fn - Receives a managed transaction from the driver.
   */
  async withWriteTransaction<T>(fn: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    const session = this.session();
    try {
      return await session.executeWrite(fn);
    } finally {
      await session.close();
    }
  }

  /**
   * Execute work inside a read transaction.
   */
  async withReadTransaction<T>(fn: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    const session = this.session();
    try {
      return await session.executeRead(fn);
    } finally {
      await session.close();
    }
  }

  /**
   * Close the driver (call on shutdown). A driver passed in with `{ driver }` is left open: its
   * owner closes it.
   */
  async close(): Promise<void> {
    await this.instrumentation.flush();
    if (this.ownsDriver) await this.driver.close();
  }
}

export type { Config, Driver, ManagedTransaction, Session };
