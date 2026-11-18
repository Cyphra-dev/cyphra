/**
 * Type-level API of the Cyphra ORM client.
 *
 * `cyphra generate` emits a {@link TypeMap} describing every node model; all argument and result
 * types below are computed from it, so the client is fully typed without per-model generated code.
 *
 * @packageDocumentation
 */

/** Type-level description of one relation field on a node model. */
export type RelationTypeDef = {
  readonly target: string;
  readonly many: boolean;
  readonly optional: boolean;
  /** Edge properties (from a `relationship { … }` model), or `null` when the edge is untyped. */
  readonly edge: Record<string, unknown> | null;
};

/** Type-level description of one node model. */
export type ModelTypeDef = {
  /** Scalar properties as returned by queries (optional fields are `T | null`, lists are `T[]`). */
  readonly scalars: Record<string, unknown>;
  /** Scalar keys that must be provided on `create` (non-optional, no default, not a list). */
  readonly createRequired: string;
  /** `@id` / `@unique` keys usable in `findUnique`, `connect`, … */
  readonly unique: string;
  readonly relations: Record<string, RelationTypeDef>;
};

export type TypeMap = Record<string, ModelTypeDef>;

type Scalars<TM extends TypeMap, M extends keyof TM> = TM[M]["scalars"];
type Relations<TM extends TypeMap, M extends keyof TM> = TM[M]["relations"];
type Rel<TM extends TypeMap, M extends keyof TM, R extends keyof Relations<TM, M>> = Relations<
  TM,
  M
>[R];
type Target<TM extends TypeMap, M extends keyof TM, R extends keyof Relations<TM, M>> = Rel<
  TM,
  M,
  R
>["target"] &
  keyof TM;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

type Comparable = number | Date;

/** Filter on one scalar field. A bare value means `equals`; `null` means "property absent". */
export type ScalarFilter<T> = [NonNullable<T>] extends [readonly (infer E)[]]
  ? {
      /** List contains this element. */
      has?: E;
      /** List contains every element. */
      hasEvery?: readonly E[];
      /** List contains at least one element. */
      hasSome?: readonly E[];
      isEmpty?: boolean;
      equals?: readonly E[];
    }
  : | T
    | ({
        equals?: T;
        not?: T | ScalarFilter<T>;
        in?: readonly NonNullable<T>[];
        notIn?: readonly NonNullable<T>[];
      } & (NonNullable<T> extends Comparable
        ? {
            lt?: NonNullable<T>;
            lte?: NonNullable<T>;
            gt?: NonNullable<T>;
            gte?: NonNullable<T>;
          }
        : unknown) &
        (NonNullable<T> extends string
          ? {
              contains?: string;
              startsWith?: string;
              endsWith?: string;
            }
          : unknown));

type RelationFilter<TM extends TypeMap, D extends RelationTypeDef> = D["many"] extends true
  ? {
      /** At least one related node matches. */
      some?: WhereInput<TM, D["target"] & keyof TM>;
      /** No related node matches. */
      none?: WhereInput<TM, D["target"] & keyof TM>;
      /** Every related node matches (vacuously true when there are none). */
      every?: WhereInput<TM, D["target"] & keyof TM>;
    }
  : null | {
      /** The related node exists and matches (`null`: no related node). */
      is?: WhereInput<TM, D["target"] & keyof TM> | null;
      /** No related node matching this (`null`: a related node exists). */
      isNot?: WhereInput<TM, D["target"] & keyof TM> | null;
    };

export type WhereInput<TM extends TypeMap, M extends keyof TM> = {
  [K in keyof Scalars<TM, M>]?: ScalarFilter<Scalars<TM, M>[K]>;
} & {
  [R in keyof Relations<TM, M>]?: RelationFilter<TM, Rel<TM, M, R>>;
} & {
  AND?: WhereInput<TM, M> | readonly WhereInput<TM, M>[];
  OR?: readonly WhereInput<TM, M>[];
  NOT?: WhereInput<TM, M> | readonly WhereInput<TM, M>[];
};

