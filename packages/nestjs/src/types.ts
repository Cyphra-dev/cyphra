/**
 * What `@cyphra/nestjs` needs from a client: the generated `createClient()` (an `OrmClient`, plain
 * or extended with `$extends`) has all of it.
 */
export interface CyphraClientLike {
  // `any`: the transaction client type differs per schema (see CyphraTransaction).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
  $disconnect(): Promise<void>;
  $cypher(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
}

/**
 * The transaction client of a client type: what `$transaction` hands its callback, and what
 * {@link getTransaction} returns inside a `@Transactional()` method.
 *
 * @example
 * ```ts
 * import type { Db } from "./cyphra.gen";
 * type Tx = CyphraTransaction<Db>; // tx.user.create(...), tx.$cypher`...`
 * ```
 */
export type CyphraTransaction<C extends CyphraClientLike> = C extends {
  $transaction<T>(fn: (tx: infer Tx) => Promise<T>): Promise<T>;
}
  ? Tx
  : never;
