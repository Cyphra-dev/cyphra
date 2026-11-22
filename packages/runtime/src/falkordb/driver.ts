/**
 * FalkorDB transport: `GRAPH.QUERY` / `GRAPH.RO_QUERY` over the Redis protocol, with the official
 * `falkordb` client (an optional peer dependency, loaded on first use).
 *
 * {@link FalkorDBDriver} has the shape of the `neo4j-driver` subset `CyphraClient` uses
 * (`session()`, `session.run()`, `session.executeRead/executeWrite()`, `tx.run()`), like the HTTP
 * transport, so the client, the ORM and the instrumentation run unchanged on top of it. Every
 * statement is rewritten to FalkorDB's Cypher first (`rewrite.ts`) and its parameters sent as the
 * `CYPHER …` header (`codec.ts`).
 *
 * **Transactions.** FalkorDB runs each statement atomically (one writer at a time per graph) but
 * has no multi-statement transactions. `executeRead` / `executeWrite` run their statements one
 * after the other on the graph; a failure does not undo the statements that already ran. Write
 * work of one driver is serialized (one `executeWrite` at a time), so the multi-statement ORM
 * operations of one process do not interleave. The ORM's `$transaction` refuses to run (see
 * `UnsupportedFeatureError`) rather than promise a rollback it cannot do.
 *
 * **DDL.** `GRAPH.CONSTRAINT CREATE|DROP UNIQUE|MANDATORY NODE|RELATIONSHIP <label> PROPERTIES
 * <n> <prop>…` is a Redis command, not Cypher: the driver recognises that text as a statement
 * and runs the command (creating the range indexes a unique constraint needs, then waiting until
 * the constraint is enforced), so the migrator can treat it like any other DDL statement.
 *
 * @packageDocumentation
 */

import { CyphraError } from "../orm/errors.js";
import { HttpRecord } from "../http/driver.js";
import { decodeValue, paramsHeader } from "./codec.js";
import { createdRelationshipTypes, rewriteForFalkorDB, tokenize } from "./rewrite.js";
import { loadFalkorDB } from "./load.js";

type Params = Record<string, unknown>;

/** A parsed `falkordb` reply (`graph.query()`). */
export type FalkorDBReply = {
  headers?: string[];
  data?: Record<string, unknown>[];
  stats?: Record<string, unknown>;
};

/** The `Graph` methods of the `falkordb` client that Cyphra uses. */
export interface FalkorDBGraphLike {
  query(query: string, options?: { TIMEOUT?: number }): Promise<FalkorDBReply>;
  roQuery(query: string, options?: { TIMEOUT?: number }): Promise<FalkorDBReply>;
  constraintCreate(
    constraintType: string,
    entityType: string,
    label: string,
    ...properties: string[]
  ): Promise<unknown>;
  constraintDrop(
    constraintType: string,
    entityType: string,
    label: string,
    ...properties: string[]
  ): Promise<unknown>;
}

/** The `FalkorDB` client methods Cyphra uses (`FalkorDB.connect()` returns one). */
export interface FalkorDBClientLike {
  selectGraph(graph: string): FalkorDBGraphLike;
  close(): Promise<void>;
}

/** Where a FalkorDB client connects (`CyphraClient` option `falkordb`). */
export type FalkorDBConnectionOptions = {
  /** The graph (Redis key) every statement runs on. */
  graph: string;
  /**
   * `redis://[user:password@]host[:port]` (`rediss://` for TLS). Defaults to `host` / `port`, or
   * `redis://localhost:6379`.
   */
  url?: string;
  host?: string;
  /** Default 6379. */
  port?: number;
  username?: string;
  password?: string;
  /** Connect with TLS. */
  tls?: boolean;
  /**
   * A client your application already connected (`await FalkorDB.connect(…)`). Cyphra shares it
   * and never closes it.
   */
  client?: FalkorDBClientLike;
  /** Extra options for `FalkorDB.connect` (socket timeouts, reconnect strategy, …). */
  connectOptions?: Record<string, unknown>;
  /** Server-side timeout of each statement, in milliseconds (FalkorDB's `TIMEOUT`). */
  timeoutMs?: number;
};

