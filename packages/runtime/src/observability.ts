/**
 * Query events, OpenTelemetry spans and dev-mode missing-index warnings for {@link CyphraClient}.
 *
 * Everything here is opt-in: with no `log`, no listener, no `tracer` and no
 * `warnMissingIndexes`, statements run exactly as before (no timing, no extra objects).
 */

/** Event kinds a client emits. */
export type LogLevel = "query" | "warn" | "error";

/** Where a statement comes from: the ORM model and operation, when known. */
export type QueryMeta = {
  /** ORM model name, e.g. `"Post"`. */
  model?: string;
  /** Operation, e.g. `"findMany"`, `"$cypher"`, `"graphql.read"`. */
  operation?: string;
  /** True when the statement runs inside an explicit transaction (`$transaction`, `withWriteTransaction`, …). */
  transaction?: boolean;
};

/** One statement that completed. */
export type QueryEvent = {
  type: "query";
  model?: string;
  operation?: string;
  /** Cypher text as sent (Cyphra always parameterizes values, so it carries no user data). */
  text: string;
  /** Parameters: type placeholders (`"<string>"`) unless `logParams: true`. */
  params: Record<string, unknown>;
  durationMs: number;
  /** Number of records returned. */
  rows?: number;
  database?: string;
  transaction: boolean;
  timestamp: Date;
};

/** A failed statement. */
export type ErrorEvent = Omit<QueryEvent, "type" | "rows"> & {
  type: "error";
  message: string;
  /** Neo4j status code, e.g. `"Neo.ClientError.Statement.SyntaxError"`. */
  code?: string;
  /** GQL status (neo4j-driver 6 / Neo4j 5.23+), e.g. `"42001"`. */
  gqlStatus?: string;
  error: unknown;
};

/** A warning, e.g. a property filtered without an index (see `warnMissingIndexes`). */
export type WarnEvent = {
  type: "warn";
  kind: "missing-index";
  message: string;
  model?: string;
  operation?: string;
  /** Node label scanned. */
  label: string;
  /** Property filtered without an index. */
  property: string;
  /** The statement whose plan showed the scan. */
  text: string;
  timestamp: Date;
};

export type CyphraEvent = QueryEvent | ErrorEvent | WarnEvent;
type EventOf<L extends LogLevel> = Extract<CyphraEvent, { type: L }>;

/** The subset of an OpenTelemetry `Span` Cyphra uses (`@opentelemetry/api` 1.x). */
export interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): unknown;
  recordException(exception: Error | string): void;
  setStatus(status: { code: number; message?: string }): unknown;
  end(): void;
}

/**
 * The subset of an OpenTelemetry `Tracer` Cyphra uses: pass `trace.getTracer("my-app")` from
 * `@opentelemetry/api`. Cyphra never imports `@opentelemetry/api` itself.
 */
export interface TracerLike {
  startSpan(
    name: string,
    options?: { kind?: number; attributes?: Record<string, string | number | boolean> },
  ): SpanLike;
  startActiveSpan<F extends (span: SpanLike) => unknown>(
    name: string,
    options: { kind?: number; attributes?: Record<string, string | number | boolean> },
    fn: F,
  ): ReturnType<F>;
}

/** Logging, tracing and index-warning options shared by `new CyphraClient()` and `createClient()`. */
export type ObservabilityOptions = {
  /**
   * Log levels printed to the console (`["query", "warn", "error"]`), or a function that
   * receives every event. Listeners added with `$on` / `client.on` receive events either way.
   */
  log?: readonly LogLevel[] | ((event: CyphraEvent) => void);
  /**
   * Include parameter values in query and error events (default false: values are replaced by
   * type placeholders such as `"<string>"`). Keys that look like secrets (`password`, `token`,
   * `secret`, `apiKey`, …) stay redacted even then.
   */
  logParams?: boolean;
  /** OpenTelemetry tracer: one span per ORM operation (`cyphra.Post.findMany`) and one per statement. */
  tracer?: TracerLike;
  /** Put the Cypher text on statement spans as `db.query.text` (default false; string literals are masked). */
  traceQueryText?: boolean;
  /**
   * Development aid (default false): `EXPLAIN` each distinct filtered statement once and emit a
   * `warn` event when the plan scans a label and filters on a property that has no index.
   * Costs one extra `EXPLAIN` round trip per distinct statement text, off the query path.
   */
  warnMissingIndexes?: boolean;
  /**
   * @deprecated Use `log: ["query"]`. When true, logs each statement with redacted parameters.
   */
  debug?: boolean;
};

