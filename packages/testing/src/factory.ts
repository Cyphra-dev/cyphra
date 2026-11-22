import type { CreateInput, DelegateKey, Payload, TypeMap, WhereUniqueInput } from "@cyphra/runtime";

/** What a factory's defaults function receives. */
export type FactoryContext = {
  /** 1 for the first record the factory builds, then 2, 3, … (see {@link Factory.resetSequence}). */
  readonly sequence: number;
};

/** Models of `TM` that can be created (not interfaces or unions). */
export type CreatableModel<TM extends TypeMap> = {
  [M in keyof TM & string]: TM[M] extends { abstract: true } ? never : M;
}[keyof TM & string];

/**
 * `T` where each field may also be a function returning its value, called only when the field is
 * not overridden: `author: () => users.nested()` builds an author only for records that get none.
 */
export type LazyFields<T> = { [K in keyof T]: T[K] | (() => T[K]) };

/**
 * Values of a factory: a complete create input (fields may be {@link LazyFields}), or a function
 * of the sequence returning one.
 */
export type FactoryDefaults<TM extends TypeMap, M extends keyof TM> =
  LazyFields<CreateInput<TM, M>> | ((ctx: FactoryContext) => LazyFields<CreateInput<TM, M>>);

/** Values that replace some of the defaults for one record. */
export type FactoryOverrides<TM extends TypeMap, M extends keyof TM> =
  | Partial<LazyFields<CreateInput<TM, M>>>
  | ((ctx: FactoryContext) => Partial<LazyFields<CreateInput<TM, M>>>);

/**
 * A client a factory can create `M` records with: an ORM client, a transaction client
 * (`$transaction` / `withRollback`), or an extended client.
 */
export type FactoryClient<TM extends TypeMap, M extends keyof TM & string> = {
  readonly [K in DelegateKey<M>]: {
    create(args: { data: CreateInput<TM, M> }): Promise<unknown>;
  };
};

/** A created `M` record (its scalar fields), as `db.<model>.create` returns it. */
export type FactoryRecord<TM extends TypeMap, M extends keyof TM> = Payload<
  TM,
  M,
  Record<never, never>
>;

/** Builds and creates `M` records from defaults. */
export type Factory<TM extends TypeMap, M extends keyof TM & string> = {
  /** The model name (`"User"`). */
  readonly model: M;
  /** The create input for one record (nothing is written). */
  build(overrides?: FactoryOverrides<TM, M>): CreateInput<TM, M>;
  /** `count` create inputs; a function override gets each record's sequence. */
  buildList(count: number, overrides?: FactoryOverrides<TM, M>): CreateInput<TM, M>[];
  /** Create one record (`db.<model>.create`), nested relation writes included. */
  create(
    db: FactoryClient<TM, M>,
    overrides?: FactoryOverrides<TM, M>,
  ): Promise<FactoryRecord<TM, M>>;
  /** Create `count` records, one after the other (in sequence order). */
  createList(
    db: FactoryClient<TM, M>,
    count: number,
    overrides?: FactoryOverrides<TM, M>,
  ): Promise<FactoryRecord<TM, M>[]>;
  /**
   * A relation write that creates one record with this factory, for another factory's defaults or
   * a `create` input: `author: users.nested()` (one statement, no extra round trip).
   */
  nested(overrides?: FactoryOverrides<TM, M>): { create: CreateInput<TM, M> };
  /** A relation write that creates `count` records with this factory: `tags: tags.nestedList(2)`. */
  nestedList(count: number, overrides?: FactoryOverrides<TM, M>): { create: CreateInput<TM, M>[] };
  /** A relation write that links an existing record: `author: users.connect({ id: ada.id })`. */
  connect(where: WhereUniqueInput<TM, M>): { connect: WhereUniqueInput<TM, M> };
  /**
   * A factory with more defaults on top of these ones (a variant, such as an admin user). It shares
   * this factory's sequence.
   */
  extend(defaults: FactoryOverrides<TM, M>): Factory<TM, M>;
  /** Start the sequence over at 1. */
  resetSequence(): void;
};

const counters = new Set<{ value: number }>();

