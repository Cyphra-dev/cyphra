import type { ManagedTransaction } from "neo4j-driver";
import type { SchemaModel } from "@cyphra/schema";
import { compileCypher } from "@cyphra/query";
import { CyphraClient, type CyphraClientOptions } from "../client.js";
import { ModelEngine, type Executor, type Runner } from "./engine.js";
import type { ModelDelegates, TypeMap } from "./types.js";
import { toNative } from "./values.js";

/**
 * Options for {@link createOrm}: connection options, an existing `neo4j-driver` 5.28+ / 6.x
 * `Driver` (`{ driver }`), or an existing {@link CyphraClient}.
 */
export type OrmOptions = CyphraClientOptions | { client: CyphraClient; debug?: boolean };

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

function txExecutor(tx: ManagedTransaction, debug: boolean): Executor {
  return async (text, params) => {
    if (debug) console.debug("[cyphra] cypher:", text, "param keys:", Object.keys(params));
    const res = await tx.run(text, params);
    return res.records.map((r) => r.toObject());
  };
}

function buildDelegates(schema: SchemaModel, runner: Runner): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of schema.nodes) {
    const key = delegateKey(node.name);
    if (key.startsWith("$")) throw new Error(`Model name "${node.name}" is reserved.`);
    out[key] = new ModelEngine(schema, node, runner);
  }
  return out;
}

function rawFor(runner: Runner) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const { text, params } = compileCypher(strings, values);
    const rows = await runner.write((exec) => exec(text, params as Record<string, unknown>));
    return rows.map((r) => toNative(r));
  };
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
  const owns = !("client" in options);
  const client = "client" in options ? options.client : new CyphraClient(options);
  const debug = options.debug ?? false;

  const runner: Runner = {
    read: (fn) => client.withReadTransaction((tx) => fn(txExecutor(tx, debug))),
    write: (fn) => client.withWriteTransaction((tx) => fn(txExecutor(tx, debug))),
  };

  const transaction = <T>(fn: (tx: OrmTransactionClient<TM>) => Promise<T>): Promise<T> =>
    client.withWriteTransaction((tx) => {
      const exec = txExecutor(tx, debug);
      const inTx: Runner = { read: (f) => f(exec), write: (f) => f(exec) };
      const txClient = { ...buildDelegates(schema, inTx), $cypher: rawFor(inTx) };
      return fn(txClient as OrmTransactionClient<TM>);
    });

  return {
    ...buildDelegates(schema, runner),
    $cypher: rawFor(runner),
    $transaction: transaction,
    $client: client,
    $schema: schema,
    $disconnect: async () => {
      if (owns) await client.close();
    },
  } as unknown as OrmClient<TM>;
}