const SPAN_KIND_INTERNAL = 0;
const SPAN_KIND_CLIENT = 2;
const STATUS_ERROR = 2;
const SECRET_KEY = /pass(word|wd)?|secret|token|api[-_]?key|authorization|credential/i;
const MAX_EXPLAINED = 1000;
const INDEX_CACHE_MS = 2000;

/** Type placeholder for one parameter value: `"<string>"`, `"<list(3)>"`, `"<DateTime>"`, … */
export function describeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return "<null>";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean" || t === "bigint") return `<${t}>`;
  if (Array.isArray(value)) return `<list(${value.length})>`;
  if (ArrayBuffer.isView(value)) {
    const len = (value as unknown as { length?: number }).length ?? value.byteLength;
    return `<${value.constructor.name}(${len})>`;
  }
  if (value instanceof Date) return "<Date>";
  if (t === "object") {
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto === Object.prototype || proto === null) {
      if (depth >= 2) return "<map>";
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        out[k] = describeValue(v, depth + 1);
      return out;
    }
    const name = (value as { constructor?: { name?: string } }).constructor?.name;
    return `<${name || "object"}>`;
  }
  return `<${t}>`;
}

function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 3 || value === null || typeof value !== "object" || Array.isArray(value))
    return value;
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    out[k] = SECRET_KEY.test(k) ? "<redacted>" : redactSecrets(v, depth + 1);
  return out;
}

/**
 * Parameters as they appear in events: type placeholders by default, values (minus secret-looking
 * keys) with `logParams`.
 */
export function redactParams(
  params: Record<string, unknown>,
  logParams = false,
): Record<string, unknown> {
  if (logParams) return redactSecrets(params) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params))
    out[k] = SECRET_KEY.test(k) ? "<redacted>" : describeValue(v, 1);
  return out;
}

/** Mask string literals in Cypher text (for `db.query.text`). */
export function sanitizeCypher(text: string): string {
  return text.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "?");
}

/** First clause keyword of a statement (`MATCH`, `CREATE`, `UNWIND`, …), for `db.operation.name`. */
export function cypherOperation(text: string): string {
  const m = /^\s*(?:CYPHER\b[^\n]*?\s+)?(OPTIONAL\s+MATCH|[A-Za-z]+)/i.exec(text);
  return m ? m[1]!.replace(/\s+/g, " ").toUpperCase() : "QUERY";
}

type PlanLike = {
  operatorType?: string;
  arguments?: Record<string, unknown>;
  identifiers?: string[];
  children?: PlanLike[];
};

/** A label scan followed by a filter on one of the scanned node's properties. */
export type ScanFinding = { label: string; property: string };

const scanOp = (p: PlanLike) => (p.operatorType ?? "").split("@")[0]!;
const details = (p: PlanLike) => {
  const d = p.arguments?.Details ?? p.arguments?.details;
  return typeof d === "string" ? d : "";
};
const unquote = (s: string) => s.replace(/^`|`$/g, "");

/**
 * Walk an `EXPLAIN` plan and return the properties filtered right on top of a
 * `NodeByLabelScan` / `AllNodesScan`, i.e. without an index seek.
 */
export function findUnindexedFilters(plan: PlanLike | false | null | undefined): ScanFinding[] {
  if (!plan) return [];
  const found = new Map<string, ScanFinding>();
  const IDENT = "(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)";

  // Scanned variables in a subtree: var -> label ("" for AllNodesScan).
  const scans = (p: PlanLike, out: Map<string, string>): Map<string, string> => {
    const op = scanOp(p);
    if (op === "NodeByLabelScan") {
      const m = new RegExp(`^${IDENT}:${IDENT}`).exec(details(p).trim());
      if (m) out.set(unquote(m[1]!), unquote(m[2]!));
    } else if (op === "AllNodesScan") {
      const v = details(p).trim() || p.identifiers?.[0];
      if (v) out.set(unquote(v), "");
    }
    for (const c of p.children ?? []) scans(c, out);
    return out;
  };

  const visit = (p: PlanLike) => {
    if (scanOp(p) === "Filter") {
      const d = details(p);
      const vars = scans(p, new Map());
      for (const [v, scannedLabel] of vars) {
        const ev = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const ref = `(?:\`${ev}\`|${ev})`;
        let label = scannedLabel;
        if (!label) {
          const lm = new RegExp(`(?<![A-Za-z0-9_\`])${ref}:${IDENT}`).exec(d);
          if (!lm) continue;
          label = unquote(lm[1]!);
        }
        const re = new RegExp(`(?<![A-Za-z0-9_.\`])${ref}\\.${IDENT}`, "g");
        for (const m of d.matchAll(re)) {
          const property = unquote(m[1]!);
          found.set(`${label}.${property}`, { label, property });
        }
      }
    }
    for (const c of p.children ?? []) visit(c);
  };
  visit(plan);
  return [...found.values()];
}

