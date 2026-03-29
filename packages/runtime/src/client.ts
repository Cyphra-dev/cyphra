import neo4j, {
  type Config,
  type Driver,
  type ManagedTransaction,
  type Session,
} from "neo4j-driver";
import { compileCypher, type CompiledCypher, type SelectQuery } from "@cyphra/query";
import { toPlainRecord, toPlainRecords } from "./records.js";

export type CyphraClientOptions = {
  /** Bolt / Neo4j URI, e.g. `neo4j+s://xxx.databases.neo4j.io`. */
  uri: string;
  user: string;
  password: string;
  /** Optional database name (Neo4j 4+). */
  database?: string;
  /** When true, logs compiled Cypher and parameter keys (never values). */
  debug?: boolean;
  /** Third argument to `neo4j.driver` — pool size, acquisition timeout, logging, etc. */
  driverConfig?: Config;
};

/**
 * Thin facade over `neo4j-driver`: sessions, transactions, and the Cyphra `cypher` tag.
 *
 * @example
 * ```ts
 * const client = new CyphraClient({
 *   uri: process.env.NEO4J_URI!,
 *   user: process.env.NEO4J_USER!,
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
 * ```
 */
export class CyphraClient {
  private readonly driver: Driver;
  private readonly database?: string;
  private readonly debug: boolean;

  constructor(opts: CyphraClientOptions) {
    this.driver = neo4j.driver(
      opts.uri,
      neo4j.auth.basic(opts.user, opts.password),
      opts.driverConfig,
    );
    this.database = opts.database;
    this.debug = opts.debug ?? false;
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
   * Run a compiled query. Parameter **values** are never logged when `debug` is on.
   */
  async runCompiled(
    session: Session,
    compiled: CompiledCypher,
  ): Promise<ReturnType<Session["run"]>> {
    if (this.debug) {
      console.debug("[cyphra] cypher:", compiled.text, "param keys:", Object.keys(compiled.params));
    }
    return session.run(compiled.text, compiled.params);
  }

  /**
   * Like {@link runCompiled}, but on a managed transaction from {@link withWriteTransaction} /
   * {@link withReadTransaction}.
   */
  async runCompiledTx(
    tx: ManagedTransaction,
    compiled: CompiledCypher,
  ): Promise<ReturnType<ManagedTransaction["run"]>> {
    if (this.debug) {
      console.debug("[cyphra] cypher:", compiled.text, "param keys:", Object.keys(compiled.params));
    }
    return tx.run(compiled.text, compiled.params);
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

  /** Close the driver (call on shutdown). */
  async close(): Promise<void> {
    await this.driver.close();
  }
}

export type { Config, Driver, ManagedTransaction, Session };
