import type { CompiledCypher, SelectQuery } from "@cyphra/query";
import { compileCypher } from "@cyphra/query";
import type {
  Config,
  Driver,
  EagerResult,
  ManagedTransaction,
  QueryConfig,
  Session,
} from "neo4j-driver";
import neo4j, { int, isInt } from "neo4j-driver";
import { CyphraNeo4j } from "./adapter.js";
import { eagerResultToPlainRecords, toPlainRecord, toPlainRecords } from "./records.js";
import { mergeSessionConfig } from "./sessionConfig.js";

type SessionRunTransactionConfig = NonNullable<Parameters<Session["run"]>[2]>;

function isPlainParamObject(v: unknown): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

/**
 * Neo4j 5 (GQL) expects INTEGER for `LIMIT` / `SKIP` parameters; the Bolt driver maps plain JS
 * numbers as floats (`1.0`), which the server rejects. Coerce safe integral numbers to {@link int}.
 *
 * Uses named `int` / `isInt` imports so ESM/CJS interop on `import neo4j from "neo4j-driver"` cannot
 * drop `neo4j.int` at runtime (a common Turbopack/Webpack edge case).
 */
function normalizeBoltParam(v: unknown): unknown {
  if (isInt(v)) {
    return v;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const t = Math.trunc(v);
    if (t === v && Math.abs(t) <= Number.MAX_SAFE_INTEGER) {
      return int(t);
    }
    return v;
  }
  if (isPlainParamObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = normalizeBoltParam(val);
    }
    return out;
  }
  if (Array.isArray(v)) {
    return v.map(normalizeBoltParam);
  }
  return v;
}

function neo4jQueryParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = normalizeBoltParam(v);
  }
  return out;
}

export type CyphraRunCompiledOptions = {
  readonly transactionConfig?: SessionRunTransactionConfig;
};

/** Fired after each compiled query finishes (success or failure). Values are never logged. */
export type CyphraQueryInfo = {
  readonly cypher: string;
  readonly paramKeys: readonly string[];
  readonly durationMs: number;
};

/** @deprecated Prefer `{ adapter: CyphraNeo4j }` — kept for backward compatibility. */
export type CyphraClientLegacyOptions = {
  uri?: string;
  /** Alias of {@link uri} (Prisma-style `url`). */
  url?: string;
  user: string;
  password: string;
  database?: string;
  debug?: boolean;
  driverConfig?: Config;
  /** Optional timing / tracing hook (parameter keys only, never values). */
  onQuery?: (info: CyphraQueryInfo) => void;
};

export type CyphraClientAdapterOptions = {
  adapter: CyphraNeo4j;
  debug?: boolean;
  onQuery?: (info: CyphraQueryInfo) => void;
};

export type CyphraClientOptions = CyphraClientAdapterOptions | CyphraClientLegacyOptions;

function isAdapterOptions(o: CyphraClientOptions): o is CyphraClientAdapterOptions {
  return "adapter" in o && o.adapter instanceof CyphraNeo4j;
}

/**
 * Neo4j (Bolt) client: sessions, transactions, and Cyphra’s parameterized `cypher` tag.
 *
 * Prefer `new CyphraClient({ adapter: new CyphraNeo4j({ uri, user, password, database }) })`.
 */
export class CyphraClient {
  private readonly adapter: CyphraNeo4j;
  private readonly debug: boolean;
  private readonly onQuery?: (info: CyphraQueryInfo) => void;

  constructor(opts: CyphraClientOptions) {
    if (isAdapterOptions(opts)) {
      this.adapter = opts.adapter;
      this.debug = opts.debug ?? false;
      this.onQuery = opts.onQuery;
    } else {
      const uri = opts.uri ?? opts.url;
      if (uri === undefined || uri === "") {
        throw new Error("CyphraClient: provide uri or url for the Bolt connection string");
      }
      this.adapter = new CyphraNeo4j({
        uri,
        user: opts.user,
        password: opts.password,
        database: opts.database,
        driverConfig: opts.driverConfig,
      });
      this.debug = opts.debug ?? false;
      this.onQuery = opts.onQuery;
    }
  }

  /** Underlying Bolt driver. */
  get rawDriver(): Driver {
    return this.adapter.driver;
  }

  /** Adapter instance (same driver as {@link rawDriver}). */
  get neo4jAdapter(): CyphraNeo4j {
    return this.adapter;
  }