type ResultLike = {
  records?: unknown[];
  summary?: {
    server?: { address?: string };
    database?: { name?: string | null };
    plan?: PlanLike | false;
  };
};

type ExplainSession = {
  run(text: string, params?: Record<string, unknown>): PromiseLike<unknown>;
  close(): Promise<void>;
};

export type InstrumentationConfig = ObservabilityOptions & {
  database?: string;
  /** Host and port parsed from the connection URI, when the client created the driver. */
  server?: { address: string; port?: number };
  /** Opens a session for `EXPLAIN` / `SHOW INDEXES` (missing-index checks). */
  openSession: () => ExplainSession;
};

type Listener = (event: CyphraEvent) => void;

/** What the schema says about a label's property (registered by the ORM for warning messages). */
export type FieldHint = { model: string; declared?: "@id" | "@unique" | "@index" };
export type FieldResolver = (label: string, property: string) => FieldHint | undefined;

function errorCode(err: unknown): { code?: string; gqlStatus?: string; message: string } {
  const e = err as { code?: unknown; gqlStatus?: unknown; message?: unknown } | null;
  return {
    code: typeof e?.code === "string" ? e.code : undefined,
    gqlStatus: typeof e?.gqlStatus === "string" ? e.gqlStatus : undefined,
    message: typeof e?.message === "string" ? e.message : String(err),
  };
}

function splitAddress(address: string): { address: string; port?: number } {
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(address);
  if (!m) return { address };
  return { address: m[1]!, port: m[2] ? Number(m[2]) : undefined };
}

/** Host / port of a Bolt or Neo4j URI, for `server.address` / `server.port`. */
export function serverFromUri(uri: string): { address: string; port?: number } | undefined {
  try {
    const u = new URL(uri);
    if (!u.hostname) return undefined;
    return { address: u.hostname.replace(/^\[|\]$/g, ""), port: u.port ? Number(u.port) : 7687 };
  } catch {
    return undefined;
  }
}

const fmtMeta = (m: { model?: string; operation?: string }) =>
  m.model && m.operation ? `${m.model}.${m.operation} ` : m.operation ? `${m.operation} ` : "";

/** Print an event the way `log: [...]` does. */
function printEvent(event: CyphraEvent): void {
  if (event.type === "query") {
    console.log(
      `[cyphra:query] ${event.durationMs.toFixed(1)}ms${event.rows !== undefined ? ` ${event.rows} rows` : ""} ${fmtMeta(event)}${event.text}`,
      event.params,
    );
  } else if (event.type === "error") {
    console.error(
      `[cyphra:error] ${fmtMeta(event)}${event.code ?? ""} ${event.message}\n  ${event.text}`,
      event.params,
    );
  } else {
    console.warn(`[cyphra:warn] ${event.message}`);
  }
}

/**
 * Per-client instrumentation. Created by {@link CyphraClient}; the ORM and `@cyphra/graphql` run
 * their statements through {@link Instrumentation.run} and {@link Instrumentation.operation}.
 */
export class Instrumentation {
  private readonly listeners: Record<LogLevel, Set<Listener>> = {
    query: new Set(),
    warn: new Set(),
    error: new Set(),
  };
  private readonly printLevels: ReadonlySet<LogLevel>;
  private readonly logFn?: (event: CyphraEvent) => void;
  private readonly debugLegacy: boolean;
  private readonly explained = new Set<string>();
  private readonly warned = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly resolvers: FieldResolver[] = [];
  private indexCache?: { at: number; entries: Promise<{ label: string; props: string[] }[]> };

  constructor(private readonly config: InstrumentationConfig) {
    const log = config.log;
    this.logFn = typeof log === "function" ? log : undefined;
    this.printLevels = new Set(Array.isArray(log) ? log : []);
    this.debugLegacy = config.debug === true && !this.printLevels.has("query");
  }

  /** Let missing-index warnings name the model and its declared `@id` / `@unique` / `@index`. */
  addFieldResolver(resolver: FieldResolver): void {
    this.resolvers.push(resolver);
  }

