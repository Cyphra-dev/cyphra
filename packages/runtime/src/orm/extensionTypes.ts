/**
 * Type-level API of client extensions (`db.$extends({ query, result, model, client })`).
 *
 * An extended client is an {@link OrmClient} with three extra type parameters folded in:
 * - computed fields, carried in the type map itself (`TypeMap[Model]["computed"]`), so every
 *   result type (`select`, `include`, nested relations, interfaces) picks them up;
 * - custom model methods (`MM`, keyed by delegate name: `{ user: { findByEmail(…) } }`);
 * - custom client members (`CM`: `{ $health(…) }`).
 *
 * @packageDocumentation
 */
import type { OrmClient, OrmTransactionClient } from "./client.js";
import type {
  BatchResult,
  ComputedFields,
  DelegateKey,
  ModelDelegate,
  Path,
  Payload,
  TypeMap,
} from "./types.js";

/** Every model operation a query hook can intercept. */
export type OrmOperation =
  | "findMany"
  | "findFirst"
  | "findUnique"
  | "findUniqueOrThrow"
  | "count"
  | "create"
  | "createMany"
  | "update"
  | "updateMany"
  | "upsert"
  | "delete"
  | "deleteMany"
  | "aggregate"
  | "groupBy"
  | "traverse"
  | "shortestPath"
  | "allShortestPaths"
  | "findSimilar"
  | "search";

type Simplify<T> = { [K in keyof T]: T[K] } & {};
/** `A` with the keys of `B` replaced by those of `B`. */
type Overwrite<A, B> = [keyof B] extends [never] ? A : Omit<A, keyof B> & B;

type ModelName<TM extends TypeMap> = keyof TM & string;

/** Delegate keys of the models of `TM` (`"user" | "post"`). */
export type ModelKey<TM extends TypeMap> = DelegateKey<ModelName<TM>>;

/** The model behind the delegate key `K` (`"user"` → `"User"`). */
export type ModelOfKey<TM extends TypeMap, K> = {
  [M in ModelName<TM>]: DelegateKey<M> extends K ? M : never;
}[ModelName<TM>];

/** Operations model `M` has (an interface has no `create`, a model without vectors no `findSimilar`, …). */
export type ModelOperations<TM extends TypeMap, M extends keyof TM> = keyof ModelDelegate<TM, M> &
  OrmOperation;

/** Arguments of operation `O` on model `M`, as a query hook sees them. */
export type OperationArgs<TM extends TypeMap, M extends keyof TM, O extends OrmOperation> =
  ModelDelegate<TM, M> extends { [P in O]: (args: infer A) => unknown } ? NonNullable<A> : never;

/**
 * Result of operation `O` on model `M`, as a query hook sees it (node results are typed without
 * `select` / `include`; the actual shape follows the arguments).
 */
export type OperationResult<
  TM extends TypeMap,
  M extends keyof TM,
  O extends OrmOperation,
> = O extends "findMany" | "traverse"
  ? Payload<TM, M, object>[]
  : O extends "findFirst" | "findUnique"
    ? Payload<TM, M, object> | null
    : O extends "findUniqueOrThrow" | "create" | "update" | "upsert" | "delete"
      ? Payload<TM, M, object>
      : O extends "count"
        ? number
        : O extends "createMany" | "updateMany" | "deleteMany"
          ? BatchResult & { nodes?: Payload<TM, M, object>[] }
          : O extends "aggregate"
            ? Record<string, unknown>
            : O extends "groupBy"
              ? Record<string, unknown>[]
              : O extends "shortestPath"
                ? Path<Payload<TM, M, object>> | null
                : O extends "allShortestPaths"
                  ? Path<Payload<TM, M, object>>[]
                  : O extends "findSimilar" | "search"
                    ? (Payload<TM, M, object> & { $score: number })[]
                    : unknown;

/** What a query hook for operation `O` on model `M` receives. */
export type QueryHookParams<TM extends TypeMap, M extends keyof TM, O extends OrmOperation> = {
  /** Model name (`"User"`). */
  model: M;
  operation: O;
  /** The call's arguments (`{}` when the operation was called without any). */
  args: OperationArgs<TM, M, O>;
  /** Run the operation (the next hook, then the query itself) with these arguments. */
  query: (args: OperationArgs<TM, M, O>) => Promise<OperationResult<TM, M, O>>;
} & HookClient<TM>;

