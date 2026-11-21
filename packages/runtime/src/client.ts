import type { Config, Driver, ManagedTransaction, Session } from "neo4j-driver";
import { compileCypher, type CompiledCypher, type SelectQuery } from "@cyphra/query";
import { createBoltDriver } from "./bolt.js";
import { basicAuth, HttpDriver, type FetchLike } from "./http/driver.js";
import { toPlainRecord, toPlainRecords } from "./records.js";
import { parseDialect, unsupportedOnMemgraph, type CyphraDialect } from "./dialect.js";
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
  /**
   * The database's Cypher flavour: `"neo4j"` (default) or `"memgraph"` (Memgraph 3.x, Bolt
   * only). Not detected automatically: set it when connecting to Memgraph (see `detectDialect`).
   */
  dialect?: CyphraDialect;
};

/** Connect with a Bolt URI and credentials: the client creates (and owns) its own driver. */
export type CyphraConnectionOptions = CommonClientOptions & {
  /** Bolt / Neo4j URI, e.g. `neo4j+s://xxx.databases.neo4j.io`. */
  uri: string;
  user: string;
  password: string;
  /** Third argument to `neo4j.driver` — pool size, acquisition timeout, logging, etc. */
  driverConfig?: Config;
  /**
   * `"bolt"` (`neo4j-driver`, the default for `bolt://` / `neo4j://` URIs) or `"http"` (see
   * {@link CyphraHttpOptions}).
   */
  transport?: "bolt";
  driver?: never;
  token?: never;
  fetch?: never;
};

/**
 * Connect over HTTP with the Neo4j Query API (Neo4j 5.19+ / Aura), for runtimes without TCP
 * sockets: Vercel Edge, Cloudflare Workers, Deno Deploy, browsers. Chosen for an `https://` /
 * `http://` URI, or with `transport: "http"`. Every auto-commit statement is one request; managed
 * transactions (`$transaction`, nested writes) use the explicit transaction endpoints.
 *
 * @example
 * ```ts
 * const client = new CyphraClient({
 *   uri: "https://xxxx.databases.neo4j.io", // Aura; http://localhost:7474 locally
 *   user: env.NEO4J_USERNAME,
 *   password: env.NEO4J_PASSWORD,
 * });
 * ```
 */
export type CyphraHttpOptions = CommonClientOptions & {
  /**
   * Query API base URL: `https://<id>.databases.neo4j.io`, `http://localhost:7474`. With
   * `transport: "http"`, a Bolt URI is mapped too: `neo4j+s://host` → `https://host`,
   * `neo4j://host` → `http://host:7474`.
   */
  uri: string;
  transport?: "http";
  /** Basic auth user (with `password`). */
  user?: string;
  password?: string;
  /** Bearer token (SSO / OIDC) instead of `user` / `password`. */
  token?: string;
  /** Custom `fetch` (tests, proxies, a Worker service binding). Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** How long managed transactions keep retrying transient errors (default 30 000 ms). */
  maxRetryTimeMs?: number;
  /**
   * Transactions and statements in flight at once (default 4). Keep it below the server's HTTP
   * worker threads (`server.threads.worker_count`, one per CPU core by default): requests waiting
   * on a lock hold a thread each, and with none left the lock holder cannot commit.
   */
  maxConcurrency?: number;
  /** How long a statement waits for a free slot (see `maxConcurrency`), default 60 000 ms. */
  acquisitionTimeoutMs?: number;
  driverConfig?: never;
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
  transport?: never;
};

export type CyphraClientOptions = CyphraConnectionOptions | CyphraHttpOptions | CyphraDriverOptions;

/** How a client talks to Neo4j. */
export type CyphraTransport = "bolt" | "http";

function isHttpOptions(
  opts: CyphraConnectionOptions | CyphraHttpOptions,
): opts is CyphraHttpOptions {
  if (opts.transport === "http") return true;
  if (opts.transport === "bolt") return false;
  return /^https?:\/\//i.test(opts.uri);
}