  private hint(label: string, property: string): FieldHint | undefined {
    for (const r of this.resolvers) {
      const h = r(label, property);
      if (h) return h;
    }
    return undefined;
  }

  /** Subscribe to one event kind; returns an unsubscribe function. */
  on<L extends LogLevel>(level: L, listener: (event: EventOf<L>) => void): () => void {
    const set = this.listeners[level];
    if (!set) throw new TypeError(`Unknown Cyphra event "${String(level)}".`);
    set.add(listener as Listener);
    return () => void set.delete(listener as Listener);
  }

  private wants(level: LogLevel): boolean {
    return (
      this.logFn !== undefined ||
      this.printLevels.has(level) ||
      this.listeners[level].size > 0 ||
      (level === "query" && this.debugLegacy)
    );
  }

  private emit(event: CyphraEvent): void {
    try {
      if (this.printLevels.has(event.type)) printEvent(event);
      else if (event.type === "query" && this.debugLegacy)
        console.debug(`[cyphra] cypher: ${event.text}`, event.params);
      else if (
        event.type === "warn" &&
        !this.logFn &&
        this.listeners.warn.size === 0 &&
        this.config.warnMissingIndexes
      )
        // Asked for index warnings but nobody listens: print them rather than drop them.
        printEvent(event);
      this.logFn?.(event);
      for (const l of this.listeners[event.type]) l(event);
    } catch (err) {
      // A failing listener must never fail the query.
      console.error("[cyphra] log listener threw:", err);
    }
  }

  /**
   * Wrap one ORM operation (`findMany`, `$transaction`, …) in an active span, so statements and
   * nested operations become its children.
   */
  operation<T>(meta: QueryMeta, fn: () => Promise<T>): Promise<T> {
    const tracer = this.config.tracer;
    if (!tracer) return fn();
    const name = meta.model ? `cyphra.${meta.model}.${meta.operation}` : `cyphra.${meta.operation}`;
    const attributes: Record<string, string | number | boolean> = {
      "db.system.name": "neo4j",
      "db.operation.name": meta.operation ?? "query",
    };
    if (meta.model) attributes["cyphra.model"] = meta.model;
    if (this.config.database) attributes["db.namespace"] = this.config.database;
    return tracer.startActiveSpan(name, { kind: SPAN_KIND_INTERNAL, attributes }, async (span) => {
      try {
        return await fn();
      } catch (err) {
        recordError(span, err);
        throw err;
      } finally {
        span.end();
      }
    }) as Promise<T>;
  }

  /** Run one statement through `run`, emitting a query/error event and a statement span. */
  async run<R>(
    text: string,
    params: Record<string, unknown>,
    meta: QueryMeta,
    run: () => PromiseLike<R>,
  ): Promise<R> {
    if (this.config.warnMissingIndexes) this.checkIndexes(text, params, meta);
    const tracer = this.config.tracer;
    const wantQuery = this.wants("query");
    const wantError = this.wants("error");
    if (!tracer && !wantQuery && !wantError) return run();

    const database = this.config.database;
    let span: SpanLike | undefined;
    if (tracer) {
      const op = cypherOperation(text);
      const attributes: Record<string, string | number | boolean> = {
        "db.system.name": "neo4j",
        "db.operation.name": op,
      };
      if (database) attributes["db.namespace"] = database;
      if (this.config.traceQueryText) attributes["db.query.text"] = sanitizeCypher(text);
      if (this.config.server) {
        attributes["server.address"] = this.config.server.address;
        if (this.config.server.port) attributes["server.port"] = this.config.server.port;
      }
      span = tracer.startSpan(meta.model ? `${op} ${meta.model}` : op, {
        kind: SPAN_KIND_CLIENT,
        attributes,
      });
    }
    const start = performance.now();
    try {
      const result = await run();
      const durationMs = performance.now() - start;
      const r = result as ResultLike | undefined;
      const rows = Array.isArray(r?.records) ? r.records.length : undefined;
      const db = database ?? r?.summary?.database?.name ?? undefined;
      if (span) {
        if (rows !== undefined) span.setAttribute("db.response.returned_rows", rows);
        if (!database && db) span.setAttribute("db.namespace", db);
        const addr = r?.summary?.server?.address;
        if (!this.config.server && addr) {
          const s = splitAddress(addr);
          span.setAttribute("server.address", s.address);
          if (s.port) span.setAttribute("server.port", s.port);
        }
      }
      if (wantQuery) {
        this.emit({
          type: "query",
          model: meta.model,
          operation: meta.operation,
          text,
          params: redactParams(params, this.config.logParams),
          durationMs,
          rows,
          database: db,
          transaction: meta.transaction ?? false,
          timestamp: new Date(),
        });
      }
      return result;
    } catch (err) {
      const durationMs = performance.now() - start;
      if (span) recordError(span, err);
      if (wantError) {
        const { code, gqlStatus, message } = errorCode(err);
        this.emit({
          type: "error",
          model: meta.model,
          operation: meta.operation,
          text,
          params: redactParams(params, this.config.logParams),
          durationMs,
          database,
          transaction: meta.transaction ?? false,
          timestamp: new Date(),
          message,
          code,
          gqlStatus,
          error: err,
        });
      }
      throw err;
    } finally {
      span?.end();
    }
  }

