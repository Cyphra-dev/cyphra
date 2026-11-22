import type { ResolvedNodeModel, SchemaModel } from "@cyphra/schema";
import { compileCypher } from "@cyphra/query";
import { CyphraClient, type CyphraClientOptions, type TransactionLike } from "../client.js";
import {
  Instrumentation,
  type CyphraEvent,
  type FieldResolver,
  type LogLevel,
  type QueryMeta,
} from "../observability.js";
import { ModelEngine, type EngineOptions, type Executor, type Runner } from "./engine.js";
import { CyphraError, CyphraValidationError } from "./errors.js";
import { unsupportedOnMemgraph, type CyphraDialect } from "../dialect.js";
import { CypherDuration, CypherTime } from "../cypher-values.js";
import {
  ExtensionState,
  ORM_OPERATIONS,
  runHooks,
  withComputed,
  type ExtensionDef,
} from "./extensions.js";
import type {
  ExtendedClient,
  ExtensionArgs,
  ModelMethods,
  ResultNeedsMap,
} from "./extensionTypes.js";
import type { DelegateKey, ModelDelegate, TypeMap } from "./types.js";
import { mapUniqueError } from "./unique.js";
import { falkordbTransactionError, falkordbUniqueError } from "./falkordb.js";
import { toNative } from "./values.js";

/**
 * Options for {@link createOrm}: connection options, an existing `neo4j-driver` 5.28+ / 6.x
 * `Driver` (`{ driver }`), or an existing {@link CyphraClient}.
 */
export type OrmOptions = (
  | CyphraClientOptions
  | {
      client: CyphraClient;
      /** @deprecated Set `log: ["query"]` on the `CyphraClient` instead. */
      debug?: boolean;
    }
) & {
  /**
   * Largest `depth.max` a `traverse` may ask for (default 10). Each extra hop can multiply the
   * number of paths Neo4j explores, so keep it as low as your queries allow.
   */
  maxTraversalDepth?: number;
};

type Raw = {
  /**
   * Run a raw parameterized Cypher query (tagged template) and return rows as plain JS
   * (integers → number, temporals → Date, nodes → properties).
   *
   * @example
   * ```ts
   * const rows = await db.$cypher`MATCH (u:User) WHERE u.email = ${email} RETURN u.name AS name`;
   * ```
   */
  $cypher<T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
};

type None = Record<never, never>;

/** Model delegates, with the custom methods `MM` of an extended client. */
type Delegates<TM extends TypeMap, MM extends ModelMethods> = {
  [M in keyof TM & string as DelegateKey<M>]: ModelDelegate<TM, M> &
    (DelegateKey<M> extends keyof MM ? MM[DelegateKey<M>] : unknown);
};

/**
 * Client handed to {@link OrmClient.$transaction} callbacks: the model delegates (with the
 * extensions of the client `$transaction` was called on) and `$cypher`.
 */
export type OrmTransactionClient<TM extends TypeMap, MM extends ModelMethods = None> = Delegates<
  TM,
  MM
> &
  Raw;

/**
 * The ORM client. `MM` and `CM` are the custom model methods and client members added by
 * {@link OrmClient.$extends} (computed fields live in the type map `TM`).
 */
export type OrmClient<
  TM extends TypeMap,
  MM extends ModelMethods = None,
  CM extends object = None,
> = Delegates<TM, MM> &
  Raw & {
    /**
     * Run `fn` in a single write transaction: every operation commits together or not at all.
     * The driver may retry `fn` on transient errors, so keep it free of outside side effects.
     * On an extended client, `tx` has the same query hooks, computed fields and model methods.
     */
    $transaction<T>(fn: (tx: OrmTransactionClient<TM, MM>) => Promise<T>): Promise<T>;
    /**
     * A new client with query hooks, computed fields, model methods and client members added
     * (this client is unchanged). Extensions compose: `db.$extends(a).$extends(b)`.
     *
     * @example
     * ```ts
     * const xdb = db.$extends({
     *   result: {
     *     user: { label: { needs: { name: true, email: true }, compute: (u) => u.name ?? u.email } },
     *   },
     *   model: {
     *     user: {
     *       findByEmail(email: string) {
     *         return this.findUnique({ where: { email } });
     *       },
     *     },
     *   },
     * });
     * ```
     */
    $extends<N extends ResultNeedsMap = None, R = None, M = None, C = None>(
      extension: ExtensionArgs<TM, MM, CM, N, R, M, C>,
    ): ExtendedClient<TM, MM, CM, R, M, C>;
    /** Apply a reusable extension: `db.$extends(softDelete)`, where `softDelete = (db) => db.$extends({ … })`. */
    $extends<T>(extension: (client: OrmClient<TM, MM, CM>) => T): T;
    /**
     * Listen to `"query"`, `"warn"` or `"error"` events (same as `$client.on`). Returns a
     * function that removes the listener.
     *
     * @example
     * ```ts
     * db.$on("query", (e) => console.log(e.model, e.operation, e.durationMs));
     * ```
     */
    $on<L extends LogLevel>(
      level: L,
      listener: (event: Extract<CyphraEvent, { type: L }>) => void,
    ): () => void;
    /** Underlying low-level client (sessions, driver). */
    readonly $client: CyphraClient;
    /** The resolved schema the client was built from. */
    readonly $schema: SchemaModel;
    /** Close the driver (only when the client owns it, i.e. it was created from connection options, not from `{ driver }` or `{ client }`). */
    $disconnect(): Promise<void>;
  } & CM;

