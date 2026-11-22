import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_CONNECTION } from "./tokens.js";
import type { CyphraClientLike, CyphraTransaction } from "./types.js";

/** Active transaction client of each connection, for the current async call chain. */
const storage = new AsyncLocalStorage<ReadonlyMap<string, unknown>>();

/** Root client of each connection, registered by `CyphraModule` (for `@Transactional()`). */
const registry = new Map<string, CyphraClientLike>();

/** @internal */
export function registerClient(connection: string, client: CyphraClientLike): void {
  registry.set(connection, client);
}

/** @internal Removes the connection, unless another application registered it since. */
export function unregisterClient(connection: string, client: CyphraClientLike): void {
  if (registry.get(connection) === client) registry.delete(connection);
}

/**
 * The transaction client of the `@Transactional()` method (or `db.$transaction` callback) that is
 * running in the current async call chain, or `undefined` outside of one.
 *
 * You rarely need it: the client injected with `@InjectCyphra()` already sends its queries to that
 * transaction.
 */
export function getTransaction<C extends CyphraClientLike = CyphraClientLike>(
  connection: string = DEFAULT_CONNECTION,
): CyphraTransaction<C> | undefined {
  return storage.getStore()?.get(connection) as CyphraTransaction<C> | undefined;
}

/** Whether a transaction of `connection` is active in the current async call chain. */
export function isInTransaction(connection: string = DEFAULT_CONNECTION): boolean {
  return storage.getStore()?.has(connection) ?? false;
}

/**
 * Run `fn` in the active transaction of `connection`, or in a new one on `client` (committed when
 * `fn` resolves, rolled back when it rejects) that nested calls then join.
 */
function runInTransaction<T>(
  client: CyphraClientLike,
  connection: string,
  fn: (tx: unknown) => Promise<T>,
): Promise<T> {
  const store = storage.getStore();
  if (store?.has(connection)) return fn(store.get(connection));
  return client.$transaction((tx: unknown) =>
    storage.run(new Map(store).set(connection, tx), () => fn(tx)),
  );
}

/**
 * The client that `@InjectCyphra()` injects: `client` itself outside of a transaction; inside a
 * `@Transactional()` method or a `$transaction` callback, its model delegates and `$cypher` run in
 * that transaction, and `$transaction` joins it instead of starting another.
 *
 * @internal
 */
export function transactionAware<C extends CyphraClientLike>(client: C, connection: string): C {
  const $transaction = <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    runInTransaction(client, connection, fn);
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "$transaction") return $transaction;
      const tx = storage.getStore()?.get(connection) as object | undefined;
      const source: object = tx !== undefined && prop in tx ? tx : target;
      const value: unknown = Reflect.get(source, prop);
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
}

/** Options of {@link Transactional}. */
export interface TransactionalOptions {
  /** Connection to run the transaction on (`connection` of `CyphraModule.forRoot`). */
  connection?: string;
}

type ReflectMetadata = {
  getOwnMetadataKeys?(target: object): unknown[];
  getOwnMetadata?(key: unknown, target: object): unknown;
  defineMetadata?(key: unknown, value: unknown, target: object): void;
};

/** Keep what other decorators (`@Get()`, `@MessagePattern()`, …) stored on the method. */
function copyMetadata(from: object, to: object): void {
  const r = Reflect as unknown as ReflectMetadata;
  if (!r.getOwnMetadataKeys || !r.getOwnMetadata || !r.defineMetadata) return;
  for (const key of r.getOwnMetadataKeys(from)) {
    r.defineMetadata(key, r.getOwnMetadata(key, from), to);
  }
}

/**
 * Run the method in a write transaction: every query made through the injected client while it
 * runs, including in the services it calls, commits together when the method resolves and rolls
 * back when it throws. A `@Transactional()` method called from another one joins the outer
 * transaction.
 *
 * The driver may retry the transaction (so run the method again) on transient errors: keep side
 * effects outside of the database (emails, HTTP calls) out of it.
 *
 * @param options - `{ connection }`, or the connection name, for a client registered with
 *   `CyphraModule.forRoot({ connection })`.
 *
 * @example
 * ```ts
 * @Injectable()
 * export class TransfersService {
 *   constructor(@InjectCyphra() private readonly db: Db, private readonly audit: AuditService) {}
 *
 *   @Transactional()
 *   async transfer(from: string, to: string, amount: number) {
 *     await this.db.account.update({ where: { id: from }, data: { balance: { decrement: amount } } });
 *     await this.db.account.update({ where: { id: to }, data: { balance: { increment: amount } } });
 *     await this.audit.record("transfer", { from, to, amount }); // same transaction
 *   }
 * }
 * ```
 */
export function Transactional(options: TransactionalOptions | string = {}): MethodDecorator {
  const connection =
    (typeof options === "string" ? options : options.connection) ?? DEFAULT_CONNECTION;
  return (target, propertyKey, descriptor) => {
    const original: unknown = descriptor.value;
    if (typeof original !== "function") {
      throw new TypeError(
        `@Transactional() decorates methods: ${target.constructor.name}.${String(propertyKey)} is not one.`,
      );
    }
    const wrapped = function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const store = storage.getStore();
      if (store?.has(connection)) return Promise.resolve(original.apply(this, args));
      const client = registry.get(connection);
      if (!client) {
        return Promise.reject(
          new Error(
            `@Transactional(): no Cyphra client for connection "${connection}". Import ` +
              `CyphraModule.forRoot() or forRootAsync()${connection === DEFAULT_CONNECTION ? "" : ` with connection: "${connection}"`} ` +
              `and call the method once the application is initialized.`,
          ),
        );
      }
      return runInTransaction(client, connection, async () => original.apply(this, args));
    };
    Object.defineProperty(wrapped, "name", { value: original.name });
    copyMetadata(original, wrapped);
    descriptor.value = wrapped as typeof descriptor.value;
    return descriptor;
  };
}