  /** Wait for in-flight missing-index checks (called by `close()`; handy in tests). */
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private checkIndexes(text: string, params: Record<string, unknown>, meta: QueryMeta): void {
    if (this.explained.has(text) || this.explained.size >= MAX_EXPLAINED) return;
    if (!/\bWHERE\b/i.test(text)) return;
    if (
      /^\s*(EXPLAIN|PROFILE|SHOW|CREATE\s+(INDEX|CONSTRAINT)|DROP|ALTER|CALL\s+db\.)\b/i.test(text)
    )
      return;
    this.explained.add(text);
    // Off the query path: the statement does not wait for its EXPLAIN.
    const p = this.explain(text, params, meta)
      .catch(() => undefined)
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  private async explain(
    text: string,
    params: Record<string, unknown>,
    meta: QueryMeta,
  ): Promise<void> {
    const session = this.config.openSession();
    let findings: ScanFinding[];
    try {
      const res = (await session.run(`EXPLAIN ${text}`, params)) as ResultLike;
      findings = findUnindexedFilters(res.summary?.plan);
    } finally {
      await session.close();
    }
    findings = findings.filter((f) => !this.warned.has(`${f.label}.${f.property}`));
    if (!findings.length) return;
    const indexes = await this.indexes();
    for (const f of findings) {
      const key = `${f.label}.${f.property}`;
      if (this.warned.has(key)) continue;
      if (indexes.some((i) => i.label === f.label && i.props.includes(f.property))) continue;
      this.warned.add(key);
      const hint = this.hint(f.label, f.property);
      const name = hint ? `${hint.model}.${f.property}` : key;
      const message = hint?.declared
        ? `${name} is filtered without an index (label scan + filter): it is declared ${hint.declared} but the database has no index on ${key}. Apply your migrations (cyphra migrate deploy, or cyphra push).`
        : `${name} is filtered without an index (label scan + filter): add @index to ${name} in your schema.`;
      this.emit({
        type: "warn",
        kind: "missing-index",
        message,
        model: hint?.model ?? meta.model,
        operation: meta.operation,
        label: f.label,
        property: f.property,
        text,
        timestamp: new Date(),
      });
    }
  }

  private indexes(): Promise<{ label: string; props: string[] }[]> {
    const now = Date.now();
    if (this.indexCache && now - this.indexCache.at < INDEX_CACHE_MS)
      return this.indexCache.entries;
    const entries = (async () => {
      const session = this.config.openSession();
      try {
        const res = (await session.run(
          "SHOW INDEXES YIELD entityType, labelsOrTypes, properties WHERE entityType = 'NODE' RETURN labelsOrTypes, properties",
        )) as { records: { get(k: string): unknown }[] };
        const out: { label: string; props: string[] }[] = [];
        for (const r of res.records) {
          const labels = (r.get("labelsOrTypes") as string[] | null) ?? [];
          const props = (r.get("properties") as string[] | null) ?? [];
          for (const label of labels) out.push({ label, props });
        }
        return out;
      } finally {
        await session.close();
      }
    })();
    this.indexCache = { at: now, entries };
    entries.catch(() => (this.indexCache = undefined));
    return entries;
  }
}

function recordError(span: SpanLike, err: unknown): void {
  const { code, message } = errorCode(err);
  span.recordException(err instanceof Error ? err : String(err));
  span.setStatus({ code: STATUS_ERROR, message });
  span.setAttribute("error.type", code ?? (err instanceof Error ? err.name : "Error"));
  if (code) span.setAttribute("db.response.status_code", code);
}