function delegateKey(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

type RowsResult = { records: { toObject(): Record<string, unknown> }[] };

/**
 * Executor on `tx`. A uniqueness violation becomes a `UniqueConstraintError` here, after the
 * statement's `error` event (which keeps the Neo4j code), so code catching it inside
 * `$transaction` sees the mapped error too.
 */
function txExecutor(
  instr: Instrumentation,
  schema: SchemaModel,
  tx: TransactionLike,
  meta: QueryMeta,
  dialect: CyphraDialect = "neo4j",
): Executor {
  return async (text, params) => {
    if (dialect === "memgraph") assertMemgraphParams(params);
    let res: RowsResult;
    try {
      res = (await instr.run(text, params, meta, () => tx.run(text, params))) as RowsResult;
    } catch (e) {
      if (dialect === "falkordb") throw await falkordbUniqueError(schema, e, text, params, tx);
      throw dialect === "neo4j"
        ? withDialectHint(mapUniqueError(schema, e))
        : memgraphError(schema, e);
    }
    return res.records.map((r) => r.toObject());
  };
}

/** Memgraph: reject values it cannot store before the statement runs (no zoned `Time` type). */
function assertMemgraphParams(value: unknown, depth = 0): void {
  if (value instanceof CypherTime) {
    throw unsupportedOnMemgraph(
      "The Time type (a time of day with a UTC offset)",
      "Memgraph has no zoned time type. Use LocalTime, or a DateTime.",
    );
  }
  if (value instanceof CypherDuration && value.months.value !== 0n) {
    throw unsupportedOnMemgraph(
      "A Duration with months or years",
      "Memgraph durations have a fixed length (days, hours, minutes, seconds). Use days instead of months.",
    );
  }
  if (depth > 8 || value === null || typeof value !== "object" || value instanceof Date) return;
  for (const v of Array.isArray(value) ? value : Object.values(value)) {
    assertMemgraphParams(v, depth + 1);
  }
}

/**
 * Memgraph reports many errors that retrying cannot fix as *transient* (Cypher it cannot run yet,
 * an invalid duration string, …), which the driver would retry until its retry timeout. Only
 * write conflicts between transactions are worth retrying: anything else is raised as a
 * `CyphraError` (not retried; the original error is the cause).
 */
function memgraphError(schema: SchemaModel, err: unknown): unknown {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (
    typeof e?.code === "string" &&
    e.code.startsWith("Memgraph.TransientError") &&
    typeof e.message === "string" &&
    !/conflicting transactions|retry this transaction/i.test(e.message)
  ) {
    return new CyphraError(`Memgraph cannot run this statement: ${e.message}`, { cause: err });
  }
  return mapUniqueError(schema, err);
}

/**
 * A Memgraph parse error or missing function / procedure under the default `"neo4j"` dialect:
 * the client was most likely meant to use `dialect: "memgraph"`. Say so, keeping the error as the
 * cause.
 */
function withDialectHint(err: unknown): unknown {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (
    typeof e?.code === "string" &&
    e.code.startsWith("Memgraph.") &&
    typeof e.message === "string" &&
    /parsing error|doesn't exist|not supported/i.test(e.message)
  ) {
    return new CyphraError(
      `${e.message} (the server is Memgraph: create the client with dialect: "memgraph")`,
      { cause: err },
    );
  }
  return err;
}

/**
 * `work`, with a uniqueness violation raised outside a statement (at commit) mapped too. Not
 * retried: the drivers only retry transient errors.
 */
async function mapped<T>(schema: SchemaModel, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    throw mapUniqueError(schema, e);
  }
}

