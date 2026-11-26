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
import { CyphraError, CyphraValidationError, UnsupportedFeatureError } from "./errors.js";
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
import { MODEL_RULE_KEYS, RULE_OPERATIONS, type EngineRules } from "./scope.js";

/** Key of the hidden method behind {@link withEngineRules} (shared by every copy of the runtime). */
const WITH_RULES = Symbol.for("cyphra.withEngineRules");

/**
 * A client whose statements carry `rules` (see {@link EngineRules}), on top of the rules `client`
 * already has (they all apply: rules can be added, never removed). The new client keeps the
 * extensions of `client`, and so do its `$extends` and `$transaction` clients.
 *
 * This is the engine entry `@cyphra/graphql`'s native API builds its authorization rules on. It is
 * internal: experimental, and not covered by semantic versioning.
 *
 * @internal
 * @experimental
 */
export function withEngineRules<C extends object>(client: C, rules: EngineRules): C {
  const fn = (client as Record<symbol, unknown>)[WITH_RULES];
  if (typeof fn !== "function") {
    throw new CyphraValidationError(
      "withEngineRules: not a Cyphra ORM client (createOrm / createClient).",
    );
  }
  return (fn as (r: EngineRules) => C)(rules);
}

/** Key of the hidden method behind {@link withRawValues}. */
const WITH_RAW = Symbol.for("cyphra.withRawValues");

/**
 * A client whose reads return projected scalars (node and edge properties) as the driver gives
 * them: `Integer`, temporal and point objects, `null` for a missing list, instead of the values
 * decoded for their schema type. Rules, extensions and hooks of `client` are kept.
 *
 * This is the engine entry `@cyphra/graphql`'s `compat.v7` reads through, so that it shapes
 * values exactly as `@neo4j/graphql` does. It is internal: experimental, and not covered by
 * semantic versioning.
 *
 * @internal
 * @experimental
 */
export function withRawValues<C extends object>(client: C): C {
  const fn = (client as Record<symbol, unknown>)[WITH_RAW];
  if (typeof fn !== "function") {
    throw new CyphraValidationError(
      "withRawValues: not a Cyphra ORM client (createOrm / createClient).",
    );
  }
  return (fn as () => C)();
}

/** Key of the hidden method behind {@link withReadTransaction}. */
const READ_TX = Symbol.for("cyphra.withReadTransaction");

/**
 * Run `fn` in one read transaction of `client`: `tx` has the model delegates of `client` (same
 * extensions, hooks and engine rules), and every statement `fn` runs through them shares the
 * transaction. On FalkorDB, which has no multi-statement transactions, `fn` gets `client` itself.
 *
 * This is the engine entry `@cyphra/graphql`'s native API runs a root field in (a page and its
 * `totalCount`). It is internal: experimental, and not covered by semantic versioning.
 *
 * @internal
 * @experimental
 */
export function withReadTransaction<C extends object, T>(
  client: C,
  fn: (tx: C) => Promise<T>,
): Promise<T> {
  const run = (client as Record<symbol, unknown>)[READ_TX];
  if (typeof run !== "function") {
    throw new CyphraValidationError(
      "withReadTransaction: not a Cyphra ORM client (createOrm / createClient).",
    );
  }
  return (run as (f: (tx: C) => Promise<T>) => Promise<T>)(fn);
}

/** Key of the hidden method behind {@link computedFieldsOf}. */
const COMPUTED = Symbol.for("cyphra.computedFields");

/**
 * The computed fields (`$extends({ result })`) of `model` on `client`, with the scalar fields
 * each one `needs`; `undefined` when `client` is not a Cyphra ORM client.
 *
 * This is the engine entry `@cyphra/graphql`'s native API checks its `computed` config against.
 * It is internal: experimental, and not covered by semantic versioning.
 *
 * @internal
 * @experimental
 */
export function computedFieldsOf(
  client: object,
  model: string,
): ReadonlyMap<string, { readonly needs: readonly string[] }> | undefined {
  const fn = (client as Record<symbol, unknown>)[COMPUTED];
  if (typeof fn !== "function") return undefined;
  return (fn as (m: string) => ReadonlyMap<string, { readonly needs: readonly string[] }>)(model);
}

