/**
 * HTTP transport: the Neo4j Query API (`/db/{database}/query/v2`) over `fetch`.
 *
 * {@link HttpDriver} has the shape of the `neo4j-driver` subset {@link CyphraClient} uses
 * (`session()`, `session.run()`, `session.executeRead/executeWrite()`, `tx.run()`), so the client,
 * the ORM and the instrumentation run unchanged on top of it. Only `fetch`, `TextEncoder`, `btoa`
 * and `atob` are used: it runs on Vercel Edge, Cloudflare Workers, Deno, Bun, browsers and Node.js.
 *
 * - Auto-commit statements: `POST /db/{db}/query/v2`, one request each (`session.run()`, and
 *   `session.runRetried()`, which retries transient failures: what single-statement ORM
 *   operations use).
 * - `executeRead` / `executeWrite`: an explicit transaction (`POST …/tx`, `POST …/tx/{id}`,
 *   `POST …/tx/{id}/commit`, `DELETE …/tx/{id}`), opened with the first statement and retried on
 *   transient errors like the driver's managed transactions. The `neo4j-cluster-affinity` header
 *   returned when the transaction opens is sent back on every later request of that transaction.
 *
 * @packageDocumentation
 */

import { CyphraError } from "../orm/errors.js";
import { decodeTyped, encodeParameters, utf8ToBase64, type TypedValue } from "./codec.js";

type Params = Record<string, unknown>;

/** Media type of typed JSON requests and responses (Neo4j 5.19+ / Aura). */
export const TYPED_JSON = "application/vnd.neo4j.query";
const AFFINITY_HEADER = "neo4j-cluster-affinity";

/** `fetch` as Cyphra calls it (the global one by default). */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Connection settings of {@link HttpDriver}. */
export type HttpDriverConfig = {
  /** Base URL of the server, e.g. `https://xxxx.databases.neo4j.io` or `http://localhost:7474`. */
  url: string;
  /** `Authorization` header value (`Basic …` / `Bearer …`), if any. */
  authorization?: string;
  /** Database used when a session names none (default `"neo4j"`). */
  database?: string;
  /** Custom `fetch` (tests, proxies, a Worker service binding's `fetch`). */
  fetch?: FetchLike;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** Total time `executeRead` / `executeWrite` keep retrying transient failures (default 30 s). */
  maxRetryTimeMs?: number;
  /**
   * Transactions and auto-commit statements in flight at once (default 4); others wait.
   *
   * Neo4j serves Query API requests from a fixed pool of HTTP worker threads
   * (`server.threads.worker_count`, one per CPU core by default). A request waiting for a lock
   * holds its thread, so when every thread waits on a lock held by an open transaction, the
   * request that would commit it gets no thread and everything hangs. Keeping each client below
   * the server's thread count avoids that.
   */
  maxConcurrency?: number;
  /** How long to wait for a free slot (see `maxConcurrency`) before failing (default 60 000 ms). */
  acquisitionTimeoutMs?: number;
};

/** A counting semaphore with FIFO waiters and an acquisition timeout. */
class Limiter {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(
    private readonly max: number,
    private readonly timeoutMs: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        this.active++;
        resolve();
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(
          new Neo4jHttpError(
            `Timed out after ${this.timeoutMs} ms waiting for one of the ${this.max} HTTP request slots (maxConcurrency).`,
            "ConnectionAcquisitionTimeout",
            0,
          ),
        );
      }, this.timeoutMs);
      this.waiters.push(grant);
    });
  }

  private release(): void {
    this.active--;
    this.waiters.shift()?.();
  }
}

/** `Basic` authorization header value for `user` / `password` (UTF-8 safe). */
export function basicAuth(user: string, password: string): string {
  return `Basic ${utf8ToBase64(`${user}:${password}`)}`;
}

/**
 * A Neo4j error returned by the Query API (or a network failure). `code` is the Neo4j status code,
 * e.g. `"Neo.ClientError.Schema.ConstraintValidationFailed"`, like `Neo4jError.code` in
 * `neo4j-driver`; network failures use `"ServiceUnavailable"`.
 */
export class Neo4jHttpError extends CyphraError {
  /** Neo4j status code. */
  readonly code: string;
  /** HTTP status of the response (`0` for a network failure). */
  readonly status: number;
  /** Other errors returned with the first one. */
  readonly errors: { code: string; message: string }[];

  constructor(
    message: string,
    code: string,
    status: number,
    errors: { code: string; message: string }[] = [],
    options?: { cause?: unknown },
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.errors = errors;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }

  /** `true` when retrying the whole transaction may succeed (like the driver's retry logic). */
  get retriable(): boolean {
    if (this.code === "ServiceUnavailable" || this.code === "SessionExpired") return true;
    return (
      this.code.startsWith("Neo.TransientError.") &&
      this.code !== "Neo.TransientError.Transaction.Terminated" &&
      this.code !== "Neo.TransientError.Transaction.LockClientStopped"
    );
  }
}

