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
import { CyphraValidationError } from "./errors.js";
import type { ModelDelegates, TypeMap } from "./types.js";
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

/** Client handed to {@link OrmClient.$transaction} callbacks. */
export type OrmTransactionClient<TM extends TypeMap> = ModelDelegates<TM> & Raw;

export type OrmClient<TM extends TypeMap> = ModelDelegates<TM> &
  Raw & {
    /**
     * Run `fn` in a single write transaction: every operation commits together or not at all.
     * The driver may retry `fn` on transient errors, so keep it free of outside side effects.
     */
    $transaction<T>(fn: (tx: OrmTransactionClient<TM>) => Promise<T>): Promise<T>;
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
  };

function delegateKey(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

type RowsResult = { records: { toObject(): Record<string, unknown> }[] };

function txExecutor(instr: Instrumentation, tx: TransactionLike, meta: QueryMeta): Executor {
  return async (text, params) => {
    const res = (await instr.run(text, params, meta, () => tx.run(text, params))) as RowsResult;
    return res.records.map((r) => r.toObject());
  };
}

/** Runner whose statements carry `meta` (model, operation) in events and spans. */
type RunnerFor = (meta: QueryMeta) => Runner;

/**
 * One model delegate. Each call gets an engine bound to its operation name, wrapped in an
 * operation span: statements it runs report `model` / `operation`.
 */
function delegate(
  instr: Instrumentation,
  schema: SchemaModel,
  node: ResolvedNodeModel,
  runnerFor: RunnerFor,
  options: EngineOptions,
): ModelEngine {
  const base = new ModelEngine(schema, node, runnerFor({}), options);
  const cache = new Map<string, (...args: unknown[]) => unknown>();
  return new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop !== "string" || typeof value !== "function" || prop === "constructor")
        return value;
      let wrapped = cache.get(prop);
      if (!wrapped) {
        const meta: QueryMeta = { model: node.name, operation: prop };
        wrapped = (...args: unknown[]) =>
          instr.operation(meta, async () => {
            const engine = new ModelEngine(schema, node, runnerFor(meta), options);
            return (engine as unknown as Record<string, (...a: unknown[]) => unknown>)[prop]!(
              ...args,
            );
          });
        cache.set(prop, wrapped);
      }
      return wrapped;
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

function buildDelegates(
  instr: Instrumentation,
  schema: SchemaModel,
  runnerFor: RunnerFor,
  options: EngineOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of schema.nodes) {
    const key = delegateKey(node.name);
    if (key.startsWith("$")) throw new Error(`Model name "${node.name}" is reserved.`);
    out[key] = delegate(instr, schema, node, runnerFor, options);
  }
  return out;
}

function rawFor(instr: Instrumentation, runnerFor: RunnerFor) {
  const meta: QueryMeta = { operation: "$cypher" };
  return (strings: TemplateStringsArray, ...values: unknown[]) =>
    instr.operation(meta, async () => {
      const { text, params } = compileCypher(strings, values);
      const rows = await runnerFor(meta).write((exec) =>
        exec(text, params as Record<string, unknown>),
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
  const engineOptions: EngineOptions = { maxTraversalDepth };
  const owns = !("client" in options);
  const client = "client" in options ? options.client : new CyphraClient(options);
  // A client from another copy (or an older version) of @cyphra/runtime, or a test stub, may have
  // no instrumentation: fall back to an inert one.
  const instr: Instrumentation =
    (client as { instrumentation?: Instrumentation }).instrumentation ??
    new Instrumentation({ openSession: () => client.rawDriver.session() });
  instr.addFieldResolver(fieldResolver(schema));
  if ("client" in options && options.debug) {
    instr.on("query", (e) => console.debug(`[cyphra] cypher: ${e.text}`, e.params));
  }

  const runnerFor: RunnerFor = (meta) => {
    const m = { ...meta, transaction: false };
    return {
      read: (fn) => client.withReadTransaction((tx) => fn(txExecutor(instr, tx, m))),
      write: (fn) => client.withWriteTransaction((tx) => fn(txExecutor(instr, tx, m))),
    };
  };

  const transaction = <T>(fn: (tx: OrmTransactionClient<TM>) => Promise<T>): Promise<T> =>
    instr.operation({ operation: "$transaction" }, () =>
      client.withWriteTransaction((tx) => {
        const inTx: RunnerFor = (meta) => {
          const exec = txExecutor(instr, tx, { ...meta, transaction: true });
          return { read: (f) => f(exec), write: (f) => f(exec) };
        };
        const txClient = {
          ...buildDelegates(instr, schema, inTx, engineOptions),
          $cypher: rawFor(instr, inTx),
        };
        return fn(txClient as OrmTransactionClient<TM>);
      }),
    );

  return {
    ...buildDelegates(instr, schema, runnerFor, engineOptions),
    $cypher: rawFor(instr, runnerFor),
    $transaction: transaction,
    $on: (level: LogLevel, listener: (event: CyphraEvent) => void) => instr.on(level, listener),
    $client: client,
    $schema: schema,
    $disconnect: async () => {
      if (owns) await client.close();
    },
  } as unknown as OrmClient<TM>;
}