type RequireAtLeastOne<T> = {
  [K in keyof T]-?: Required<Pick<T, K>> & Partial<Omit<T, K>>;
}[keyof T];

/** Identifies a single node: at least one `@id`/`@unique` field, plus optional extra filters. */
export type WhereUniqueInput<TM extends TypeMap, M extends keyof TM> = RequireAtLeastOne<{
  [K in TM[M]["unique"] & keyof Scalars<TM, M>]: NonNullable<Scalars<TM, M>[K]>;
}> &
  WhereInput<TM, M>;

export type SortOrder = "asc" | "desc";

export type OrderByInput<TM extends TypeMap, M extends keyof TM> =
  | { [K in keyof Scalars<TM, M>]?: SortOrder }
  | readonly { [K in keyof Scalars<TM, M>]?: SortOrder }[];

// ---------------------------------------------------------------------------
// Select / include and result payloads
// ---------------------------------------------------------------------------

/** Options for loading a relation inside `select` / `include`. */
export type RelationLoadArgs<TM extends TypeMap, T extends keyof TM> = {
  where?: WhereInput<TM, T>;
  orderBy?: OrderByInput<TM, T>;
  skip?: number;
  take?: number;
  select?: SelectInput<TM, T>;
  include?: IncludeInput<TM, T>;
};

export type SelectInput<TM extends TypeMap, M extends keyof TM> = {
  [K in keyof Scalars<TM, M>]?: boolean;
} & {
  [R in keyof Relations<TM, M>]?: boolean | RelationLoadArgs<TM, Target<TM, M, R>>;
};

export type IncludeInput<TM extends TypeMap, M extends keyof TM> = {
  [R in keyof Relations<TM, M>]?: boolean | RelationLoadArgs<TM, Target<TM, M, R>>;
};

type EdgePart<D extends RelationTypeDef> =
  D["edge"] extends Record<string, unknown> ? { $edge: D["edge"] } : unknown;

type RelationPayload<TM extends TypeMap, D extends RelationTypeDef, A> = D["many"] extends true
  ? Simplify<Payload<TM, D["target"] & keyof TM, A> & EdgePart<D>>[]
  : D["optional"] extends true
    ? Simplify<Payload<TM, D["target"] & keyof TM, A> & EdgePart<D>> | null
    : Simplify<Payload<TM, D["target"] & keyof TM, A> & EdgePart<D>>;

type TrueKeys<T> = { [K in keyof T]: T[K] extends false | undefined ? never : K }[keyof T];

type SelectPayload<TM extends TypeMap, M extends keyof TM, S> = {
  [K in TrueKeys<S> & keyof Scalars<TM, M>]: Scalars<TM, M>[K];
} & {
  [R in TrueKeys<S> & keyof Relations<TM, M>]: RelationPayload<
    TM,
    Rel<TM, M, R>,
    S[R & keyof S] extends object ? S[R & keyof S] : object
  >;
};

type IncludePayload<TM extends TypeMap, M extends keyof TM, I> = Scalars<TM, M> & {
  [R in TrueKeys<I> & keyof Relations<TM, M>]: RelationPayload<
    TM,
    Rel<TM, M, R>,
    I[R & keyof I] extends object ? I[R & keyof I] : object
  >;
};

/** Result type of a query on model `M` with args `A` (honours `select` / `include`). */
export type Payload<TM extends TypeMap, M extends keyof TM, A> = Simplify<
  IsObject<ArgOf<A, "select">> extends true
    ? SelectPayload<TM, M, ArgOf<A, "select">>
    : IsObject<ArgOf<A, "include">> extends true
      ? IncludePayload<TM, M, ArgOf<A, "include">>
      : Scalars<TM, M>
>;