/** Runner whose statements carry `meta` (model, operation) in events and spans. */
type RunnerFor = (meta: QueryMeta) => Runner;

/** What every delegate of one client (or transaction client) shares. */
type DelegateContext = {
  readonly instr: Instrumentation;
  readonly schema: SchemaModel;
  readonly runnerFor: RunnerFor;
  readonly options: EngineOptions;
  readonly state: ExtensionState;
  /** The client the delegates belong to (`$parent` in model methods). */
  readonly parent: () => object;
};

/**
 * One model delegate. Each call gets an engine bound to its operation name, wrapped in an
 * operation span: statements it runs report `model` / `operation`. Inside the span, the call goes
 * through the query hooks, then the computed-field layer, then the engine. Custom model methods
 * are bound to the delegate.
 */
function delegate(ctx: DelegateContext, node: ResolvedNodeModel): ModelEngine {
  const { instr, schema, runnerFor, options, state } = ctx;
  const base = new ModelEngine(schema, node, runnerFor({}), options);
  const cache = new Map<string, unknown>();
  const methods = state.methods(node.name);
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "$name") return node.name;
      if (prop === "$parent") return ctx.parent();
      if (typeof prop === "string" && methods.has(prop)) {
        let bound = cache.get(prop);
        if (!bound) {
          const m = methods.get(prop);
          bound = typeof m === "function" ? m.bind(receiver) : m;
          cache.set(prop, bound);
        }
        return bound;
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop !== "string" || typeof value !== "function" || prop === "constructor")
        return value;
      let wrapped = cache.get(prop);
      if (!wrapped) {
        const meta: QueryMeta = { model: node.name, operation: prop };
        const engineCall = (...args: unknown[]) => {
          const engine = new ModelEngine(schema, node, runnerFor(meta), options);
          return (engine as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
            prop
          ]!(...args);
        };
        wrapped = ORM_OPERATIONS.has(prop)
          ? (args?: unknown) =>
              instr.operation(meta, () =>
                runHooks(state, node.name, prop, args, ctx.parent, (a) =>
                  withComputed(state, schema, node, prop, a, (b) =>
                    b === undefined ? engineCall() : engineCall(b),
                  ),
                ),
              )
          : (...args: unknown[]) => instr.operation(meta, async () => engineCall(...args));
        cache.set(prop, wrapped);
      }
      return wrapped;
    },
    has(target, prop) {
      return (typeof prop === "string" && methods.has(prop)) || Reflect.has(target, prop);
    },
  });
}

function fieldResolver(schema: SchemaModel): FieldResolver {
  const byLabel = new Map(schema.nodes.map((n) => [n.label, n]));
  return (label, property) => {
    const node = byLabel.get(label);
    if (!node) return undefined;
    const f = node.fields.find((x) => x.kind === "scalar" && x.name === property);
    const declared =
      f?.kind !== "scalar"
        ? undefined
        : f.id
          ? "@id"
          : f.unique
            ? "@unique"
            : f.index
              ? "@index"
              : undefined;
    return { model: node.name, declared };
  };
}

function buildDelegates(ctx: DelegateContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of ctx.schema.nodes) {
    const key = delegateKey(node.name);
    if (key.startsWith("$")) throw new Error(`Model name "${node.name}" is reserved.`);
    out[key] = delegate(ctx, node);
  }
  return out;
}

function rawFor(instr: Instrumentation, runnerFor: RunnerFor) {
  const meta: QueryMeta = { operation: "$cypher" };
  return (strings: TemplateStringsArray, ...values: unknown[]) =>
    instr.operation(meta, async () => {
      const { text, params } = compileCypher(strings, values);
      const rows = await runnerFor(meta).write(
        (exec) => exec(text, params as Record<string, unknown>),
        { autoCommit: true },
      );
      return rows.map((r) => toNative(r));
    });
}

/**
 * Create a typed ORM client from a resolved schema model. Normally called by the generated
 * `createClient()` in `cyphra.gen.ts`, which supplies both the model and its {@link TypeMap}.
 *
 * @example
 * ```ts
 * import { createClient } from "./cyphra.gen.js";
 * const db = createClient({ uri, user, password });
 * const alice = await db.user.create({ data: { email: "alice@example.com", name: "Alice" } });
 * const posts = await db.post.findMany({ where: { author: { is: { id: alice.id } } }, include: { author: true } });
 * ```
 */