  /**
   * Bolt session with adapter defaults (e.g. `database`) merged with **`override`**.
   * For read-optimized routing use {@link sessionRead}; for writes {@link sessionWrite}.
   */
  session(override?: import("neo4j-driver").SessionConfig): Session {
    return this.adapter.driver.session(mergeSessionConfig(this.adapter, override));
  }

  /** `session({ defaultAccessMode: neo4j.session.READ, ...override })`. */
  sessionRead(override?: import("neo4j-driver").SessionConfig): Session {
    return this.session({ ...override, defaultAccessMode: neo4j.session.READ });
  }

  /** `session({ defaultAccessMode: neo4j.session.WRITE, ...override })`. */
  sessionWrite(override?: import("neo4j-driver").SessionConfig): Session {
    return this.session({ ...override, defaultAccessMode: neo4j.session.WRITE });
  }

  async runCompiled(
    session: Session,
    compiled: CompiledCypher,
    options?: CyphraRunCompiledOptions,
  ): Promise<ReturnType<Session["run"]>> {
    if (this.debug) {
      console.debug("[cyphra] cypher:", compiled.text, "param keys:", Object.keys(compiled.params));
    }
    const t0 = this.onQuery ? performance.now() : 0;
    try {
      return await session.run(
        compiled.text,
        neo4jQueryParams(compiled.params),
        options?.transactionConfig,
      );
    } finally {
      if (this.onQuery) {
        this.onQuery({
          cypher: compiled.text,
          paramKeys: Object.keys(compiled.params),
          durationMs: performance.now() - t0,
        });
      }
    }
  }

  async runCompiledTx(
    tx: ManagedTransaction,
    compiled: CompiledCypher,
  ): Promise<ReturnType<ManagedTransaction["run"]>> {
    if (this.debug) {
      console.debug("[cyphra] cypher:", compiled.text, "param keys:", Object.keys(compiled.params));
    }
    const t0 = this.onQuery ? performance.now() : 0;
    try {
      return await tx.run(compiled.text, neo4jQueryParams(compiled.params));
    } finally {
      if (this.onQuery) {
        this.onQuery({
          cypher: compiled.text,
          paramKeys: Object.keys(compiled.params),
          durationMs: performance.now() - t0,
        });
      }
    }
  }

  /**
   * Run query with `EXPLAIN` (plan only, no result rows from your query body).
   * Prepends `EXPLAIN ` to the compiled text.
   */
  async explainCompiled(
    session: Session,
    compiled: CompiledCypher,
    options?: CyphraRunCompiledOptions,
  ): Promise<ReturnType<Session["run"]>> {
    return this.runCompiled(
      session,
      { text: `EXPLAIN ${compiled.text}`, params: compiled.params },
      options,
    );
  }

  /**
   * Run query with `PROFILE` (executes and returns plan with stats). Use sparingly in production.
   */
  async profileCompiled(
    session: Session,
    compiled: CompiledCypher,
    options?: CyphraRunCompiledOptions,
  ): Promise<ReturnType<Session["run"]>> {
    return this.runCompiled(
      session,
      { text: `PROFILE ${compiled.text}`, params: compiled.params },
      options,
    );
  }

  /**
   * {@link Driver.executeQuery} with {@link CompiledCypher} and merged **`QueryConfig`** (default `database` from adapter).
   * Prefer {@link session} + {@link runCompiled} for `CALL { … } IN TRANSACTIONS` / periodic commit patterns.
   */
  async executeCompiledQuery<T = EagerResult>(
    compiled: CompiledCypher,
    config?: QueryConfig<T>,
  ): Promise<T> {
    const database = config?.database ?? this.adapter.database;
    const merged: QueryConfig<T> = {
      ...config,
      ...(database !== undefined ? { database } : {}),
    };
    if (this.debug) {
      console.debug(
        "[cyphra] executeQuery:",
        compiled.text,
        "param keys:",
        Object.keys(compiled.params),
      );
    }
    const t0 = this.onQuery ? performance.now() : 0;
    try {
      return await this.adapter.driver.executeQuery(
        compiled.text,
        neo4jQueryParams(compiled.params),
        merged,
      );
    } finally {
      if (this.onQuery) {
        this.onQuery({
          cypher: compiled.text,
          paramKeys: Object.keys(compiled.params),
          durationMs: performance.now() - t0,
        });
      }
    }
  }