/**
 * An error FalkorDB returned (or a connection failure). `code` is `"FalkorDB.ConstraintViolation"`
 * for a unique or mandatory constraint violation, `"FalkorDB.ConnectionError"` when the server
 * cannot be reached, `"FalkorDB.Error"` otherwise.
 */
export class FalkorDBError extends CyphraError {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message);
    this.code = code;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

function asFalkorDBError(e: unknown): FalkorDBError {
  if (e instanceof FalkorDBError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const connection =
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|Socket closed|connection is closed|The client is closed/i.test(
      message,
    );
  const code = /constraint violation/i.test(message)
    ? "FalkorDB.ConstraintViolation"
    : connection
      ? "FalkorDB.ConnectionError"
      : "FalkorDB.Error";
  return new FalkorDBError(message, code, { cause: e });
}

/** Result of one statement: `records` and a `summary` shaped like the driver's (subset). */
export type FalkorDBResult = {
  records: HttpRecord[];
  keys: string[];
  summary: {
    query: { text: string; parameters: Params };
    database: { name: string };
    server: { address: string };
    plan: false;
    counters: Record<string, unknown>;
    notifications: unknown[];
  };
};

/** A `GRAPH.CONSTRAINT …` statement, parsed. */
type ConstraintCommand = {
  action: "CREATE" | "DROP";
  type: "UNIQUE" | "MANDATORY";
  entity: "NODE" | "RELATIONSHIP";
  label: string;
  properties: string[];
};

const unquote = (t: string): string => (t.startsWith("`") ? t.slice(1, -1).replace(/``/g, "`") : t);

/** `GRAPH.CONSTRAINT CREATE UNIQUE NODE \`L\` PROPERTIES 2 \`a\` \`b\``, or `undefined`. */
export function parseConstraintCommand(text: string): ConstraintCommand | undefined {
  if (!/^\s*GRAPH\.CONSTRAINT\s/i.test(text)) return undefined;
  const words = tokenize(text.trim())
    .filter((t) => t.kind === "word" || t.kind === "quoted")
    .map((t) => t.text);
  const [cmd, action, type, entity, label, kw, count, ...properties] = words;
  const n = Number(count);
  if (
    cmd?.toUpperCase() !== "GRAPH.CONSTRAINT" ||
    !/^(CREATE|DROP)$/i.test(action ?? "") ||
    !/^(UNIQUE|MANDATORY)$/i.test(type ?? "") ||
    !/^(NODE|RELATIONSHIP)$/i.test(entity ?? "") ||
    !label ||
    kw?.toUpperCase() !== "PROPERTIES" ||
    !Number.isInteger(n) ||
    n !== properties.length ||
    n === 0
  ) {
    throw new FalkorDBError(`Malformed constraint command: ${text.trim()}`, "FalkorDB.Error");
  }
  return {
    action: action!.toUpperCase() as ConstraintCommand["action"],
    type: type!.toUpperCase() as ConstraintCommand["type"],
    entity: entity!.toUpperCase() as ConstraintCommand["entity"],
    label: unquote(label),
    properties: properties.map(unquote),
  };
}

/** Shared state of one {@link FalkorDBDriver}: the graph, the write lock. */
class Connection {
  private graphPromise: Promise<FalkorDBGraphLike> | undefined;
  private client: FalkorDBClientLike | undefined;
  private readonly owns: boolean;
  private writeChain: Promise<unknown> = Promise.resolve();
  /** Relationship types the graph is known to have (see `primeRelationshipTypes`). */
  private relationshipTypes: Set<string> | undefined;
  readonly address: string;

  constructor(readonly config: FalkorDBConnectionOptions) {
    if (!config.graph || typeof config.graph !== "string") {
      throw new CyphraError("falkordb.graph (the graph to query) is required.");
    }
    this.owns = !config.client;
    this.address = config.url
      ? safeAddress(config.url)
      : `${config.host ?? "localhost"}:${config.port ?? 6379}`;
  }

  graph(): Promise<FalkorDBGraphLike> {
    this.graphPromise ??= this.open().catch((e: unknown) => {
      this.graphPromise = undefined;
      throw asFalkorDBError(e);
    });
    return this.graphPromise;
  }

  private async open(): Promise<FalkorDBGraphLike> {
    if (this.config.client) {
      this.client = this.config.client;
      return this.client.selectGraph(this.config.graph);
    }
    const { FalkorDB } = await loadFalkorDB();
    const c = this.config;
    const options: Record<string, unknown> = {
      // Exact 64-bit integers (as `bigint`), told apart from floats: `Int` fields stay integers.
      integers: "bigint",
      ...c.connectOptions,
    };
    if (c.url) options.url = c.url;
    else {
      options.socket = {
        host: c.host ?? "localhost",
        port: c.port ?? 6379,
        ...(c.tls ? { tls: true } : {}),
        ...((c.connectOptions?.socket as object | undefined) ?? {}),
      };
    }
    if (c.username !== undefined) options.username = c.username;
    if (c.password !== undefined) options.password = c.password;
    this.client = (await FalkorDB.connect(options)) as unknown as FalkorDBClientLike;
    return this.client.selectGraph(c.graph);
  }

  /** Run `work` after every earlier write work of this driver settled. */
  serializeWrite<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(work, work);
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  async run(
    text: string,
    parameters: Params | undefined,
    readOnly: boolean,
  ): Promise<FalkorDBResult> {
    const params = parameters ?? {};
    const graph = await this.graph();
    const constraint = parseConstraintCommand(text);
    if (constraint) {
      await this.constraint(graph, constraint);
      return this.result(text, params, {});
    }
    let query: string;
    try {
      query = paramsHeader(params) + rewriteForFalkorDB(text, params);
    } catch (e) {
      throw e instanceof CyphraError ? e : asFalkorDBError(e);
    }
    if (!readOnly) await this.primeRelationshipTypes(graph, createdRelationshipTypes(text));
    const options = this.config.timeoutMs ? { TIMEOUT: this.config.timeoutMs } : undefined;
    let reply: FalkorDBReply;
    try {
      reply = readOnly ? await graph.roQuery(query, options) : await graph.query(query, options);
    } catch (e) {
      throw asFalkorDBError(e);
    }
    return this.result(text, params, reply);
  }

  /**
   * Make sure the graph knows `types`. FalkorDB resolves relationship types when it plans a
   * statement: a relationship of a type the graph has never had, created by the statement, is not
   * matched by a later clause of that statement (a nested `connect` read back by the same
   * statement). Creating and deleting one relationship of each new type first registers it.
   */
  private async primeRelationshipTypes(graph: FalkorDBGraphLike, types: string[]): Promise<void> {
    if (types.length === 0) return;
    const known = async () => {
      const reply = await graph.roQuery("CALL db.relationshipTypes()");
      this.relationshipTypes = new Set((reply.data ?? []).map((r) => String(r.relationshipType)));
      return this.relationshipTypes;
    };
    let have = this.relationshipTypes ?? (await known());
    if (types.every((t) => have.has(t))) return;
    have = await known();
    for (const t of types) {
      if (have.has(t)) continue;
      if (t.includes("`")) continue;
      try {
        await graph.query(`CREATE (a)-[r:\`${t}\`]->(b) DELETE r, a, b`);
      } catch (e) {
        throw asFalkorDBError(e);
      }
      have.add(t);
    }
  }

  private result(text: string, params: Params, reply: FalkorDBReply): FalkorDBResult {
    const keys = reply.headers ?? [];
    const records = (reply.data ?? []).map(
      (row) =>
        new HttpRecord(
          keys,
          keys.map((k) => decodeValue(row[k])),
        ),
    );
    return {
      keys,
      records,
      summary: {
        query: { text, parameters: params },
        database: { name: this.config.graph },
        server: { address: this.address },
        plan: false,
        counters: reply.stats ?? {},
        notifications: [],
      },
    };
  }

  /** Run a `GRAPH.CONSTRAINT` command; a created constraint is waited for until enforced. */
  private async constraint(graph: FalkorDBGraphLike, c: ConstraintCommand): Promise<void> {
    try {
      if (c.action === "DROP") {
        await graph.constraintDrop(c.type, c.entity, c.label, ...c.properties);
        return;
      }
      await graph.constraintCreate(c.type, c.entity, c.label, ...c.properties);
    } catch (e) {
      throw asFalkorDBError(e);
    }
    // FalkorDB enforces a new constraint asynchronously: wait until it is operational (or failed,
    // when existing data violates it).
    const deadline = Date.now() + 60_000;
    for (let delay = 20; ; delay = Math.min(delay * 2, 500)) {
      const reply = await graph.roQuery(
        "CALL db.constraints() YIELD type, label, properties, entitytype, status RETURN type, label, properties, entitytype, status",
      );
      const row = (reply.data ?? []).find(
        (r) =>
          r.type === c.type &&
          r.label === c.label &&
          String(r.entitytype).toUpperCase() === c.entity &&
          JSON.stringify(r.properties) === JSON.stringify(c.properties),
      );
      const status = row ? String(row.status) : "";
      if (status === "OPERATIONAL" || !row) return;
      if (status === "FAILED") {
        await graph
          .constraintDrop(c.type, c.entity, c.label, ...c.properties)
          .catch(() => undefined);
        throw new FalkorDBError(
          `The ${c.type.toLowerCase()} constraint on ${c.entity === "NODE" ? `:${c.label}` : `[:${c.label}]`}(${c.properties.join(", ")}) could not be created: existing data violates it.`,
          "FalkorDB.ConstraintViolation",
        );
      }
      if (Date.now() > deadline) {
        throw new FalkorDBError(
          `Timed out waiting for the constraint on ${c.label}(${c.properties.join(", ")}) to be enforced.`,
          "FalkorDB.Error",
        );
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.graphPromise = undefined;
    this.relationshipTypes = undefined;
    this.client = undefined;
    if (this.owns && client) await client.close();
  }
}

/** `host:port` of a Redis URL, without credentials. */
function safeAddress(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "6379"}`;
  } catch {
    return "falkordb";
  }
}

/**
 * A "transaction" of {@link FalkorDBSession.executeRead} / {@link FalkorDBSession.executeWrite}:
 * its statements run one at a time, each atomic on its own (FalkorDB has no multi-statement
 * transactions; see the module comment).
 */
export class FalkorDBTransaction {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly conn: Connection,
    private readonly readOnly: boolean,
  ) {}

  run(text: string, parameters?: Params): Promise<FalkorDBResult> {
    const result = this.chain.then(() => this.conn.run(text, parameters, this.readOnly));
    this.chain = result.catch(() => undefined);
    return result;
  }
}

/** A session: auto-commit `run` and statement batches (`executeRead` / `executeWrite`). */
export class FalkorDBSession {
  constructor(private readonly conn: Connection) {}

  /** Run one statement. */
  run(text: string, parameters?: Params): Promise<FalkorDBResult> {
    return this.conn.run(text, parameters, false);
  }

  /** Run `work`'s statements with `GRAPH.RO_QUERY` (read-only, can be served by a replica). */
  async executeRead<T>(work: (tx: FalkorDBTransaction) => Promise<T> | T): Promise<T> {
    return work(new FalkorDBTransaction(this.conn, true));
  }

  /**
   * Run `work`'s statements one after the other, after the earlier write work of this driver
   * (not atomic as a whole: see the module comment).
   */
  executeWrite<T>(work: (tx: FalkorDBTransaction) => Promise<T> | T): Promise<T> {
    return this.conn.serializeWrite(async () => work(new FalkorDBTransaction(this.conn, false)));
  }

  /** Nothing to release (sessions share the driver's connection). */
  async close(): Promise<void> {}
}

/**
 * Driver-shaped entry point of the FalkorDB transport. `CyphraClient` creates one for the
 * `falkordb` option; use it directly only for custom setups.
 */
export class FalkorDBDriver {
  private readonly conn: Connection;

  constructor(config: FalkorDBConnectionOptions) {
    this.conn = new Connection(config);
  }

  /** Server `host:port`. */
  get address(): string {
    return this.conn.address;
  }

  /** The graph statements run on. */
  get graphName(): string {
    return this.conn.config.graph;
  }

  /** The `falkordb` `Graph` (connecting first if needed). */
  graph(): Promise<FalkorDBGraphLike> {
    return this.conn.graph();
  }

  session(_config: { database?: string } = {}): FalkorDBSession {
    return new FalkorDBSession(this.conn);
  }

  /** Check the server is reachable. */
  async verifyConnectivity(): Promise<void> {
    await this.conn.run("RETURN 1", {}, true);
  }

  /** Close the connection (a `client` passed in the options is left open). */
  async close(): Promise<void> {
    await this.conn.close();
  }
}