export function createOrm<TM extends TypeMap>(
  schema: SchemaModel,
  options: OrmOptions,
): OrmClient<TM> {
  const { maxTraversalDepth } = options;
  if (
    maxTraversalDepth !== undefined &&
    (!Number.isInteger(maxTraversalDepth) || maxTraversalDepth < 1)
  ) {
    throw new CyphraValidationError("maxTraversalDepth must be a positive integer.");
  }
  const owns = !("client" in options);
  const client = "client" in options ? options.client : new CyphraClient(options);
  // A client from an older @cyphra/runtime (or a test stub) has no dialect: Neo4j.
  const dialect = (client as { dialect?: CyphraDialect }).dialect ?? "neo4j";
  const engineOptions: EngineOptions = { maxTraversalDepth, dialect };
  // A client from another copy (or an older version) of @cyphra/runtime, or a test stub, may have
  // no instrumentation: fall back to an inert one.
  const instr: Instrumentation =
    (client as { instrumentation?: Instrumentation }).instrumentation ??
    new Instrumentation({ openSession: () => client.rawDriver.session() });
  instr.addFieldResolver(fieldResolver(schema));
  if ("client" in options && options.debug) {
    instr.on("query", (e) => console.debug(`[cyphra] cypher: ${e.text}`, e.params));
  }

  // Over HTTP, an operation that is one statement goes out as one auto-commit request.
  const single =
    client.transport === "http" && typeof client.withSingleStatement === "function"
      ? client.withSingleStatement.bind(client)
      : undefined;
  const runnerFor: RunnerFor = (meta) => {
    const m = { ...meta, transaction: false };
    const run = <T>(
      mode: "READ" | "WRITE",
      fn: (exec: Executor) => Promise<T>,
      autoCommit: boolean | undefined,
    ) => {
      const work = (tx: TransactionLike) => fn(txExecutor(instr, schema, tx, m, dialect));
      return mapped(schema, () =>
        autoCommit && single
          ? single(mode, work)
          : mode === "READ"
            ? client.withReadTransaction(work)
            : client.withWriteTransaction(work),
      );
    };
    return {
      read: (fn, o) => run("READ", fn, o?.autoCommit),
      write: (fn, o) => run("WRITE", fn, o?.autoCommit),
    };
  };

  const build = (state: ExtensionState): Record<string, unknown> => {
    const self: Record<string, unknown> = {};
    const transaction = <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      dialect === "falkordb"
        ? Promise.reject(falkordbTransactionError())
        : instr.operation({ operation: "$transaction" }, () =>
            mapped(schema, () =>
              client.withWriteTransaction((tx) => {
                const inTx: RunnerFor = (meta) => {
                  const exec = txExecutor(
                    instr,
                    schema,
                    tx,
                    { ...meta, transaction: true },
                    dialect,
                  );
                  return { read: (f) => f(exec), write: (f) => f(exec) };
                };
                const txClient: Record<string, unknown> = {};
                Object.assign(
                  txClient,
                  buildDelegates({
                    instr,
                    schema,
                    runnerFor: inTx,
                    options: engineOptions,
                    state,
                    parent: () => txClient,
                  }),
                  { $cypher: rawFor(instr, inTx) },
                );
                return fn(txClient);
              }),
            ),
          );
    Object.assign(
      self,
      buildDelegates({
        instr,
        schema,
        runnerFor,
        options: engineOptions,
        state,
        parent: () => self,
      }),
      {
        $cypher: rawFor(instr, runnerFor),
        $transaction: transaction,
        $on: (level: LogLevel, listener: (event: CyphraEvent) => void) => instr.on(level, listener),
        $client: client,
        $schema: schema,
        $disconnect: async () => {
          if (owns) await client.close();
        },
        $extends: (ext: unknown) =>
          typeof ext === "function"
            ? (ext as (c: unknown) => unknown)(self)
            : build(state.extend(ext as ExtensionDef)),
      },
    );
    for (const [k, v] of Object.entries(state.clientMembers())) {
      self[k] = typeof v === "function" ? v.bind(self) : v;
    }
    return self;
  };

  return build(ExtensionState.empty(schema)) as unknown as OrmClient<TM>;
}