/** The Query API base URL for `uri` (Bolt schemes mapped to their HTTP equivalent). */
export function httpBaseUrl(uri: string): string {
  const u = new URL(uri);
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (scheme === "http" || scheme === "https") return uri;
  const host = u.hostname.includes(":") ? `[${u.hostname}]` : u.hostname;
  if (/^(neo4j|bolt)\+s(sc)?$/.test(scheme)) {
    return `https://${host}${u.port && u.port !== "7687" ? `:${u.port}` : ""}`;
  }
  if (scheme === "neo4j" || scheme === "bolt") return `http://${host}:7474`;
  throw new Error(`Unsupported URI scheme for the HTTP transport: ${scheme}://`);
}

function httpServer(base: string): { address: string; port?: number } {
  const u = new URL(base);
  return {
    address: u.hostname.replace(/^\[|\]$/g, ""),
    port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80,
  };
}

/**
 * Thin facade over `neo4j-driver` (Bolt) or the Neo4j Query API (HTTP, see
 * {@link CyphraHttpOptions}): sessions, transactions, and the Cyphra `cypher` tag.
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

  /** `"bolt"` (`neo4j-driver`) or `"http"` (Neo4j Query API over `fetch`). */
  readonly transport: CyphraTransport;

  /** The Cypher flavour statements are compiled to (`dialect` option, default `"neo4j"`). */
  readonly dialect: CyphraDialect;

  constructor(opts: CyphraClientOptions) {
    let server: { address: string; port?: number } | undefined;
    this.dialect = parseDialect(opts.dialect);
    if (this.dialect === "memgraph" && !opts.driver && isHttpOptions(opts)) {
      throw unsupportedOnMemgraph(
        "The HTTP transport",
        "Memgraph has no Query API; connect over Bolt (bolt://host:7687).",
      );
    }
    if (opts.driver) {
      // A driver from another copy (or major) of `neo4j-driver` is not assignable to this copy's
      // `Driver` class type, but it is the same API at runtime: values are recognised by the
      // driver's structural markers (`isInt`, `isDateTime`, ...), not by `instanceof`.
      this.driver = opts.driver as unknown as Driver;
      this.ownsDriver = false;
      this.transport = "bolt";
    } else if (isHttpOptions(opts)) {
      const url = httpBaseUrl(opts.uri);
      const authorization = opts.token
        ? `Bearer ${opts.token}`
        : opts.user !== undefined
          ? basicAuth(opts.user, opts.password ?? "")
          : undefined;
      // The HTTP driver has the `Driver` / `Session` / `ManagedTransaction` subset Cyphra uses.
      this.driver = new HttpDriver({
        url,
        authorization,
        database: opts.database,
        fetch: opts.fetch,
        headers: opts.headers,
        maxRetryTimeMs: opts.maxRetryTimeMs,
        maxConcurrency: opts.maxConcurrency,
        acquisitionTimeoutMs: opts.acquisitionTimeoutMs,
      }) as unknown as Driver;
      this.ownsDriver = true;
      this.transport = "http";
      server = httpServer(url);
    } else {
      this.driver = createBoltDriver(
        opts.uri,
        opts.user,
        opts.password,
        opts.driverConfig,
      ) as unknown as Driver;
      this.ownsDriver = true;
      this.transport = "bolt";
      server = serverFromUri(opts.uri);
    }
    this.database = opts.database;
    this.instrumentation = new Instrumentation({
      log: opts.log,
      logParams: opts.logParams,
      tracer: opts.tracer,
      traceQueryText: opts.traceQueryText,
      // Missing-index checks read Neo4j's EXPLAIN plans, which Memgraph returns as rows.
      warnMissingIndexes: this.dialect === "memgraph" ? false : opts.warnMissingIndexes,
      debug: opts.debug,
      database: opts.database,
      server,
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

  /**
   * Underlying driver for advanced use. With the HTTP transport this is an
   * {@link import("./http/driver.js").HttpDriver}, which implements only the `session()` /
   * `run` / `executeRead` / `executeWrite` subset of `Driver`.
   */
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