  async queryRecordsExecute(
    compiled: CompiledCypher,
    config?: QueryConfig<EagerResult>,
  ): Promise<Record<string, unknown>[]> {
    const eager = await this.executeCompiledQuery(compiled, config);
    return eagerResultToPlainRecords(eager);
  }

  /** Delegates to {@link Driver.verifyConnectivity}; uses adapter `database` when `opts.database` omitted. */
  async verifyConnectivity(opts?: {
    database?: string;
  }): Promise<import("neo4j-driver").ServerInfo> {
    return this.adapter.driver.verifyConnectivity({
      database: opts?.database ?? this.adapter.database,
    });
  }

  /** Delegates to {@link Driver.getServerInfo}; uses adapter `database` when `opts.database` omitted. */
  async getServerInfo(opts?: { database?: string }): Promise<import("neo4j-driver").ServerInfo> {
    return this.adapter.driver.getServerInfo({
      database: opts?.database ?? this.adapter.database,
    });
  }

  async runCypherTx(
    tx: ManagedTransaction,
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<ReturnType<ManagedTransaction["run"]>> {
    const compiled = compileCypher(strings, values);
    return this.runCompiledTx(tx, compiled);
  }

  async runCypher(
    session: Session,
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<ReturnType<Session["run"]>> {
    const compiled = compileCypher(strings, values);
    return this.runCompiled(session, compiled);
  }

  async queryRecords(
    session: Session,
    compiled: CompiledCypher,
    options?: CyphraRunCompiledOptions,
  ): Promise<Record<string, unknown>[]> {
    const result = await this.runCompiled(session, compiled, options);
    return toPlainRecords(result);
  }

  async queryRecord(
    session: Session,
    compiled: CompiledCypher,
    options?: CyphraRunCompiledOptions,
  ): Promise<Record<string, unknown> | undefined> {
    const result = await this.runCompiled(session, compiled, options);
    return toPlainRecord(result);
  }

  async queryRecordsTx(
    tx: ManagedTransaction,
    compiled: CompiledCypher,
  ): Promise<Record<string, unknown>[]> {
    const result = await this.runCompiledTx(tx, compiled);
    return toPlainRecords(result);
  }

  async queryRecordTx(
    tx: ManagedTransaction,
    compiled: CompiledCypher,
  ): Promise<Record<string, unknown> | undefined> {
    const result = await this.runCompiledTx(tx, compiled);
    return toPlainRecord(result);
  }

  async selectRecords(
    session: Session,
    query: SelectQuery,
    options?: CyphraRunCompiledOptions,
  ): Promise<Record<string, unknown>[]> {
    return this.queryRecords(session, query.toCypher(), options);
  }

  async selectRecord(
    session: Session,
    query: SelectQuery,
    options?: CyphraRunCompiledOptions,
  ): Promise<Record<string, unknown> | undefined> {
    return this.queryRecord(session, query.toCypher(), options);
  }

  async selectRecordsTx(
    tx: ManagedTransaction,
    query: SelectQuery,
  ): Promise<Record<string, unknown>[]> {
    return this.queryRecordsTx(tx, query.toCypher());
  }

  async selectRecordTx(
    tx: ManagedTransaction,
    query: SelectQuery,
  ): Promise<Record<string, unknown> | undefined> {
    return this.queryRecordTx(tx, query.toCypher());
  }

  async withSession<T>(
    fn: (session: Session) => Promise<T>,
    sessionConfig?: import("neo4j-driver").SessionConfig,
  ): Promise<T> {
    const session = this.session(sessionConfig);
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  }

  async withWriteTransaction<T>(
    fn: (tx: ManagedTransaction) => Promise<T>,
    sessionConfig?: import("neo4j-driver").SessionConfig,
  ): Promise<T> {
    const session = this.session(sessionConfig);
    try {
      return await session.executeWrite(fn);
    } finally {
      await session.close();
    }
  }

  async withReadTransaction<T>(
    fn: (tx: ManagedTransaction) => Promise<T>,
    sessionConfig?: import("neo4j-driver").SessionConfig,
  ): Promise<T> {
    const session = this.session(sessionConfig);
    try {
      return await session.executeRead(fn);
    } finally {
      await session.close();
    }
  }

  /**
   * Closes the Bolt driver when it was created by legacy options or by a {@link CyphraNeo4j}
   * constructed with URI credentials. If you passed an external driver, it is not closed.
   */
  async close(): Promise<void> {
    await this.adapter.dispose();
  }
}

export type { Config, Driver, ManagedTransaction, Session };