/** One result row, with the `neo4j-driver` `Record` methods Cyphra and most apps use. */
export class HttpRecord {
  readonly length: number;
  private readonly index: Map<string, number>;

  constructor(
    readonly keys: string[],
    private readonly fields: unknown[],
  ) {
    this.length = keys.length;
    this.index = new Map(keys.map((k, i) => [k, i]));
  }

  get(key: string | number): unknown {
    const i = typeof key === "number" ? key : this.index.get(key);
    if (i === undefined || i < 0 || i >= this.fields.length) {
      throw new CyphraError(
        `This record has no field ${JSON.stringify(key)} (fields: ${this.keys.join(", ")}).`,
      );
    }
    return this.fields[i];
  }

  has(key: string | number): boolean {
    return typeof key === "number" ? key >= 0 && key < this.length : this.index.has(key);
  }

  toObject(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.keys.forEach((k, i) => (out[k] = this.fields[i]));
    return out;
  }

  forEach(visitor: (value: unknown, key: string, record: HttpRecord) => void): void {
    this.keys.forEach((k, i) => visitor(this.fields[i], k, this));
  }

  values(): unknown[] {
    return [...this.fields];
  }
}

/** Query plan node of an `EXPLAIN` / `PROFILE` statement (`summary.plan`, like the driver). */
export type HttpPlan = {
  operatorType: string;
  arguments: Record<string, unknown>;
  identifiers: string[];
  children: HttpPlan[];
};

/** Result of one statement: `records` and a `summary` shaped like the driver's (subset). */
export type HttpResult = {
  records: HttpRecord[];
  keys: string[];
  summary: {
    query: { text: string; parameters: Params };
    database: { name: string };
    server: { address: string };
    plan: HttpPlan | false;
    counters?: Record<string, unknown>;
    notifications: unknown[];
  };
  bookmarks: string[];
};

type QueryResponse = {
  data?: { fields?: string[]; values?: unknown[][] };
  errors?: { code?: string; message?: string }[];
  transaction?: { id?: string; expires?: string };
  bookmarks?: string[];
  queryPlan?: unknown;
  profiledQueryPlan?: unknown;
  counters?: Record<string, unknown>;
  notifications?: unknown[];
};

function decodePlan(raw: unknown): HttpPlan | false {
  if (typeof raw !== "object" || raw === null) return false;
  const p = raw as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((p.arguments ?? {}) as Record<string, unknown>)) {
    const d = decodeTyped(v);
    args[k] =
      typeof d === "object" && d !== null && "toNumber" in d
        ? (d as { toNumber(): number }).toNumber()
        : d;
  }
  return {
    operatorType: String(p.operatorType ?? ""),
    arguments: args,
    identifiers: Array.isArray(p.identifiers) ? (p.identifiers as string[]) : [],
    children: Array.isArray(p.children)
      ? (p.children as unknown[]).map(decodePlan).filter((c): c is HttpPlan => c !== false)
      : [],
  };
}

type Body = { statement: string; parameters?: Record<string, TypedValue> } & Record<
  string,
  unknown
>;

/** Low-level Query API client shared by the sessions of one {@link HttpDriver}. */
class QueryApi {
  readonly limiter: Limiter;
  readonly base: string;
  readonly address: string;
  private readonly fetchFn: FetchLike;

  constructor(readonly config: HttpDriverConfig) {
    const max = config.maxConcurrency ?? 4;
    if (!Number.isInteger(max) || max < 1) {
      throw new CyphraError("maxConcurrency must be a positive integer.");
    }
    this.limiter = new Limiter(max, config.acquisitionTimeoutMs ?? 60_000);
    const url = new URL(config.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new CyphraError(
        `The HTTP transport needs an http:// or https:// URL, got ${url.protocol}//.`,
      );
    }
    this.base = url.origin + url.pathname.replace(/\/+$/, "");
    this.address = url.host;
    if (!config.fetch && typeof globalThis.fetch !== "function") {
      throw new CyphraError("No global fetch: pass `fetch` to the HTTP transport.");
    }
    // Keep `this` = globalThis: some runtimes (Workers) throw "Illegal invocation" otherwise.
    this.fetchFn = config.fetch ? config.fetch : (input, init) => globalThis.fetch(input, init);
  }

  url(database: string, path = ""): string {
    return `${this.base}/db/${encodeURIComponent(database)}/query/v2${path}`;
  }