type IsObject<X> = [X] extends [never] ? false : [X] extends [object] ? true : false;
type ArgOf<A, K extends string> = A extends { [P in K]?: infer V } ? Exclude<V, undefined> : never;

// ---------------------------------------------------------------------------
// Write inputs
// ---------------------------------------------------------------------------

type EdgeInput<D extends RelationTypeDef> =
  D["edge"] extends Record<string, unknown> ? { $edge?: Partial<D["edge"]> } : unknown;

type OneOrMany<D extends RelationTypeDef, T> = D["many"] extends true ? T | readonly T[] : T;

type ScalarCreate<TM extends TypeMap, M extends keyof TM> = {
  [K in TM[M]["createRequired"] & keyof Scalars<TM, M>]: Scalars<TM, M>[K];
} & {
  [K in Exclude<keyof Scalars<TM, M>, TM[M]["createRequired"]>]?: Scalars<TM, M>[K];
};

type RelationCreate<TM extends TypeMap, D extends RelationTypeDef> = {
  /** Create related node(s) and link them. */
  create?: OneOrMany<D, CreateInput<TM, D["target"] & keyof TM> & EdgeInput<D>>;
  /** Link existing node(s); throws if a target does not exist. */
  connect?: OneOrMany<D, WhereUniqueInput<TM, D["target"] & keyof TM> & EdgeInput<D>>;
};

export type CreateInput<TM extends TypeMap, M extends keyof TM> = ScalarCreate<TM, M> & {
  [R in keyof Relations<TM, M>]?: RelationCreate<TM, Rel<TM, M, R>>;
};

type NumberUpdate = { increment?: number; decrement?: number; multiply?: number };

type ScalarUpdate<TM extends TypeMap, M extends keyof TM> = {
  [K in keyof Scalars<TM, M>]?: Scalars<TM, M>[K] extends number | null
    ? Scalars<TM, M>[K] | NumberUpdate
    : Scalars<TM, M>[K];
};

type RelationUpdate<TM extends TypeMap, D extends RelationTypeDef> = RelationCreate<TM, D> &
  (D["many"] extends true
    ? {
        /** Remove the edge(s) to these nodes (the nodes are kept). */
        disconnect?: OneOrMany<D, WhereUniqueInput<TM, D["target"] & keyof TM>>;
        /** Replace all edges of this relation with edges to these nodes. */
        set?: readonly (WhereUniqueInput<TM, D["target"] & keyof TM> & EdgeInput<D>)[];
      }
    : {
        /** Remove the edge (the related node is kept). */
        disconnect?: boolean;
      });

export type UpdateInput<TM extends TypeMap, M extends keyof TM> = ScalarUpdate<TM, M> & {
  [R in keyof Relations<TM, M>]?: RelationUpdate<TM, Rel<TM, M, R>>;
};

// ---------------------------------------------------------------------------
// Operation args
// ---------------------------------------------------------------------------

/**
 * `select` and `include` are the only arguments that change the result type, so they are the only
 * ones captured as type parameters. Everything else is typed directly, which keeps TypeScript's
 * excess-property checks working (an unknown field in `data` or `where` is a compile error).
 */
type Projection<S, I> = { select?: S; include?: I };

export type FindManyArgs<TM extends TypeMap, M extends keyof TM> = {
  where?: WhereInput<TM, M>;
  orderBy?: OrderByInput<TM, M>;
  skip?: number;
  take?: number;
};

export type FindUniqueArgs<TM extends TypeMap, M extends keyof TM> = {
  where: WhereUniqueInput<TM, M>;
};

export type CreateArgs<TM extends TypeMap, M extends keyof TM> = {
  data: CreateInput<TM, M>;
};

export type CreateManyArgs<TM extends TypeMap, M extends keyof TM> = {
  data: readonly ScalarCreate<TM, M>[];
};

export type UpdateArgs<TM extends TypeMap, M extends keyof TM> = {
  where: WhereUniqueInput<TM, M>;
  data: UpdateInput<TM, M>;
};