/**
 * `client` in hook params: the extended client the call was made on (the transaction client
 * inside `$transaction`), to run other operations in the same transaction. Its calls go through
 * the hooks again.
 */
export type HookClient<TM extends TypeMap> = { client: OrmTransactionClient<TM> };

/** A query hook: returns the operation's result, usually `query(args)`, possibly changed. */
export type QueryHook<TM extends TypeMap, M extends keyof TM, O extends OrmOperation> = (
  params: QueryHookParams<TM, M, O>,
) => Promise<OperationResult<TM, M, O>> | OperationResult<TM, M, O>;

/** Loosely typed arguments, for hooks spanning several operations or models. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyArgs = Record<string, any>;

/**
 * What a `$allOperations` hook of model `M` receives: discriminated by `operation` (narrowing it
 * narrows `args`). `query` takes the arguments of whichever operation runs.
 */
export type AllOperationsHookParams<TM extends TypeMap, M extends keyof TM> = {
  [O in ModelOperations<TM, M>]: {
    model: M;
    operation: O;
    args: OperationArgs<TM, M, O>;
    query: (args: AnyArgs) => Promise<unknown>;
  } & HookClient<TM>;
}[ModelOperations<TM, M>];

/** What a hook under `$allModels` receives (models and arguments are loosely typed). */
export type AnyModelHookParams<TM extends TypeMap, O extends string = OrmOperation> = {
  model: ModelName<TM>;
  operation: O;
  args: AnyArgs;
  query: (args: AnyArgs) => Promise<unknown>;
} & HookClient<TM>;

type ModelQueryExtension<TM extends TypeMap, M extends keyof TM> = {
  [O in ModelOperations<TM, M>]?: QueryHook<TM, M, O>;
} & {
  /** Runs around every operation of this model. */
  $allOperations?: (params: AllOperationsHookParams<TM, M>) => Promise<unknown>;
};

/**
 * `query` of `$extends`: hooks around model operations, per model (`user: { create(…) }`) and
 * for every model (`$allModels: { findMany(…), $allOperations(…) }`).
 */
export type QueryExtension<TM extends TypeMap> = {
  [K in ModelKey<TM>]?: ModelQueryExtension<TM, ModelOfKey<TM, K>>;
} & {
  $allModels?: {
    [O in OrmOperation]?: (params: AnyModelHookParams<TM, O>) => Promise<unknown>;
  } & {
    $allOperations?: (params: AnyModelHookParams<TM>) => Promise<unknown>;
  };
};

// ---------------------------------------------------------------------------
// Computed fields (`result`)
// ---------------------------------------------------------------------------

/** `needs` of a computed field: the scalar fields `compute` reads. */
export type ResultNeeds<S> = { [K in keyof S]?: boolean };

type TrueKeys<T> = { [K in keyof T]: T[K] extends false | undefined ? never : K }[keyof T];

/** The scalars of model `M` (or of every model, under `$allModels`) for delegate key `K`. */
type ScalarsForKey<TM extends TypeMap, K> =
  K extends ModelKey<TM> ? TM[ModelOfKey<TM, K>]["scalars"] : Record<string, unknown>;

/** What `compute` receives: the fields listed in `needs`. */
export type ComputeInput<S, N> = Simplify<Pick<S, TrueKeys<N> & keyof S>>;

/**
 * `result` of `$extends`. `N` (inferred) maps each model and field to its `needs`, which types the
 * row `compute` receives.
 */
export type ResultExtension<TM extends TypeMap, N> = {
  [K in keyof N]: {
    [F in keyof N[K]]: {
      /** Scalar fields `compute` reads: fetched even when `select` leaves them out. */
      needs?: N[K][F] &
        ResultNeeds<ScalarsForKey<TM, K>> & {
          [X in Exclude<keyof N[K][F], keyof ScalarsForKey<TM, K>>]: never;
        };
      compute: (row: ComputeInput<ScalarsForKey<TM, K>, N[K][F]>) => unknown;
    };
  };
} & {
  [K in Exclude<keyof N, ModelKey<TM> | "$allModels">]: never;
};

/** Constraint of the inferred `needs` map of a `result` extension. */
export type ResultNeedsMap = Record<string, Record<string, unknown>>;

/** Computed fields a `result` extension `R` adds under the key `K`. */
type ResultFieldsOf<R, K> = K extends keyof R
  ? {
      [F in keyof R[K]]: R[K][F] extends { compute: (...args: never[]) => infer X } ? X : never;
    }
  : Record<never, never>;

