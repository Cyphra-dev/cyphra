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
  /** `Vector(N)` scalar keys (absent when the model has none). */
  readonly vectors?: string;
  /** `Vector(N)` keys with a `@vectorIndex`: the fields `findSimilar` can search. */
  readonly vectorIndexes?: string;
  /** Names of the model's `@@fulltext` indexes: what `search` can query (absent when none). */
  readonly fulltextIndexes?: string;
  /**
   * `@@unique([...])` keys of the model, each mapped to its fields (`{ a_b: "a" | "b" }`):
   * usable in `findUnique`, `connect`, … as `where: { a_b: { a, b } }` (absent when none).
   */
  readonly compoundUniques?: Record<string, string>;
  /**
   * `true` for an `interface`: queries return its {@link ModelTypeDef.implementations} as a union
   * discriminated by `__typename`, and it has no `create` / `createMany` / `upsert`.
   */
  readonly abstract?: true;
  /** Names of the models implementing this interface (only on an interface). */
  readonly implementations?: string;
  /**
   * Computed fields added by `$extends({ result })`, each mapped to its type (absent when none).
   * Never emitted by `cyphra generate`: the extended client's type map carries them.
   */
  readonly computed?: Record<string, unknown>;
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

/** Computed fields of model `M` (from `$extends({ result })`; `{}` when none). */
export type ComputedFields<TM extends TypeMap, M extends keyof TM> = TM[M] extends {
  computed: infer C extends Record<string, unknown>;
}
  ? C
  : Record<never, never>;

/** `A` with the keys of `B` replaced by those of `B` (a computed field can shadow a scalar). */
type Overwrite<A, B> = [keyof B] extends [never] ? A : Omit<A, keyof B> & B;

/** What a query on `M` returns without `select`: its scalars and computed fields. */
type NodeFields<TM extends TypeMap, M extends keyof TM> = Overwrite<
  Scalars<TM, M>,
  ComputedFields<TM, M>
>;

/** `true` when model `M` is an `interface`. */
type IsAbstract<TM extends TypeMap, M extends keyof TM> = TM[M] extends { abstract: true }
  ? true
  : false;

/** Models implementing the interface `M` (`never` for a node). */
export type Implementations<TM extends TypeMap, M extends keyof TM> = TM[M] extends {
  implementations: infer I extends string;
}
  ? I & keyof TM
  : never;

/** `Vector(N)` scalar keys of model `M`. */
export type VectorKeys<TM extends TypeMap, M extends keyof TM> = TM[M] extends {
  vectors: infer V extends string;
}
  ? V
  : never;

/** `Vector(N)` keys of model `M` with a `@vectorIndex` (what `findSimilar` searches). */
export type VectorIndexKeys<TM extends TypeMap, M extends keyof TM> = TM[M] extends {
  vectorIndexes: infer V extends string;
}
  ? V
  : never;

/** Names of the `@@fulltext` indexes of model `M` (what `search` queries). */
export type FulltextIndexNames<TM extends TypeMap, M extends keyof TM> = TM[M] extends {
  fulltextIndexes: infer V extends string;
}
  ? V
  : never;

/** Any JSON value: the TypeScript type of a `Json` field. */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * A `Point` field: a WGS-84 geographic point, in degrees (`longitude` -180 to 180, `latitude` -90 to
 * 90), with an optional `height` in meters (a 3D point). Stored as a Neo4j `POINT` (`srid` 4326, or
 * 4979 with a height).
 */
export type Point = { longitude: number; latitude: number; height?: number };

/**
 * A `CartesianPoint` field: a point in a Cartesian plane (`x`, `y`) or space (`z`), in your own
 * units. Stored as a Neo4j `POINT` (`srid` 7203, or 9157 with `z`).
 */
export type CartesianPoint = { x: number; y: number; z?: number };

/**
 * A `LocalDateTime` field: a date and wall-clock time without a time zone, as ISO 8601 text
 * (`"2024-05-01T10:30:00"`, fraction up to nanoseconds: `"2024-05-01T10:30:00.123456789"`).
 * Returned in the form of `Temporal.PlainDateTime#toString()`.
 */
export type LocalDateTime = `${number}-${number}-${number}T${number}:${number}${string}`;

/**
 * A `LocalTime` field: a wall-clock time without a time zone, as ISO 8601 text (`"10:30"`,
 * `"10:30:00.5"`). Returned with seconds (`"10:30:00"`), like `Temporal.PlainTime#toString()`.
 */
export type LocalTime = `${number}:${number}${string}`;

/**
 * A `Time` field: a time of day with a UTC offset, as ISO 8601 text (`"10:30:00+02:00"`,
 * `"10:30:00Z"`). The offset is required and kept as written.
 */
export type Time = `${number}:${number}${string}`;

/**
 * A `Duration` field: an ISO 8601 duration (`"P1Y2M"`, `"PT1H30M"`, `"P3DT4H"`, `"-PT5M"`),
 * returned in the form of `Temporal.Duration#toString()`. Neo4j keeps months, days and seconds
 * apart (`"P1D"` is not `"PT24H"`), so durations only compare for equality.
 */
export type Duration = `P${string}` | `-P${string}`;

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** `true` when `A` and `B` are the same type (both ways assignable). */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** `true` for a `Duration` field. */
type IsDuration<T> = Same<NonNullable<T>, Duration>;

/** `true` for a `LocalDateTime`, `LocalTime` or `Time` field (ordered ISO 8601 text). */
type IsTemporalText<T> =
  Same<NonNullable<T>, LocalDateTime> extends true ? true : Same<NonNullable<T>, LocalTime>;