export type UpdateManyArgs<TM extends TypeMap, M extends keyof TM> = {
  where?: WhereInput<TM, M>;
  data: ScalarUpdate<TM, M>;
};

export type UpsertArgs<TM extends TypeMap, M extends keyof TM> = {
  where: WhereUniqueInput<TM, M>;
  create: CreateInput<TM, M>;
  update: UpdateInput<TM, M>;
};

export type DeleteArgs<TM extends TypeMap, M extends keyof TM> = {
  where: WhereUniqueInput<TM, M>;
};

export type CountArgs<TM extends TypeMap, M extends keyof TM> = { where?: WhereInput<TM, M> };

export type BatchResult = { count: number };

type Sel<TM extends TypeMap, M extends keyof TM> = SelectInput<TM, M> | undefined;
type Inc<TM extends TypeMap, M extends keyof TM> = IncludeInput<TM, M> | undefined;
type Out<TM extends TypeMap, M extends keyof TM, S, I> = Payload<TM, M, { select: S; include: I }>;

/** Operations available on `db.<model>`. */
export type ModelDelegate<TM extends TypeMap, M extends keyof TM> = {
  findMany<S extends Sel<TM, M> = undefined, I extends Inc<TM, M> = undefined>(
    args?: FindManyArgs<TM, M> & Projection<S, I>,
  ): Promise<Out<TM, M, S, I>[]>;
  findFirst<S extends Sel<TM, M> = undefined, I extends Inc<TM, M> = undefined>(
    args?: FindManyArgs<TM, M> & Projection<S, I>,
  ): Promise<Out<TM, M, S, I> | null>;
  /** `null` when no node matches. */
  findUnique<S extends Sel<TM, M> = undefined, I extends Inc<TM, M> = undefined>(
    args: FindUniqueArgs<TM, M> & Projection<S, I>,
  ): Promise<Out<TM, M, S, I> | null>;
  /** Throws {@link import("./errors.js").NotFoundError} when no node matches. */
  findUniqueOrThrow<S extends Sel<TM, M> = undefined, I extends Inc<TM, M> = undefined>(
    args: FindUniqueArgs<TM, M> & Projection<S, I>,
  ): Promise<Out<TM, M, S, I>>;
  count(args?: CountArgs<TM, M>): Promise<number>;
  create<S extends Sel<TM, M> = undefined, I extends Inc<TM, M> = undefined>(
    args: CreateArgs<TM, M> & Projection<S, I>,
  ): Promise<Out<TM, M, S, I>>;
  /** Create many nodes in one statement (scalars only, no nested writes). */
  createMany(args: CreateManyArgs<TM, M>): Promise<BatchResult>;
  update<S extends Sel<TM, M> = undefined, I extends Inc<TM, M> = undefined>(
    args: UpdateArgs<TM, M> & Projection<S, I>,
  ): Promise<Out<TM, M, S, I>>;
  updateMany(args: UpdateManyArgs<TM, M>): Promise<BatchResult>;
  upsert<S extends Sel<TM, M> = undefined, I extends Inc<TM, M> = undefined>(
    args: UpsertArgs<TM, M> & Projection<S, I>,
  ): Promise<Out<TM, M, S, I>>;
  /** Detach-deletes the node and returns it as it was. */
  delete<S extends Sel<TM, M> = undefined, I extends Inc<TM, M> = undefined>(
    args: DeleteArgs<TM, M> & Projection<S, I>,
  ): Promise<Out<TM, M, S, I>>;
  deleteMany(args?: CountArgs<TM, M>): Promise<BatchResult>;
};

/** Lower-cases the first character: `BlogPost` → `blogPost`. */
export type DelegateKey<M extends string> = Uncapitalize<M>;

export type ModelDelegates<TM extends TypeMap> = {
  [M in keyof TM & string as DelegateKey<M>]: ModelDelegate<TM, M>;
};