  /** Send a request; returns the parsed body and response headers. Throws on Neo4j errors. */
  async request(
    method: "POST" | "DELETE",
    url: string,
    body: Body | Record<string, unknown> | undefined,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ json: QueryResponse; headers: Headers }> {
    const headers: Record<string, string> = {
      Accept: TYPED_JSON,
      ...this.config.headers,
      ...extraHeaders,
    };
    if (body !== undefined) headers["Content-Type"] = TYPED_JSON;
    if (this.config.authorization) headers.Authorization = this.config.authorization;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new Neo4jHttpError(
        `Neo4j Query API unreachable at ${this.address}: ${e instanceof Error ? e.message : String(e)}`,
        "ServiceUnavailable",
        0,
        [],
        { cause: e },
      );
    }
    const text = await res.text();
    let json: QueryResponse = {};
    if (text) {
      try {
        json = JSON.parse(text) as QueryResponse;
      } catch {
        throw new Neo4jHttpError(
          `Neo4j Query API returned HTTP ${res.status} with a non-JSON body.`,
          res.status >= 500 ? "ServiceUnavailable" : `HTTP.${res.status}`,
          res.status,
        );
      }
    }
    const errors = (json.errors ?? []).map((e) => ({
      code: String(e.code ?? "Neo.DatabaseError.General.UnknownError"),
      message: String(e.message ?? ""),
    }));
    if (errors.length) {
      const first = errors[0]!;
      throw new Neo4jHttpError(first.message, first.code, res.status, errors);
    }
    if (!res.ok) {
      throw new Neo4jHttpError(
        `Neo4j Query API returned HTTP ${res.status}.`,
        res.status >= 500 ? "ServiceUnavailable" : `HTTP.${res.status}`,
        res.status,
      );
    }
    return { json, headers: res.headers };
  }

  toResult(json: QueryResponse, text: string, params: Params, database: string): HttpResult {
    const keys = json.data?.fields ?? [];
    const rows = json.data?.values ?? [];
    return {
      keys,
      records: rows.map((row) => new HttpRecord(keys, row.map(decodeTyped))),
      summary: {
        query: { text, parameters: params },
        database: { name: database },
        server: { address: this.address },
        plan: decodePlan(json.profiledQueryPlan ?? json.queryPlan),
        counters: json.counters,
        notifications: json.notifications ?? [],
      },
      bookmarks: json.bookmarks ?? [],
    };
  }
}

/** Access mode of a transaction or auto-commit statement. */
export type AccessMode = "READ" | "WRITE";