/** `true` for a `Point` or `CartesianPoint` field. */
type IsPoint<T> =
  Same<NonNullable<T>, Point> extends true ? true : Same<NonNullable<T>, CartesianPoint>;

/**
 * `LocalDateTime`, `LocalTime` and `Time` fields: equality, membership and ranges, compared as
 * temporal values by Neo4j (not as text).
 */
export type TemporalFilter<T> =
  | T
  | {
      equals?: T;
      not?: T | TemporalFilter<T>;
      in?: readonly NonNullable<T>[];
      notIn?: readonly NonNullable<T>[];
      lt?: NonNullable<T>;
      lte?: NonNullable<T>;
      gt?: NonNullable<T>;
      gte?: NonNullable<T>;
    };

/** `Duration` fields have no total order: equality and membership only. */
export type DurationFilter<T> =
  | T
  | {
      equals?: T;
      not?: T | DurationFilter<T>;
      in?: readonly NonNullable<T>[];
      notIn?: readonly NonNullable<T>[];
    };

/**
 * Distance from the point `from` (`point.distance`): meters for a `Point` (WGS-84, along the
 * Earth's surface), the field's units for a `CartesianPoint`.
 */
export type DistanceFilter<P> = {
  from: P;
  lt?: number;
  lte?: number;
  gt?: number;
  gte?: number;
};

/**
 * Point fields: equality (a bare point), `distance` from a point, and `withinBBox` (inside the box
 * from `lowerLeft` to `upperRight`, edges included; `point.withinBBox`).
 */
export type PointFilter<T> =
  | T
  | {
      equals?: T;
      not?: T;
      distance?: DistanceFilter<NonNullable<T>>;
      withinBBox?: { lowerLeft: NonNullable<T>; upperRight: NonNullable<T> };
    };

/** Types with `lt` / `lte` / `gt` / `gte` (strings compare lexicographically, by code point). */
type Comparable = number | bigint | string | Date;

/**
 * `true` for a union of string literals (an enum field), `false` for `string` and other types.
 */
type IsEnum<T> = [T] extends [string]
  ? string extends T
    ? false
    : [T] extends [never]
      ? false
      : true
  : false;

/** `true` for `JsonValue` (a `Json` field): every JSON value is assignable to it. */
type IsJson<T> = [JsonValue] extends [T] ? true : false;

/**
 * Json fields compare their whole stored JSON text: `null`, `{ equals }`, `{ not }` (no bare value,
 * no deep queries).
 */
export type JsonFilter = null | { equals?: JsonValue; not?: JsonValue };

/** Enum fields: equality and membership, typed to the enum's values. */
export type EnumFilter<T> =
  | T
  | {
      equals?: T;
      not?: T | EnumFilter<T>;
      in?: readonly NonNullable<T>[];
      notIn?: readonly NonNullable<T>[];
    };

/** Filter on one scalar field. A bare value means `equals`; `null` means "property absent". */
export type ScalarFilter<T> =
  IsJson<T> extends true
    ? JsonFilter
    : IsDuration<T> extends true
      ? DurationFilter<T>
      : IsTemporalText<T> extends true
        ? TemporalFilter<T>
        : IsPoint<T> extends true
          ? PointFilter<T>
          : IsEnum<NonNullable<T>> extends true
            ? EnumFilter<T>
            : BaseScalarFilter<T>;

type BaseScalarFilter<T> = [NonNullable<T>] extends [readonly (infer E)[]]
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
              /**
               * `"insensitive"` compares lower-cased values (`toLower()`) for `equals`, `not`,
               * `in`, `notIn`, `contains`, `startsWith` and `endsWith`. Range filters
               * (`lt`, `gte`, …) stay case-sensitive. Default: `"default"` (case-sensitive).
               */
              mode?: QueryMode;
            }
          : unknown));

/** Case sensitivity of string filters (same values as Prisma's `QueryMode`). */
export type QueryMode = "default" | "insensitive";

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

/** Vector fields only filter on presence (search them with `findSimilar`). */
export type VectorFilter = null | { equals?: null; not?: null };