/** Start the sequence of every factory over at 1 (e.g. in `beforeEach`, for stable values). */
export function resetSequences(): void {
  for (const c of counters) c.value = 0;
}

function resolve<V>(value: V | ((ctx: FactoryContext) => V), ctx: FactoryContext): V {
  return typeof value === "function" ? (value as (ctx: FactoryContext) => V)(ctx) : value;
}

function delegateKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

function makeFactory<TM extends TypeMap, M extends keyof TM & string>(
  model: M,
  layers: readonly FactoryOverrides<TM, M>[],
  counter: { value: number },
): Factory<TM, M> {
  const build = (overrides?: FactoryOverrides<TM, M>): CreateInput<TM, M> => {
    const ctx: FactoryContext = { sequence: ++counter.value };
    let data: Record<string, unknown> = {};
    for (const layer of overrides === undefined ? layers : [...layers, overrides]) {
      data = { ...data, ...(resolve(layer, ctx) as Record<string, unknown>) };
    }
    // Lazy fields: only the ones no later layer replaced are still functions here.
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "function") data[key] = (value as () => unknown)();
    }
    return data as CreateInput<TM, M>;
  };
  const buildList = (count: number, overrides?: FactoryOverrides<TM, M>) =>
    Array.from({ length: count }, () => build(overrides));
  const create = async (db: FactoryClient<TM, M>, overrides?: FactoryOverrides<TM, M>) => {
    const delegate = (db as Record<string, { create(args: unknown): Promise<unknown> }>)[
      delegateKey(model)
    ];
    if (!delegate || typeof delegate.create !== "function") {
      throw new Error(`@cyphra/testing: the client has no "${delegateKey(model)}" model`);
    }
    return (await delegate.create({ data: build(overrides) })) as FactoryRecord<TM, M>;
  };
  return {
    model,
    build,
    buildList,
    create,
    async createList(db, count, overrides) {
      const out: FactoryRecord<TM, M>[] = [];
      for (let i = 0; i < count; i++) out.push(await create(db, overrides));
      return out;
    },
    nested: (overrides) => ({ create: build(overrides) }),
    nestedList: (count, overrides) => ({ create: buildList(count, overrides) }),
    connect: (where) => ({ connect: where }),
    extend: (defaults) => makeFactory(model, [...layers, defaults], counter),
    resetSequence() {
      counter.value = 0;
    },
  };
}

/**
 * Define a factory for model `M` of a generated client's type map (`CyphraTypeMap` in
 * `cyphra.gen.ts`). The defaults must be a complete create input: required fields are checked at
 * compile time. {@link factoriesFor} saves repeating the type map.
 *
 * @example
 * ```ts
 * import type { CyphraTypeMap } from "./cyphra.gen";
 *
 * export const users = defineFactory<CyphraTypeMap, "User">("User", ({ sequence }) => ({
 *   email: `user${sequence}@example.com`,
 *   name: `User ${sequence}`,
 * }));
 *
 * const ada = await users.create(db, { name: "Ada" });
 * ```
 */
export function defineFactory<TM extends TypeMap, M extends CreatableModel<TM>>(
  model: M,
  defaults: FactoryDefaults<TM, M>,
): Factory<TM, M> {
  const counter = { value: 0 };
  counters.add(counter);
  return makeFactory<TM, M>(model, [defaults as FactoryOverrides<TM, M>], counter);
}

/**
 * {@link defineFactory} bound to one type map, so only the model name is given (and checked).
 *
 * @example
 * ```ts
 * const { defineFactory } = factoriesFor<CyphraTypeMap>();
 *
 * export const users = defineFactory("User", ({ sequence }) => ({ email: `u${sequence}@example.com` }));
 * export const posts = defineFactory("Post", ({ sequence }) => ({
 *   title: `Post ${sequence}`,
 *   author: users.nested(),
 * }));
 * ```
 */
export function factoriesFor<TM extends TypeMap>(): {
  defineFactory<M extends CreatableModel<TM>>(
    model: M,
    defaults: FactoryDefaults<TM, M>,
  ): Factory<TM, M>;
  resetSequences(): void;
} {
  return {
    defineFactory: (model, defaults) => defineFactory<TM, typeof model>(model, defaults),
    resetSequences,
  };
}