/** A transaction of {@link HttpSession.executeRead} / {@link HttpSession.executeWrite}. */
export class HttpTransaction {
  private id: string | undefined;
  private affinity: string | undefined;
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly api: QueryApi,
    private readonly database: string,
    private readonly accessMode: AccessMode,
    private readonly bookmarks: string[],
  ) {}

  private headers(): Record<string, string> {
    return this.affinity ? { [AFFINITY_HEADER]: this.affinity } : {};
  }

  /** Run a statement in the transaction. Statements of one transaction run one at a time. */
  run(text: string, parameters?: Params): Promise<HttpResult> {
    const params = parameters ?? {};
    const next = this.chain.then(() => this.send(text, params));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async send(text: string, params: Params): Promise<HttpResult> {
    if (this.closed) throw new CyphraError("This transaction is closed.");
    const body: Body = { statement: text, parameters: encodeParameters(params) };
    try {
      if (this.id === undefined) {
        // The first statement opens the transaction: one round trip instead of two.
        if (this.bookmarks.length) body.bookmarks = this.bookmarks;
        body.accessMode = this.accessMode;
        const { json, headers } = await this.api.request(
          "POST",
          this.api.url(this.database, "/tx"),
          body,
        );
        this.affinity = headers.get(AFFINITY_HEADER) ?? undefined;
        this.id = json.transaction?.id;
        if (!this.id) throw new CyphraError("The Query API opened no transaction (missing id).");
        return this.api.toResult(json, text, params, this.database);
      }
      const { json } = await this.api.request(
        "POST",
        this.api.url(this.database, `/tx/${encodeURIComponent(this.id)}`),
        body,
        this.headers(),
      );
      return this.api.toResult(json, text, params, this.database);
    } catch (e) {
      // The server closes the transaction after (almost) any error.
      this.closed = true;
      throw e;
    }
  }

  /** @internal Commit; returns the bookmarks. */
  async commit(): Promise<string[]> {
    await this.chain;
    if (this.closed) throw new CyphraError("This transaction is closed.");
    this.closed = true;
    if (this.id === undefined) return [];
    const { json } = await this.api.request(
      "POST",
      this.api.url(this.database, `/tx/${encodeURIComponent(this.id)}/commit`),
      {},
      this.headers(),
    );
    return json.bookmarks ?? [];
  }

  /** @internal Roll back (best effort: the server may already have closed it). */
  async rollback(): Promise<void> {
    await this.chain;
    const wasOpen = !this.closed;
    this.closed = true;
    if (this.id === undefined || !wasOpen) return;
    try {
      await this.api.request(
        "DELETE",
        this.api.url(this.database, `/tx/${encodeURIComponent(this.id)}`),
        undefined,
        this.headers(),
      );
    } catch {
      // Already rolled back (error, timeout) or unreachable: the server times it out.
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A session: auto-commit `run` and managed transactions. Sessions hold no connection. */
export class HttpSession {
  private bookmarks: string[] = [];

  constructor(
    private readonly api: QueryApi,
    private readonly database: string,
  ) {}

  /** Run one auto-commit statement. */
  async run(text: string, parameters?: Params): Promise<HttpResult> {
    const params = parameters ?? {};
    const body: Body = { statement: text, parameters: encodeParameters(params) };
    if (this.bookmarks.length) body.bookmarks = this.bookmarks;
    const { json } = await this.api.limiter.run(() =>
      this.api.request("POST", this.api.url(this.database), body),
    );
    const result = this.api.toResult(json, text, params, this.database);
    if (result.bookmarks.length) this.bookmarks = result.bookmarks;
    return result;
  }

  /**
   * Run one statement in its own auto-commit transaction (one request), retrying transient
   * failures like {@link executeRead} / {@link executeWrite} do. For work that is a single
   * statement: it saves the requests that open and commit an explicit transaction.
   */
  async runRetried(
    text: string,
    parameters: Params | undefined,
    mode: AccessMode = "WRITE",
  ): Promise<HttpResult> {
    const params = parameters ?? {};
    const deadline = Date.now() + (this.api.config.maxRetryTimeMs ?? 30_000);
    let delay = 200;
    for (;;) {
      try {
        const body: Body = { statement: text, parameters: encodeParameters(params) };
        if (this.bookmarks.length) body.bookmarks = this.bookmarks;
        if (mode === "READ") body.accessMode = mode;
        const { json } = await this.api.limiter.run(() =>
          this.api.request("POST", this.api.url(this.database), body),
        );
        const result = this.api.toResult(json, text, params, this.database);
        if (result.bookmarks.length) this.bookmarks = result.bookmarks;
        return result;
      } catch (e) {
        if (!(e instanceof Neo4jHttpError && e.retriable) || Date.now() + delay > deadline) throw e;
        await sleep(delay * (0.8 + Math.random() * 0.4));
        delay *= 2;
      }
    }
  }

  executeRead<T>(work: (tx: HttpTransaction) => Promise<T> | T): Promise<T> {
    return this.execute("READ", work);
  }

  executeWrite<T>(work: (tx: HttpTransaction) => Promise<T> | T): Promise<T> {
    return this.execute("WRITE", work);
  }

  private async execute<T>(
    mode: AccessMode,
    work: (tx: HttpTransaction) => Promise<T> | T,
  ): Promise<T> {
    const deadline = Date.now() + (this.api.config.maxRetryTimeMs ?? 30_000);
    let delay = 200;
    for (;;) {
      const tx = new HttpTransaction(this.api, this.database, mode, this.bookmarks);
      // One slot for the whole transaction: its requests never wait behind other transactions.
      const attempt = await this.api.limiter
        .run(async () => {
          try {
            const value = await work(tx);
            const bookmarks = await tx.commit();
            if (bookmarks.length) this.bookmarks = bookmarks;
            return { value };
          } catch (e) {
            await tx.rollback();
            return { error: e };
          }
        })
        .catch((error: unknown) => ({ error }));
      if (!("error" in attempt)) return attempt.value;
      const e = attempt.error;
      if (!(e instanceof Neo4jHttpError && e.retriable) || Date.now() + delay > deadline) throw e;
      await sleep(delay * (0.8 + Math.random() * 0.4));
      delay *= 2;
    }
  }

  /** Nothing to release (HTTP is stateless); present for the `Session` shape. */
  async close(): Promise<void> {}
}

/**
 * Driver-shaped entry point of the HTTP transport. `CyphraClient` creates one for an `https://` /
 * `http://` URI (or `transport: "http"`); use it directly only for custom setups.
 */
export class HttpDriver {
  private readonly api: QueryApi;

  constructor(config: HttpDriverConfig) {
    this.api = new QueryApi(config);
  }

  /** Server `host[:port]`. */
  get address(): string {
    return this.api.address;
  }

  session(config: { database?: string } = {}): HttpSession {
    return new HttpSession(this.api, config.database ?? this.api.config.database ?? "neo4j");
  }

  /** Check the server is reachable and the credentials are accepted. */
  async verifyConnectivity(): Promise<void> {
    await this.session().run("RETURN 1");
  }

  async close(): Promise<void> {}
}