/** Check `rules` against the schema: known models, operations and fields, valid values. */
function checkEngineRules(schema: SchemaModel, rules: EngineRules, dialect: CyphraDialect): void {
  if (typeof rules !== "object" || rules === null || Array.isArray(rules)) {
    throw new CyphraValidationError(
      "withEngineRules: rules must be an object keyed by model name.",
    );
  }
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const checkValue = (where: string, rule: unknown) => {
    if (typeof rule !== "boolean" && !isObject(rule)) {
      throw new CyphraValidationError(
        `withEngineRules: ${where} must be true, false or a where object.`,
      );
    }
  };
  for (const [model, ops] of Object.entries(rules)) {
    if (ops === undefined) continue;
    const node = schema.nodes.find((n) => n.name === model);
    if (!node) {
      throw new CyphraValidationError(`withEngineRules: unknown model "${model}".`);
    }
    if (!isObject(ops)) {
      throw new CyphraValidationError(`withEngineRules: rules.${model} must be an object.`);
    }
    for (const [op, rule] of Object.entries(ops)) {
      if (rule === undefined) continue;
      const where = `rules.${model}.${op}`;
      if (!(MODEL_RULE_KEYS as readonly string[]).includes(op)) {
        throw new CyphraValidationError(
          `withEngineRules: unknown operation "${op}" in rules.${model} (use ${MODEL_RULE_KEYS.join(", ")}).`,
        );
      }
      if ((RULE_OPERATIONS as readonly string[]).includes(op)) {
        checkValue(where, rule);
        continue;
      }
      if (op === "create") {
        if (typeof rule !== "boolean" && typeof rule !== "function") {
          throw new CyphraValidationError(
            `withEngineRules: ${where} must be a boolean or a function.`,
          );
        }
        continue;
      }
      if (!isObject(rule)) {
        throw new CyphraValidationError(`withEngineRules: ${where} must be an object.`);
      }
      if ((op === "after" || op === "disconnect") && dialect === "falkordb") {
        // Both fail a write after it ran: FalkorDB cannot roll it back.
        throw new UnsupportedFeatureError(
          `withEngineRules: ${where} (a rule checked after a write ran)`,
          "falkordb",
          "FalkorDB has no transactions to roll the write back.",
        );
      }
      for (const [key, value] of Object.entries(rule)) {
        if (value === undefined) continue;
        if (op === "after") {
          if (key !== "create" && key !== "update") {
            throw new CyphraValidationError(
              `withEngineRules: unknown key "${key}" in ${where} (use create, update).`,
            );
          }
        } else {
          const f = node.fields.find((x) => x.name === key);
          const kind = op === "fields" ? "scalar" : "relation";
          if (f?.kind !== kind) {
            throw new CyphraValidationError(
              `withEngineRules: ${where}.${key}: not a ${kind} field of ${model}.`,
            );
          }
        }
        checkValue(`${where}.${key}`, value);
      }
    }
  }
}

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
  const byLabel = new Map(schema.nodes.filter((n) => !n.union).map((n) => [n.label, n]));
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

const delegateCache = new WeakMap<SchemaModel, readonly (readonly [string, ResolvedNodeModel])[]>();

/** `[delegate key, model]` of every model of `schema`, checked once per schema. */
function delegateEntries(schema: SchemaModel): readonly (readonly [string, ResolvedNodeModel])[] {
  let entries = delegateCache.get(schema);
  if (!entries) {
    entries = schema.nodes.map((node) => {
      const key = delegateKey(node.name);
      if (key.startsWith("$")) throw new Error(`Model name "${node.name}" is reserved.`);
      return [key, node] as const;
    });
    delegateCache.set(schema, entries);
  }
  return entries;
}

/** Install the model delegates on `target`. */
function installDelegates(target: Record<string, unknown>, ctx: DelegateContext): void {
  for (const [key, node] of delegateEntries(ctx.schema)) target[key] = delegate(ctx, node);
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

  const build = (state: ExtensionState, opts: EngineOptions): Record<string, unknown> => {
    const self: Record<string, unknown> = {};
    const transactionIn = <T>(
      mode: "READ" | "WRITE",
      fn: (tx: unknown) => Promise<T>,
    ): Promise<T> =>
      instr.operation({ operation: "$transaction" }, () =>
        mapped(schema, () =>
          (mode === "READ"
            ? client.withReadTransaction.bind(client)
            : client.withWriteTransaction.bind(client))((tx) => {
            const inTx: RunnerFor = (meta) => {
              const exec = txExecutor(instr, schema, tx, { ...meta, transaction: true }, dialect);
              return { read: (f) => f(exec), write: (f) => f(exec) };
            };
            const txClient: Record<string, unknown> = {};
            installDelegates(txClient, {
              instr,
              schema,
              runnerFor: inTx,
              options: opts,
              state,
              parent: () => txClient,
            });
            txClient.$cypher = rawFor(instr, inTx);
            return fn(txClient);
          }),
        ),
      );
    const transaction = <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      dialect === "falkordb"
        ? Promise.reject(falkordbTransactionError())
        : transactionIn("WRITE", fn);
    installDelegates(self, {
      instr,
      schema,
      runnerFor,
      options: opts,
      state,
      parent: () => self,
    });
    Object.assign(self, {
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
          : build(state.extend(ext as ExtensionDef), opts),
    });
    Object.defineProperty(self, WITH_RULES, {
      value: (rules: EngineRules) => {
        checkEngineRules(schema, rules, dialect);
        return build(state, {
          ...opts,
          rules: [...(opts.rules ?? []), rules],
        });
      },
    });
    Object.defineProperty(self, COMPUTED, { value: (model: string) => state.computed(model) });
    Object.defineProperty(self, WITH_RAW, {
      value: () => build(state, { ...opts, rawValues: true }),
    });
    Object.defineProperty(self, READ_TX, {
      value: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
        dialect === "falkordb" ? fn(self) : transactionIn("READ", fn),
    });
    for (const [k, v] of Object.entries(state.clientMembers())) {
      self[k] = typeof v === "function" ? v.bind(self) : v;
    }
    return self;
  };

  return build(ExtensionState.empty(schema), engineOptions) as unknown as OrmClient<TM>;
}