/** The type map after a `result` extension `R` (`$allModels` fields first, then the model's). */
export type ExtendTypeMap<TM extends TypeMap, R> = [keyof R] extends [never]
  ? TM
  : {
      [M in keyof TM]: [
        keyof ResultFieldsOf<R, "$allModels"> | keyof ResultFieldsOf<R, DelegateKey<M & string>>,
      ] extends [never]
        ? TM[M]
        : Simplify<
            Omit<TM[M], "computed"> & {
              computed: Simplify<
                Overwrite<
                  Overwrite<ComputedFields<TM, M>, ResultFieldsOf<R, "$allModels">>,
                  ResultFieldsOf<R, DelegateKey<M & string>>
                >
              >;
            }
          >;
    };

// ---------------------------------------------------------------------------
// Custom model methods (`model`) and client members (`client`)
// ---------------------------------------------------------------------------

/** Custom model methods accumulated on an extended client, keyed by delegate name. */
export type ModelMethods = Record<string, object>;

/** `this` inside a custom model method: the model's extended delegate, plus `$name` / `$parent`. */
export type ModelExtensionContext<
  TM extends TypeMap,
  MM extends ModelMethods,
  K extends string,
> = ModelDelegate<TM, ModelOfKey<TM, K>> &
  (K extends keyof MM ? MM[K] : unknown) & {
    /** Model name (`"User"`). */
    readonly $name: ModelOfKey<TM, K>;
    /** The client the delegate belongs to (the transaction client inside `$transaction`). */
    readonly $parent: OrmTransactionClient<TM, MM>;
  };

/** Loosely typed delegate: `this` inside `$allModels` methods. */
export type AnyModelExtensionContext<TM extends TypeMap, MM extends ModelMethods> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [O in OrmOperation]: (args?: AnyArgs) => Promise<any>;
} & {
  readonly $name: ModelName<TM>;
  readonly $parent: OrmTransactionClient<TM, MM>;
};

/** Methods defined under `$allModels` (`{}` when none). */
type AllModelsMethods<M> = M extends { $allModels: infer A extends object } ? A : unknown;

/** Custom model methods after a `model` extension `M`. */
export type ExtendModelMethods<TM extends TypeMap, MM extends ModelMethods, M> = [keyof M] extends [
  never,
]
  ? MM
  : {
      [K in ModelKey<TM>]: Overwrite<
        Overwrite<K extends keyof MM ? MM[K] : Record<never, never>, AllModelsMethods<M>>,
        K extends keyof M ? M[K] : Record<never, never>
      >;
    };

/** `model` of `$extends`: methods per model, and for every model under `$allModels`. */
export type ModelExtension<TM extends TypeMap, MM extends ModelMethods, M> = {
  [K in keyof M]: K extends ModelKey<TM>
    ? M[K] & ThisType<ModelExtensionContext<TM, ExtendModelMethods<TM, MM, M>, K>>
    : K extends "$allModels"
      ? M[K] & ThisType<AnyModelExtensionContext<TM, ExtendModelMethods<TM, MM, M>>>
      : never;
};

/** Argument of `db.$extends(…)`. `N`, `R`, `M` and `C` are inferred from it. */
export type ExtensionArgs<
  TM extends TypeMap,
  MM extends ModelMethods,
  CM extends object,
  N,
  R,
  M,
  C,
> = {
  /** Name of the extension, used in validation errors raised by `$extends`. */
  name?: string;
  /** Hooks around model operations (can change arguments and results). */
  query?: QueryExtension<TM>;
  /** Computed fields, added to results (and selectable). */
  result?: ResultExtension<TM, N> & R;
  /** Custom model methods (`db.user.findByEmail(…)`); `this` is the extended delegate. */
  model?: ModelExtension<ExtendTypeMap<TM, R>, MM, M> & M;
  /** Custom client members (`db.$health()`); `this` is the extended client. */
  client?: C &
    ThisType<
      OrmClient<
        ExtendTypeMap<TM, R>,
        ExtendModelMethods<ExtendTypeMap<TM, R>, MM, M>,
        Overwrite<CM, C>
      >
    >;
};

/** The client `$extends` returns. */
export type ExtendedClient<
  TM extends TypeMap,
  MM extends ModelMethods,
  CM extends object,
  R,
  M,
  C,
> = OrmClient<
  ExtendTypeMap<TM, R>,
  ExtendModelMethods<ExtendTypeMap<TM, R>, MM, M>,
  Simplify<Overwrite<CM, C>>
>;