export type WhereInput<TM extends TypeMap, M extends keyof TM> = {
  [K in keyof Scalars<TM, M>]?: K extends VectorKeys<TM, M>
    ? VectorFilter
    : ScalarFilter<Scalars<TM, M>[K]>;
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

/** `@@unique` keys of model `M`, each mapped to its fields (`{}` when the model has none). */
type CompoundUniques<TM extends TypeMap, M extends keyof TM> = TM[M] extends {
  compoundUniques: infer C extends Record<string, string>;
}
  ? C
  : Record<never, never>;

/** The value of a `@@unique` key in a unique `where`: every field of the key, non-null. */
export type CompoundUniqueInput<TM extends TypeMap, M extends keyof TM, F extends string> = {
  [K in F & keyof Scalars<TM, M>]: NonNullable<Scalars<TM, M>[K]>;
};

/**
 * Identifies a single node: at least one `@id`/`@unique` field or `@@unique` key
 * (`{ a_b: { a, b } }`), plus optional extra filters.
 */
export type WhereUniqueInput<TM extends TypeMap, M extends keyof TM> = RequireAtLeastOne<
  {
    [K in TM[M]["unique"] & keyof Scalars<TM, M>]: NonNullable<Scalars<TM, M>[K]>;
  } & {
    [C in keyof CompoundUniques<TM, M> & string]: CompoundUniqueInput<
      TM,
      M,
      CompoundUniques<TM, M>[C] & string
    >;
  }
> &
  WhereInput<TM, M>;

export type SortOrder = "asc" | "desc";

/** Keys of the to-many relations of model `M` (the ones `_count` can count). */
export type ToManyRelations<TM extends TypeMap, M extends keyof TM> = {
  [R in keyof Relations<TM, M> & string]: Rel<TM, M, R>["many"] extends true ? R : never;
}[keyof Relations<TM, M> & string];

/** Scalar keys of `Json`, `Duration` and point fields (they cannot be sorted by value). */
type UnsortableKeys<TM extends TypeMap, M extends keyof TM> = {
  [K in keyof Scalars<TM, M>]: IsJson<Scalars<TM, M>[K]> extends true
    ? K
    : IsDuration<Scalars<TM, M>[K]> extends true
      ? K
      : IsPoint<Scalars<TM, M>[K]> extends true
        ? K
        : never;
}[keyof Scalars<TM, M>];

/** Scalar keys of `Point` / `CartesianPoint` fields (sorted by distance from a point). */
type PointKeys<TM extends TypeMap, M extends keyof TM> = {
  [K in keyof Scalars<TM, M>]: IsPoint<Scalars<TM, M>[K]> extends true ? K : never;
}[keyof Scalars<TM, M>];

/** Sort a point field by its distance from `distanceFrom` (nearest first with `"asc"`, the default). */
export type DistanceOrder<P> = { distanceFrom: P; sort?: SortOrder };

/**
 * One `orderBy` entry: scalars, a to-many relation by its count (`{ posts: { _count: "desc" } }`),
 * or a to-one relation by a scalar of the related node (`{ author: { name: "asc" } }`).
 */
type OrderByItem<TM extends TypeMap, M extends keyof TM> = {
  [K in Exclude<keyof Scalars<TM, M>, VectorKeys<TM, M> | UnsortableKeys<TM, M>>]?: SortOrder;
} & {
  [K in PointKeys<TM, M>]?: DistanceOrder<NonNullable<Scalars<TM, M>[K]>>;
} & {
  [R in ToManyRelations<TM, M>]?: { _count?: SortOrder };
} & {
  [R in ToOneRelations<TM, M>]?: {
    [
      K in Exclude<
        keyof Scalars<TM, Target<TM, M, R>>,
        VectorKeys<TM, Target<TM, M, R>> | UnsortableKeys<TM, Target<TM, M, R>>
      >
    ]?: SortOrder;
  };
};

export type OrderByInput<TM extends TypeMap, M extends keyof TM> =
  OrderByItem<TM, M> | readonly OrderByItem<TM, M>[];

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

/**
 * `_count` in `select` / `include`: `true` counts every to-many relation;
 * `{ select: { posts: true, comments: { where } } }` counts the listed ones (optionally filtered).
 */
export type RelationCountInput<TM extends TypeMap, M extends keyof TM> =
  | boolean
  | {
      // To-one relations map to `never` so that counting one is a type error.
      select: {
        [R in keyof Relations<TM, M>]?: R extends ToManyRelations<TM, M>
          ? boolean | { where?: WhereInput<TM, Target<TM, M, R>> }
          : never;
      };
    };

export type SelectInput<TM extends TypeMap, M extends keyof TM> = {
  [K in keyof Scalars<TM, M> | keyof ComputedFields<TM, M>]?: boolean;
} & {
  [R in keyof Relations<TM, M>]?: boolean | RelationLoadArgs<TM, Target<TM, M, R>>;
} & {
  /** Number of related nodes per to-many relation. */
  _count?: RelationCountInput<TM, M>;
};

export type IncludeInput<TM extends TypeMap, M extends keyof TM> = {
  [R in keyof Relations<TM, M>]?: boolean | RelationLoadArgs<TM, Target<TM, M, R>>;
} & {
  /** Number of related nodes per to-many relation. */
  _count?: RelationCountInput<TM, M>;
};

type EdgePart<D extends RelationTypeDef> =
  D["edge"] extends Record<string, unknown> ? { $edge: D["edge"] } : unknown;

type RelationPayload<TM extends TypeMap, D extends RelationTypeDef, A> = D["many"] extends true
  ? Simplify<Payload<TM, D["target"] & keyof TM, A> & EdgePart<D>>[]
  : D["optional"] extends true
    ? Simplify<Payload<TM, D["target"] & keyof TM, A> & EdgePart<D>> | null
    : Simplify<Payload<TM, D["target"] & keyof TM, A> & EdgePart<D>>;

type TrueKeys<T> = { [K in keyof T]: T[K] extends false | undefined ? never : K }[keyof T];

/** `{ posts: number, … }` for a `_count` selection `C`. */
type RelationCountPayload<TM extends TypeMap, M extends keyof TM, C> = C extends true
  ? { [R in ToManyRelations<TM, M>]: number }
  : C extends { select: infer X }
    ? { [R in TrueKeys<X> & ToManyRelations<TM, M>]: number }
    : never;

type CountPart<TM extends TypeMap, M extends keyof TM, A> =
  "_count" extends TrueKeys<A>
    ? { _count: Simplify<RelationCountPayload<TM, M, A["_count" & keyof A]>> }
    : unknown;

type SelectPayload<TM extends TypeMap, M extends keyof TM, S> = {
  [K in Exclude<TrueKeys<S> & keyof Scalars<TM, M>, keyof ComputedFields<TM, M>>]: Scalars<
    TM,
    M
  >[K];
} & {
  [K in TrueKeys<S> & keyof ComputedFields<TM, M>]: ComputedFields<TM, M>[K];
} & {
  [R in TrueKeys<S> & keyof Relations<TM, M>]: RelationPayload<
    TM,
    Rel<TM, M, R>,
    S[R & keyof S] extends object ? S[R & keyof S] : object
  >;
} & CountPart<TM, M, S>;

type IncludePayload<TM extends TypeMap, M extends keyof TM, I> = NodeFields<TM, M> &
  IncludedRelations<TM, M, I>;

type IncludedRelations<TM extends TypeMap, M extends keyof TM, I> = {
  [R in TrueKeys<I> & keyof Relations<TM, M>]: RelationPayload<
    TM,
    Rel<TM, M, R>,
    I[R & keyof I] extends object ? I[R & keyof I] : object
  >;
} & CountPart<TM, M, I>;

/**
 * Result of a query on the interface `M`: a union over its implementations, discriminated by
 * `__typename`. Without `select`, each member has its implementation's scalar fields, the
 * computed fields of the interface and of the implementation (and the interface relations
 * `include` loads); with `select`, the selected interface fields.
 */
type InterfacePayload<TM extends TypeMap, M extends keyof TM, A> = {
  [T in Implementations<TM, M>]: Simplify<
    { __typename: T } & (IsObject<ArgOf<A, "select">> extends true
      ? SelectPayload<TM, M, ArgOf<A, "select">>
      : Overwrite<Overwrite<Scalars<TM, T>, ComputedFields<TM, M>>, ComputedFields<TM, T>> &
          (IsObject<ArgOf<A, "include">> extends true
            ? IncludedRelations<TM, M, ArgOf<A, "include">>
            : unknown))
  >;
}[Implementations<TM, M>];

/** Result type of a query on model `M` with args `A` (honours `select` / `include`). */
export type Payload<TM extends TypeMap, M extends keyof TM, A> =
  IsAbstract<TM, M> extends true
    ? InterfacePayload<TM, M, A>
    : Simplify<
        IsObject<ArgOf<A, "select">> extends true
          ? SelectPayload<TM, M, ArgOf<A, "select">>
          : IsObject<ArgOf<A, "include">> extends true
            ? IncludePayload<TM, M, ArgOf<A, "include">>
            : NodeFields<TM, M>
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

type RelationCreate<TM extends TypeMap, D extends RelationTypeDef> =
  IsAbstract<TM, D["target"] & keyof TM> extends true
    ? Omit<RelationCreateAny<TM, D>, "create">
    : RelationCreateAny<TM, D>;

type RelationCreateAny<TM extends TypeMap, D extends RelationTypeDef> = {
  /** Create related node(s) and link them. */
  create?: OneOrMany<D, CreateInput<TM, D["target"] & keyof TM> & EdgeInput<D>>;
  /** Link existing node(s); throws if a target does not exist. */
  connect?: OneOrMany<D, WhereUniqueInput<TM, D["target"] & keyof TM> & EdgeInput<D>>;
};

export type CreateInput<TM extends TypeMap, M extends keyof TM> = ScalarCreate<TM, M> & {
  [R in keyof Relations<TM, M>]?: RelationCreate<TM, Rel<TM, M, R>>;
};

type NumberUpdate = { increment?: number; decrement?: number; multiply?: number };
type BigIntUpdate = { increment?: bigint; decrement?: bigint; multiply?: bigint };

type ScalarUpdate<TM extends TypeMap, M extends keyof TM> = {
  [K in keyof Scalars<TM, M>]?: Scalars<TM, M>[K] extends number | null
    ? Scalars<TM, M>[K] | NumberUpdate
    : Scalars<TM, M>[K] extends bigint | null
      ? Scalars<TM, M>[K] | BigIntUpdate
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

// ---------------------------------------------------------------------------
// aggregate / groupBy
// ---------------------------------------------------------------------------

type ScalarKeys<TM extends TypeMap, M extends keyof TM> = keyof Scalars<TM, M> & string;

/**
 * Scalar keys whose (non-null) type is `number` or `bigint` (`Int`, `Float`, `BigInt`): valid for
 * `_sum` / `_avg`.
 */
export type NumericKeys<TM extends TypeMap, M extends keyof TM> = {
  [K in ScalarKeys<TM, M>]: NonNullable<Scalars<TM, M>[K]> extends number | bigint ? K : never;
}[ScalarKeys<TM, M>];

/**
 * Scalar keys of `Int`, `Float`, `BigInt`, `String`, enum, `DateTime`, `Date`, `LocalDateTime`,
 * `LocalTime` and `Time` fields: valid for `_min` / `_max`.
 */
export type MinMaxKeys<TM extends TypeMap, M extends keyof TM> = {
  [K in ScalarKeys<TM, M>]: IsJson<Scalars<TM, M>[K]> extends true
    ? never
    : IsDuration<Scalars<TM, M>[K]> extends true
      ? never
      : NonNullable<Scalars<TM, M>[K]> extends number | bigint | string | Date
        ? K
        : never;
}[ScalarKeys<TM, M>];

/** Rejects keys outside `Allowed` (TypeScript does not check excess keys of inferred generics). */
type OnlyKeys<T, Allowed extends PropertyKey> = {
  [K in keyof T]: K extends Allowed ? T[K] : never;
};

/** `_count: { _all: true, email: true }`: `_all` counts nodes, a field counts non-null values. */
export type CountAggregateInput<TM extends TypeMap, M extends keyof TM> = {
  [K in ScalarKeys<TM, M> | "_all"]?: boolean;
};

export type AggregateFieldsInput<K extends PropertyKey> = { [P in K]?: boolean };

type CountSel<TM extends TypeMap, M extends keyof TM> =
  true | CountAggregateInput<TM, M> | undefined;
type FieldSel<K extends PropertyKey> = AggregateFieldsInput<K> | undefined;

/**
 * The aggregate selections, each captured as its own type parameter (like `select` / `include`)
 * so the result type follows them exactly while the other arguments keep excess-property checks.
 */
type AggregateProjection<TM extends TypeMap, M extends keyof TM, C, Su, Av, Mi, Ma> = {
  /** `true`: number of nodes. An object: `_all` (nodes) and/or fields (non-null values). */
  _count?: C extends object ? C & OnlyKeys<C, ScalarKeys<TM, M> | "_all"> : C;
  /** Sum of non-null values (`Int` / `Float` / `BigInt`); `null` when there are none. */
  _sum?: Su & OnlyKeys<Su, NumericKeys<TM, M>>;
  /** Mean of non-null values (`Int` / `Float` / `BigInt`, as a `number`); `null` when there are none. */
  _avg?: Av & OnlyKeys<Av, NumericKeys<TM, M>>;
  /** Smallest non-null value (numbers, strings, enums and ordered temporal fields). */
  _min?: Mi & OnlyKeys<Mi, MinMaxKeys<TM, M>>;
  /** Largest non-null value (numbers, strings, enums and ordered temporal fields). */
  _max?: Ma & OnlyKeys<Ma, MinMaxKeys<TM, M>>;
};

type CountOut<C> = C extends true ? number : { [K in TrueKeys<C>]: number };
type AggOut<Sel, V> = { [K in TrueKeys<Sel>]: V };
/** `_sum` of a `BigInt` field is a `bigint`; of an `Int` / `Float` field, a `number`. */
type SumOut<TM extends TypeMap, M extends keyof TM, Sel> = {
  [K in TrueKeys<Sel>]:
    | (K extends keyof Scalars<TM, M>
        ? NonNullable<Scalars<TM, M>[K]> extends bigint
          ? bigint
          : number
        : number)
    | null;
};
type ValueOut<TM extends TypeMap, M extends keyof TM, Sel> = {
  [K in TrueKeys<Sel> & keyof Scalars<TM, M>]: NonNullable<Scalars<TM, M>[K]> | null;
};

/** Result of the aggregate part (`_count`, `_sum`, …) of `aggregate` / `groupBy`. */
export type AggregateResult<TM extends TypeMap, M extends keyof TM, C, Su, Av, Mi, Ma> = Simplify<
  ([C] extends [undefined] ? unknown : { _count: CountOut<Exclude<C, undefined>> }) &
    ([Su] extends [undefined] ? unknown : { _sum: SumOut<TM, M, Su> }) &
    ([Av] extends [undefined] ? unknown : { _avg: AggOut<Av, number | null> }) &
    ([Mi] extends [undefined] ? unknown : { _min: ValueOut<TM, M, Mi> }) &
    ([Ma] extends [undefined] ? unknown : { _max: ValueOut<TM, M, Ma> })
>;

export type AggregateArgs<TM extends TypeMap, M extends keyof TM> = {
  where?: WhereInput<TM, M>;
  /** With `skip` / `take`: aggregate over this window of matching nodes only. */
  orderBy?: OrderByInput<TM, M>;
  skip?: number;
  take?: number;
};

type ToOneRelations<TM extends TypeMap, M extends keyof TM> = {
  [R in keyof Relations<TM, M> & string]: Rel<TM, M, R>["many"] extends true ? never : R;
}[keyof Relations<TM, M> & string];

/**
 * A field `groupBy` can group on: a scalar of the model, or `"relation.field"` for a scalar of a
 * to-one related node (e.g. `"author.name"`).
 */
export type GroupByField<TM extends TypeMap, M extends keyof TM> =
  | ScalarKeys<TM, M>
  | {
      [R in ToOneRelations<TM, M>]: `${R}.${keyof Scalars<TM, Target<TM, M, R>> & string}`;
    }[ToOneRelations<TM, M>];

type ByScalar<B> = B extends `${string}.${string}` ? never : B;
type ByRelation<B> = B extends `${infer R}.${string}` ? R : never;
type ByRelField<B, R extends string> = B extends `${R}.${infer F}` ? F : never;

/** The `by` part of one `groupBy` row: `{ status, author: { name } }`. */
export type GroupByKeys<TM extends TypeMap, M extends keyof TM, B> = {
  [K in ByScalar<B> & keyof Scalars<TM, M>]: Scalars<TM, M>[K];
} & {
  [R in ByRelation<B> & keyof Relations<TM, M>]: {
    [F in ByRelField<B, R & string> & keyof Scalars<TM, Target<TM, M, R>>]:
      Scalars<TM, Target<TM, M, R>>[F] | null;
  };
};

type FilterObject<T> = Exclude<ScalarFilter<T>, T>;

/** Filters on one aggregate of field `K`, for `having`. */
type HavingAggregates<TM extends TypeMap, M extends keyof TM, K> = {
  _count?: ScalarFilter<number>;
} & (K extends NumericKeys<TM, M>
  ? {
      _sum?: ScalarFilter<
        | (NonNullable<Scalars<TM, M>[K & keyof Scalars<TM, M>]> extends bigint ? bigint : number)
        | null
      >;
      _avg?: ScalarFilter<number | null>;
    }
  : unknown) &
  (K extends MinMaxKeys<TM, M>
    ? {
        _min?: ScalarFilter<NonNullable<Scalars<TM, M>[K & keyof Scalars<TM, M>]> | null>;
        _max?: ScalarFilter<NonNullable<Scalars<TM, M>[K & keyof Scalars<TM, M>]> | null>;
      }
    : unknown);

/**
 * `having` on a `groupBy`: aggregates of any scalar (`{ views: { _avg: { gt: 10 } } }`), and plain
 * filters on the fields listed in `by` (`{ status: "draft" }`, `{ author: { name: { not: null } } }`).
 */
export type HavingInput<TM extends TypeMap, M extends keyof TM, B> = {
  [K in ScalarKeys<TM, M>]?: K extends B
    ? Scalars<TM, M>[K] | (FilterObject<Scalars<TM, M>[K]> & HavingAggregates<TM, M, K>)
    : HavingAggregates<TM, M, K>;
} & {
  [R in ByRelation<B> & keyof Relations<TM, M>]?: {
    [F in ByRelField<B, R & string> & keyof Scalars<TM, Target<TM, M, R>>]?: ScalarFilter<
      Scalars<TM, Target<TM, M, R>>[F]
    >;
  };
} & {
  AND?: HavingInput<TM, M, B> | readonly HavingInput<TM, M, B>[];
  OR?: readonly HavingInput<TM, M, B>[];
  NOT?: HavingInput<TM, M, B> | readonly HavingInput<TM, M, B>[];
};

type GroupByOrderItem<TM extends TypeMap, M extends keyof TM, B> = {
  [K in ByScalar<B> & ScalarKeys<TM, M>]?: SortOrder;
} & {
  [R in ByRelation<B> & keyof Relations<TM, M>]?: {
    [F in ByRelField<B, R & string>]?: SortOrder;
  };
} & {
  _count?: { [K in ScalarKeys<TM, M> | "_all"]?: SortOrder };
  _sum?: { [K in NumericKeys<TM, M>]?: SortOrder };
  _avg?: { [K in NumericKeys<TM, M>]?: SortOrder };
  _min?: { [K in MinMaxKeys<TM, M>]?: SortOrder };
  _max?: { [K in MinMaxKeys<TM, M>]?: SortOrder };
};

/** `orderBy` on a `groupBy`: fields listed in `by`, or aggregates (`{ _count: { id: "desc" } }`). */
export type GroupByOrderByInput<TM extends TypeMap, M extends keyof TM, B> =
  GroupByOrderItem<TM, M, B> | readonly GroupByOrderItem<TM, M, B>[];

export type GroupByArgs<TM extends TypeMap, M extends keyof TM, B> = {
  /** Fields to group on: `"status"`, `["status", "author.name"]`. */
  by: B | readonly B[];
  where?: WhereInput<TM, M>;
  having?: HavingInput<TM, M, NoInfer<B>>;
  orderBy?: GroupByOrderByInput<TM, M, NoInfer<B>>;
  skip?: number;
  take?: number;
};

/** One row of a `groupBy` result. */
export type GroupByRow<TM extends TypeMap, M extends keyof TM, B, C, Su, Av, Mi, Ma> = Simplify<
  GroupByKeys<TM, M, B> & AggregateResult<TM, M, C, Su, Av, Mi, Ma>
>;

// ---------------------------------------------------------------------------
// Paths and traversals
// ---------------------------------------------------------------------------

/** Edge properties of a relation: its `relationship { … }` model, or `{}` when the edge is untyped. */
type EdgeProps<D extends RelationTypeDef> = D extends unknown
  ? D["edge"] extends Record<string, unknown>
    ? D["edge"]
    : Record<string, never>
  : never;

/** One relationship of a {@link Path}: `edges[i]` joins `nodes[i]` and `nodes[i + 1]`. */
export type PathEdge<P = Record<string, unknown>> = {
  /** Neo4j relationship type, e.g. `"FOLLOWS"`. */
  type: string;
  /** `"out"`: the edge points from `nodes[i]` to `nodes[i + 1]`; `"in"`: the other way round. */
  direction: "out" | "in";
  /** Edge properties, typed from the `relationship { … }` model (`{}` for an untyped edge). */
  properties: P;
};

/**
 * A path through the graph: `nodes[0] -edges[0]- nodes[1] -edges[1]- …`. `edges.length` is the
 * number of hops and `nodes.length` is always `edges.length + 1`. Nodes carry their scalar fields.
 */
export type Path<N = Record<string, unknown>, E = PathEdge> = {
  nodes: N[];
  edges: E[];
};

/** A {@link Path} of `M` nodes joined by edges of the relations `R` of `M`. */
export type ModelPath<
  TM extends TypeMap,
  M extends keyof TM,
  R extends keyof Relations<TM, M>,
> = Path<Simplify<Scalars<TM, M>>, PathEdge<EdgeProps<Rel<TM, M, R>>>>;

/** Relations of `M` that lead back to `M` (e.g. `User.following`): the ones a traversal repeats. */
export type SelfRelations<TM extends TypeMap, M extends keyof TM> = {
  [R in keyof Relations<TM, M> & string]: [Rel<TM, M, R>["target"]] extends [M] ? R : never;
}[keyof Relations<TM, M> & string];

/** Filter on edge properties: scalar filters, `AND`, `OR`, `NOT`. */
export type EdgeWhereInput<E> = {
  [K in keyof E]?: ScalarFilter<E[K]>;
} & {
  AND?: EdgeWhereInput<E> | readonly EdgeWhereInput<E>[];
  OR?: readonly EdgeWhereInput<E>[];
  NOT?: EdgeWhereInput<E> | readonly EdgeWhereInput<E>[];
};

type RawEdge<D extends RelationTypeDef> = D extends unknown ? D["edge"] : never;

/** `edgeWhere` is only available when every relation in `via` has a `relationship { … }` model. */
type EdgeWhereFor<TM extends TypeMap, M extends keyof TM, R extends keyof Relations<TM, M>> =
  null extends RawEdge<Rel<TM, M, R>> ? never : EdgeWhereInput<RawEdge<Rel<TM, M, R>>>;

/**
 * Arrow direction of each hop, from the node you step from. Default: the direction declared by
 * each relation's `@relationship(direction: …)`.
 */
export type TraversalDirection = "out" | "in" | "both";

export type TraverseArgs<TM extends TypeMap, M extends keyof TM, R extends SelfRelations<TM, M>> = {
  /** Start node(s): any filter on `M` (`{ id }`, `{ email }`, …). */
  from: WhereInput<TM, M>;
  /** Relation(s) of `M` to follow; each must lead back to `M`. Several: any of them on each hop. */
  via: R | readonly R[];
  direction?: TraversalDirection;
  /**
   * Hops: `min` (default `1`, `0` includes the start node) to `max` (required, at most the client's
   * `maxTraversalDepth`, default 10).
   */
  depth: { min?: number; max: number };
  /** Filter on the reached nodes. */
  where?: WhereInput<TM, M>;
  /** Filter on the properties of every edge of the path. */
  edgeWhere?: EdgeWhereFor<TM, M, NoInfer<R>>;
  /** Return each reached node once (default `true`); `false`: one result per path. */
  distinct?: boolean;
  orderBy?: OrderByInput<TM, M>;
  skip?: number;
  take?: number;
};

/** One `traverse` result with `returnPaths: true`. */
export type TraversalResult<
  TM extends TypeMap,
  M extends keyof TM,
  R extends keyof Relations<TM, M>,
  N,
> = {
  /** The reached node (honours `select` / `include`). */
  node: N;
  /** How it was reached from a start node (the shortest such path when `distinct`). */
  path: ModelPath<TM, M, R>;
};

type TraverseOut<
  TM extends TypeMap,
  M extends keyof TM,
  R extends keyof Relations<TM, M>,
  N,
  P,
> = P extends true ? TraversalResult<TM, M, R, N> : N;

export type ShortestPathArgs<
  TM extends TypeMap,
  M extends keyof TM,
  R extends SelfRelations<TM, M>,
> = {
  /** Start node(s): any filter on `M`. */
  from: WhereInput<TM, M>;
  /** End node(s): any filter on `M`. A node matching both `from` and `to` gives a zero-hop path. */
  to: WhereInput<TM, M>;
  /** Relation(s) of `M` to follow; each must lead back to `M`. Several: any of them on each hop. */
  via: R | readonly R[];
  direction?: TraversalDirection;
  /** Longest path searched, in hops (required, at most the client's `maxTraversalDepth`). */
  maxDepth: number;
  /** Filter every intermediate node must match (not the start and end nodes). */
  where?: WhereInput<TM, M>;
  /** Filter on the properties of every edge of the path. */
  edgeWhere?: EdgeWhereFor<TM, M, NoInfer<R>>;
};

/** A shortest path: its nodes (honouring `select` / `include`) and its typed edges. */
export type ShortestPathResult<
  TM extends TypeMap,
  M extends keyof TM,
  R extends keyof Relations<TM, M>,
  N,
> = Path<N, PathEdge<EdgeProps<Rel<TM, M, R>>>>;

// ---------------------------------------------------------------------------
// Vector search
// ---------------------------------------------------------------------------

export type FindSimilarArgs<TM extends TypeMap, M extends keyof TM> = {
  /** The `Vector(N)` field to search; it must have a `@vectorIndex`. */
  field: VectorIndexKeys<TM, M>;
  /** Query embedding. Its length must equal the field's dimensions (checked at runtime). */
  vector: readonly number[];
  /** Number of results (best first). */
  k: number;
  /**
   * Filter on the results. The vector index has no filter argument, so `findSimilar` asks it for
   * `candidates` neighbours, filters them, and widens the search (×4) until `k` rows match or the
   * index is exhausted. Use `exact: true` when the filter is selective.
   */
  where?: WhereInput<TM, M>;
  /** Drop results scoring below this (scores are in `[0, 1]`, higher is more similar). */
  minScore?: number;
  /**
   * Neighbours asked from the index on the first attempt (at least `k`; default `k`, or
   * `max(10 × k, 100)` with a `where`). More candidates improve the recall of the approximate search.
   */
  candidates?: number;
  /** Upper bound on the candidates of a filtered search (default: no bound). */
  maxCandidates?: number;
  /**
   * Skip the index: score every node matching `where` with `vector.similarity.*` (exact results,
   * Neo4j 5.18+). Fast when `where` narrows the search to a few thousand nodes.
   */
  exact?: boolean;
};

/** A `findSimilar` result: the node (honouring `select` / `include`) and its similarity score. */
export type SimilarResult<N> = Simplify<N & { $score: number }>;

type VectorDelegate<TM extends TypeMap, M extends keyof TM> = [VectorIndexKeys<TM, M>] extends [
  never,
]
  ? unknown
  : {
      /**
       * The `k` nodes whose `field` is most similar to `vector`, best first, each with its
       * `$score`, through the field's vector index (`db.index.vector.queryNodes`, Neo4j 5.15+).
       */
      findSimilar<S extends Sel<TM, M> = undefined, I extends Inc<TM, M> = undefined>(
        args: FindSimilarArgs<TM, M> & Projection<S, I>,
      ): Promise<SimilarResult<Out<TM, M, S, I>>[]>;
    };

// ---------------------------------------------------------------------------
// Full-text search
// ---------------------------------------------------------------------------

/**
 * How `search` reads `query`: `"lucene"` passes it through as Lucene query syntax (`title:graph*`,
 * `"exact phrase"`, `a AND NOT b`, `fuzzy~`); `"terms"` escapes it and matches any of its words
 * (ranked by relevance); `"phrase"` escapes it and matches the words in that order.
 */
export type SearchMode = "lucene" | "terms" | "phrase";

export type SearchArgs<TM extends TypeMap, M extends keyof TM> = {
  /** The `@@fulltext` index to query (one of this model's index names). */
  index: FulltextIndexNames<TM, M>;
  /** The search text. A blank query matches nothing (`[]`). */
  query: string;
  /** How to read `query` (default `"lucene"`: Lucene query syntax, passed through). */
  mode?: SearchMode;
  /** Filter on the hits, applied in the same statement before `skip` / `take`. */
  where?: WhereInput<TM, M>;
  /** Drop hits scoring below this (Lucene scores: positive, unbounded, per-query). */
  minScore?: number;
  /** Hits to skip, after filtering and ranking. */
  skip?: number;
  /** Maximum number of hits (default: all of them). */
  take?: number;
};

/** A `search` result: the node (honouring `select` / `include`) and its relevance score. */
export type SearchResult<N> = Simplify<N & { $score: number }>;

type FulltextDelegate<TM extends TypeMap, M extends keyof TM> = [
  FulltextIndexNames<TM, M>,
] extends [never]
  ? unknown
  : {
      /**
       * Nodes matching a full-text `query` on one of the model's `@@fulltext` indexes, best first,
       * each with its `$score` (`db.index.fulltext.queryNodes`).
       */
      search<S extends Sel<TM, M> = undefined, I extends Inc<TM, M> = undefined>(
        args: SearchArgs<TM, M> & Projection<S, I>,
      ): Promise<SearchResult<Out<TM, M, S, I>>[]>;
    };

type Sel<TM extends TypeMap, M extends keyof TM> = SelectInput<TM, M> | undefined;
type Inc<TM extends TypeMap, M extends keyof TM> = IncludeInput<TM, M> | undefined;
type Out<TM extends TypeMap, M extends keyof TM, S, I> = Payload<TM, M, { select: S; include: I }>;

/** Operations available on `db.<model>`. */
export type ModelDelegate<TM extends TypeMap, M extends keyof TM> = (IsAbstract<TM, M> extends true
  ? Omit<BaseModelDelegate<TM, M>, CreateOperations>
  : BaseModelDelegate<TM, M>) &
  VectorDelegate<TM, M> &
  FulltextDelegate<TM, M>;

/** Operations an interface has not: create one of its implementations instead. */
type CreateOperations = "create" | "createMany" | "upsert";

type BaseModelDelegate<TM extends TypeMap, M extends keyof TM> = {
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
  /**
   * `_count`, `_sum`, `_avg`, `_min` and `_max` over the matching nodes, in one statement.
   * Nulls are ignored; on an empty match counts are `0` and the other aggregates `null`.
   */
  aggregate<
    C extends CountSel<TM, M> = undefined,
    Su extends FieldSel<NumericKeys<TM, M>> = undefined,
    Av extends FieldSel<NumericKeys<TM, M>> = undefined,
    Mi extends FieldSel<MinMaxKeys<TM, M>> = undefined,
    Ma extends FieldSel<MinMaxKeys<TM, M>> = undefined,
  >(
    args?: AggregateArgs<TM, M> & AggregateProjection<TM, M, C, Su, Av, Mi, Ma>,
  ): Promise<AggregateResult<TM, M, C, Su, Av, Mi, Ma>>;
  /**
   * Follow `via` from the `from` node(s) for `depth.min`..`depth.max` hops and return the reached
   * nodes, in one statement (a quantified path pattern, Neo4j 5.9+). `returnPaths: true` returns
   * `{ node, path }` with the typed nodes and edges of the path.
   */
  traverse<
    R extends SelfRelations<TM, M>,
    S extends Sel<TM, M> = undefined,
    I extends Inc<TM, M> = undefined,
    P extends boolean = false,
  >(
    args: TraverseArgs<TM, M, R> & Projection<S, I> & { returnPaths?: P },
  ): Promise<TraverseOut<TM, M, R, Out<TM, M, S, I>, P>[]>;
  /**
   * One shortest path from a `from` node to a `to` node along `via`, at most `maxDepth` hops, or
   * `null` (one statement, `SHORTEST 1`, Neo4j 5.21+). With several start or end nodes, the
   * shortest path over every pair.
   */
  shortestPath<
    R extends SelfRelations<TM, M>,
    S extends Sel<TM, M> = undefined,
    I extends Inc<TM, M> = undefined,
  >(
    args: ShortestPathArgs<TM, M, R> & Projection<S, I>,
  ): Promise<ShortestPathResult<TM, M, R, Out<TM, M, S, I>> | null>;
  /**
   * Every shortest path from a `from` node to a `to` node along `via` (all of the same, minimal
   * length), at most `maxDepth` hops, up to `take` paths (one statement, `ALL SHORTEST`).
   */
  allShortestPaths<
    R extends SelfRelations<TM, M>,
    S extends Sel<TM, M> = undefined,
    I extends Inc<TM, M> = undefined,
  >(
    args: ShortestPathArgs<TM, M, R> & Projection<S, I> & { take?: number },
  ): Promise<ShortestPathResult<TM, M, R, Out<TM, M, S, I>>[]>;
  /** Group matching nodes by `by` and aggregate each group, in one statement. */
  groupBy<
    B extends GroupByField<TM, M>,
    C extends CountSel<TM, M> = undefined,
    Su extends FieldSel<NumericKeys<TM, M>> = undefined,
    Av extends FieldSel<NumericKeys<TM, M>> = undefined,
    Mi extends FieldSel<MinMaxKeys<TM, M>> = undefined,
    Ma extends FieldSel<MinMaxKeys<TM, M>> = undefined,
  >(
    args: GroupByArgs<TM, M, B> & AggregateProjection<TM, M, C, Su, Av, Mi, Ma>,
  ): Promise<GroupByRow<TM, M, B, C, Su, Av, Mi, Ma>[]>;
};

/** Lower-cases the first character: `BlogPost` → `blogPost`. */
export type DelegateKey<M extends string> = Uncapitalize<M>;

export type ModelDelegates<TM extends TypeMap> = {
  [M in keyof TM & string as DelegateKey<M>]: ModelDelegate<TM, M>;
};
