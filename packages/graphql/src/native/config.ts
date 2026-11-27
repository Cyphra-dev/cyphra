/**
 * The configuration of the native GraphQL API (`defineGraphQL`): which operations and fields each
 * model exposes, root field names, limits. Typed from the generated client's `CyphraTypeMap`, so a
 * key naming an unknown model or field is a compile error; {@link checkConfig} checks the same
 * things at startup for JavaScript users and configs built dynamically.
 *
 * @packageDocumentation
 */

import type { CreateInput, ModelTypeDef, TypeMap, WhereInput } from "@cyphra/runtime";
import type { ResolvedNodeModel, SchemaModel } from "@cyphra/schema";
import {
  checkExtensions,
  type ComputedField,
  type CypherField,
  type ExtendConfig,
  type ResolvedExtensions,
} from "./extensions.js";

/** Read operations a model can expose as root fields (on by default). */
export const READ_OPERATIONS = [
  "findUnique",
  "findFirst",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "search",
] as const;

/** A read operation of the native API (`<model>FindMany`, …). */
export type ReadOperation = (typeof READ_OPERATIONS)[number];

/**
 * The expensive reads, off by default (the `traverse` group): raw vector search (`findSimilar`,
 * which takes a vector from the client), traversals and shortest paths.
 */
export const TRAVERSE_OPERATIONS = [
  "findSimilar",
  "traverse",
  "traversePaths",
  "shortestPath",
] as const;

/** An operation of the `traverse` group (`<model>FindSimilar`, …). */
export type TraverseOperation = (typeof TRAVERSE_OPERATIONS)[number];

/** Operations of the `create` group (`upsert` needs the `update` group too). */
export const CREATE_OPERATIONS = ["create", "createMany", "upsert"] as const;
/** Operations of the `update` group (`upsert` needs the `create` group too). */
export const UPDATE_OPERATIONS = ["update", "updateMany", "upsert"] as const;
/** Operations of the `delete` group. */
export const DELETE_OPERATIONS = ["delete", "deleteMany"] as const;

/** Write operations a model can expose as `Mutation` root fields, in printing order. */
export const WRITE_OPERATIONS = [
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
] as const;

export type CreateOperation = (typeof CREATE_OPERATIONS)[number];
export type UpdateOperation = (typeof UPDATE_OPERATIONS)[number];
export type DeleteOperation = (typeof DELETE_OPERATIONS)[number];
/** A write operation of the native API (`<model>Create`, …). */
export type WriteOperation = (typeof WRITE_OPERATIONS)[number];
/** Any root field operation. */
export type RootOperation = ReadOperation | TraverseOperation | WriteOperation;

/**
 * Operations of the `subscribe` group (`Subscription` root fields, off by default, experimental):
 * `changed` (`<model>Changed`: node created, updated, deleted) and `connected` / `disconnected`
 * (`<model><Relation>Connected` / `…Disconnected`, one pair per readable relation). Served on
 * Neo4j Change Data Capture (`native.CDCReader`).
 */
export const SUBSCRIBE_OPERATIONS = ["changed", "connected", "disconnected"] as const;

/** An operation of the `subscribe` group. */
export type SubscribeOperation = (typeof SUBSCRIBE_OPERATIONS)[number];

/** A root field operation or a subscription operation. */
export type AnyOperation = RootOperation | SubscribeOperation;

const GROUPS = {
  read: READ_OPERATIONS,
  traverse: TRAVERSE_OPERATIONS,
  create: CREATE_OPERATIONS,
  update: UPDATE_OPERATIONS,
  delete: DELETE_OPERATIONS,
  subscribe: SUBSCRIBE_OPERATIONS,
} as const;
type Group = keyof typeof GROUPS;

/** Whether `op` is a write (a `Mutation` root field). */
export function isWrite(op: RootOperation): op is WriteOperation {
  return (WRITE_OPERATIONS as readonly string[]).includes(op);
}

/**
 * Which operations of a model are root fields, per group: `true` (every operation of the group),
 * `false` or a list of operations. `upsert` is served when both `create` and `update` include it.
 * Default: reads on, the expensive reads (`traverse`), writes and subscriptions off.
 */
export type OperationToggles = {
  readonly read?: boolean | readonly ReadOperation[];
  /**
   * The expensive reads: `findSimilar` (raw vector search), `traverse`, `traversePaths`,
   * `shortestPath`. Off by default.
   */
  readonly traverse?: boolean | readonly TraverseOperation[];
  readonly create?: boolean | readonly CreateOperation[];
  readonly update?: boolean | readonly UpdateOperation[];
  readonly delete?: boolean | readonly DeleteOperation[];
  /**
   * `Subscription` root fields (experimental): `changed` (`<model>Changed`), `connected` and
   * `disconnected` (relationship events of each readable relation). Off by default; needs
   * `subscriptions` (a `native.CDCReader`) in `makeSchema`.
   */
  readonly subscribe?: boolean | readonly SubscribeOperation[];
};

/** A `where` on model `M`, typed as the client's (loose when the type map is not known). */
export type RuleWhere<TM extends TypeMap, M> = string extends keyof TM
  ? Readonly<Record<string, unknown>>
  : M extends keyof TM
    ? WhereInput<TM, M>
    : never;

/** The create `data` of one node of model `M`, as the client takes it. */
export type RuleCreateData<TM extends TypeMap, M> = string extends keyof TM
  ? Readonly<Record<string, unknown>>
  : M extends keyof TM
    ? CreateInput<TM, M>
    : never;

/** A predicate on the request's context. */
export type ContextPredicate<Ctx> = { bivarianceHack(ctx: Ctx): boolean }["bivarianceHack"];

/** What a rule is called with: the request's GraphQL context. */
export type RuleArgs<Ctx> = { readonly ctx: Ctx };

/**
 * A `where` rule: `true` (allowed), `false` (denied) or a `where` on the model (allowed for the
 * nodes it matches), compiled into the statement.
 */
export type WhereRule<TM extends TypeMap, M, Ctx> = {
  bivarianceHack(args: RuleArgs<Ctx>): boolean | RuleWhere<TM, M>;
}["bivarianceHack"];

/** A create rule: whether the node `data` describes may be created (checked before anything runs). */
export type CreateRule<TM extends TypeMap, M, Ctx> = {
  bivarianceHack(args: RuleArgs<Ctx> & { readonly data: RuleCreateData<TM, M> }): boolean;
}["bivarianceHack"];

/** A context-only predicate (evaluated once per request). */
export type ContextRule<Ctx> = {
  bivarianceHack(args: RuleArgs<Ctx>): boolean;
}["bivarianceHack"];

type RelationsOf<TM extends TypeMap, M extends keyof TM> = TM[M]["relations"];
type RelationRules<TM extends TypeMap, M extends keyof TM, Ctx> = {
  readonly [R in keyof RelationsOf<TM, M> & string]?: WhereRule<
    TM,
    RelationsOf<TM, M>[R]["target"],
    Ctx
  >;
};

/**
 * The rules of one model, compiled into every statement that matches its nodes (see the native
 * API docs, "Auth"):
 *
 * - `read`: every read of the model (root fields, relation loads and filters, `_count`, mutation
 *   results) and the targets of updates, deletes, connects and disconnects;
 * - `create`: each node created (root or nested), from its data, before anything runs;
 * - `update` / `delete`: the nodes updates / deletes match (others are `NOT_FOUND`);
 * - `connect` / `disconnect`: per relation, the targets a nested write may link / unlink;
 * - `after`: checked on the nodes created / updated once the statement's writes ran
 *   (`FORBIDDEN`, rolled back otherwise).
 */
export type ModelRules<TM extends TypeMap, M extends keyof TM, Ctx> = {
  readonly read?: WhereRule<TM, M, Ctx>;
  readonly create?: CreateRule<TM, M, Ctx>;
  readonly update?: WhereRule<TM, M, Ctx>;
  readonly delete?: WhereRule<TM, M, Ctx>;
  readonly connect?: RelationRules<TM, M, Ctx>;
  readonly disconnect?: RelationRules<TM, M, Ctx>;
  readonly after?: {
    readonly create?: WhereRule<TM, M, Ctx>;
    readonly update?: WhereRule<TM, M, Ctx>;
  };
};

/**
 * Who reads a field: `true` / `false`, a context-only predicate (`({ ctx }) => boolean`,
 * evaluated once per request: a denied field selected is `null` with a `FORBIDDEN` error, and
 * using it in `where` / `orderBy` fails the root field), or a row-dependent rule
 * (`{ where: ({ ctx }) => … }`: the field is `null` on the rows the `where` does not match, in
 * results, filters and ordering alike).
 */
export type FieldReadRule<TM extends TypeMap, M, Ctx> =
  boolean | ContextRule<Ctx> | { readonly where: WhereRule<TM, M, Ctx> };

/**
 * What the API does with one field. `false` hides it everywhere (types, filters, ordering,
 * writes). `read: false` hides it from types, filters and ordering, and from writes unless
 * `create` / `update` say otherwise (a write-only field); `read` may also be a rule (see
 * {@link FieldReadRule}: the field is then generated nullable); `filter: false` / `sort: false`
 * keep it readable but remove it from `where` / `orderBy`; `create: false` / `update: false`
 * remove it from the create / update inputs (for a relation: its nested writes). `deprecated`
 * marks the field `@deprecated(reason)` in the schema.
 */
export type FieldToggle<TM extends TypeMap = TypeMap, M = string, Ctx = unknown> =
  | false
  | {
      readonly read?: FieldReadRule<TM, M, Ctx>;
      readonly filter?: boolean;
      readonly sort?: boolean;
      readonly create?: boolean;
      readonly update?: boolean;
      readonly deprecated?: string;
    };

type FieldNames<M extends ModelTypeDef> = (keyof M["scalars"] | keyof M["relations"]) & string;

/** The configuration of one model. */
export type ModelConfig<
  TM extends TypeMap = TypeMap,
  M extends keyof TM & string = keyof TM & string,
  Ctx = unknown,
> = {
  readonly operations?: OperationToggles;
  readonly fields?: { readonly [F in FieldNames<TM[M]>]?: FieldToggle<TM, M, Ctx> };
  /** Row-level rules, compiled into every statement (see {@link ModelRules}). */
  readonly rules?: ModelRules<TM, M, Ctx>;
  /**
   * Operations that need an authenticated request (`isAuthenticated`), failing with
   * `UNAUTHENTICATED` otherwise: `true` (every operation) or per group, like `operations`. A whole
   * group (`read: true`, …) also applies wherever the model is reached for an anonymous request:
   * its nodes are not readable through relations, not creatable or updatable through nested
   * writes. A list of operations only guards those root fields.
   */
  readonly authenticated?: boolean | OperationToggles;
};

/**
 * Limits checked before a statement is built; exceeding one fails the root field with
 * `BAD_USER_INPUT` (`extensions.limit` names it).
 */
export type Limits = {
  /** Deepest relation nesting a selection may load (a root's relations are depth 1). */
  readonly maxDepth?: number;
  /** Largest `take` of a list (root or relation); also the `take` of a list that sets none. */
  readonly maxTake?: number;
  /** Most aliased fields in one root field's selection. */
  readonly maxAliases?: number;
  /**
   * Most rows a root field may load: each list multiplies the rows of its parent by its `take`
   * (`maxTake`, or 100, when it sets none); every to-one relation loads at most one.
   */
  readonly maxComplexity?: number;
  /**
   * Largest `depth.max` of a traversal and `maxDepth` of a shortest path (the client's
   * `maxTraversalDepth`, default 10, applies too: the lower wins).
   */
  readonly maxTraversalDepth?: number;
};

/** One hop of a named traversal: relation(s) of the model the previous hop reached. */
export type TraversalHop = {
  /** A relation of the model this hop steps from, or several leading to the same model. */
  readonly rel: string | readonly string[];
  /** Arrow direction (default: each relation's declared direction). */
  readonly direction?: "out" | "in" | "both";
  /** Repeat the hop `min` (default 1) to `max` times: only on a relation back to the same model. */
  readonly depth?: { readonly min?: number; readonly max: number };
};

/**
 * A named traversal field (`traversals.<Model>.<field>`): a field of the model's type returning
 * the nodes the hops reach from each node, compiled into the parent's statement (Neo4j).
 */
export type NamedTraversal = {
  /** The hops, in order: `[{ rel: "entities" }, { rel: "related", depth: { max: 2 } }, { rel: "chunks" }]`. */
  readonly via: readonly TraversalHop[];
  /** What clients may pass (default: none): `where`, `orderBy`, `skip`, `take` on the reached nodes. */
  readonly args?: readonly ("where" | "orderBy" | "skip" | "take")[];
  /** The field's description in the schema. */
  readonly description?: string;
};

/** A checked named traversal. */
export type ResolvedTraversal = {
  readonly via: readonly TraversalHop[];
  readonly args: ReadonlySet<"where" | "orderBy" | "skip" | "take">;
  /** The model the last hop reaches. */
  readonly end: string;
  readonly description?: string;
};

/**
 * The native API's configuration (see `defineGraphQL`). `TM` is the generated client's
 * `CyphraTypeMap`; `Ctx` the type of the GraphQL context (what rules will see).
 */
export type GraphQLConfig<TM extends TypeMap = TypeMap, Ctx = unknown> = {
  /**
   * Version of the generator: what the API prints for a given schema and config. A release that
   * would print something else ships it as a new version, opt-in. Only `1` today.
   */
  readonly generator?: 1;
  /** Per-model operations, fields, rules and `authenticated`. */
  readonly models?: { readonly [M in keyof TM & string]?: ModelConfig<TM, M, Ctx> };
  /**
   * Whether a request is authenticated (for `authenticated`). Default: the context has a `user`
   * or a `jwt` (what `native.jwtContext` sets).
   */
  readonly isAuthenticated?: ContextPredicate<Ctx>;
  /** Defaults for every model: reads on, writes off. */
  readonly defaults?: { readonly operations?: OperationToggles };
  /**
   * Root field names replacing `<model><Operation>` (`{ Person: { findMany: "people" } }`), and
   * `changed` for the `<model>Changed` subscription.
   */
  readonly naming?: {
    readonly [M in keyof TM & string]?: { readonly [O in RootOperation | "changed"]?: string };
  };
  readonly limits?: Limits;
  /**
   * Named traversal fields, per model: `{ Chunk: { context: { via: [{ rel: "entities" }, …] } } }`
   * adds `Chunk.context: [Chunk!]!`, the nodes the hops reach (see {@link NamedTraversal}).
   */
  readonly traversals?: {
    readonly [M in keyof TM & string]?: { readonly [field: string]: NamedTraversal };
  };
  /**
   * Computed fields of the client (`$extends({ result })`) to expose, per model, with their
   * GraphQL type: `{ User: { fullName: "String!" } }`. Selecting one loads its `needs`; it cannot
   * be filtered or sorted on.
   */
  readonly computed?: {
    readonly [M in keyof TM & string]?: { readonly [field: string]: ComputedField<Ctx> };
  };
  /**
   * Cypher-backed fields (the native `@cypher`), per model: a Cypher expression evaluated on each
   * node, compiled into the parent's statement, with typed arguments bound as parameters. Rules
   * do not apply inside the expression. See {@link CypherField}.
   */
  readonly cypherFields?: {
    readonly [M in keyof TM & string]?: { readonly [field: string]: CypherField<Ctx> };
  };
  /**
   * Custom SDL and resolvers merged into the generated schema: non-node result types, custom
   * root fields (`extend type Query` / `Mutation`), fields added to generated types. In resolvers,
   * `ctx.cyphra` is the request's client with the API's rules applied, and
   * `ctx.cyphra.selection(info)` the selection as the client's `select`.
   */
  readonly extend?: ExtendConfig<Ctx>;
  /**
   * Relay: a `Node` interface with global ids, implemented by every model with an `@id` field
   * (`String`, `Int` or `BigInt`), and `node(id: ID!)`. The model's own `id` field is then
   * returned as `rawId` (inputs keep `id`). Off by default.
   */
  readonly relay?: boolean;
  /**
   * Transactions of mutations: `"field"` (the default) runs each root field in its own
   * transaction; `"request"` runs every root field of one mutation operation in a single write
   * transaction, in order, so they commit together or not at all (a failing field rolls back the
   * whole operation, and every root field reports its error).
   */
  readonly mutationTransaction?: "field" | "request";
  /** Phantom: the context type of the API (never set). */
  readonly __context?: Ctx;
};

/**
 * Define the native API's configuration, typed against the generated client: a key naming an
 * unknown model, field or operation is a compile error. `makeSchema` checks it again at startup.
 *
 * @example
 * ```ts
 * import { defineGraphQL } from "@cyphra/graphql/native";
 * import type { CyphraTypeMap } from "./cyphra.gen.js";
 *
 * export const api = defineGraphQL<CyphraTypeMap>({
 *   models: {
 *     User: { fields: { passwordHash: false, email: { filter: false, sort: false } } },
 *     AuditLog: { operations: { read: ["findMany", "count"] } },
 *   },
 *   limits: { maxDepth: 4, maxTake: 100 },
 * });
 * ```
 *
 * @experimental
 */
export function defineGraphQL<TM extends TypeMap = TypeMap, Ctx = unknown>(
  config: GraphQLConfig<TM, Ctx>,
): GraphQLConfig<TM, Ctx> {
  return config;
}

/** Raised by `makeSchema` for a configuration or a schema the native API cannot serve. */
export class NativeSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeSchemaError";
  }
}

type AnyRecord = Record<string, unknown>;

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A field's effective toggles. */
export type FieldAccess = {
  readonly read: boolean;
  readonly filter: boolean;
  readonly sort: boolean;
  readonly create: boolean;
  readonly update: boolean;
  readonly deprecated?: string;
};

/** The subscription fields of one model (`subscribe` group), with their root field names. */
export type ResolvedSubscriptions = {
  /** `<model>Changed`, when `changed` is on. */
  readonly changed?: string;
  /** Relationship events, per readable relation (`connected` / `disconnected` when on). */
  readonly relations: readonly {
    readonly field: string;
    readonly connected?: string;
    readonly disconnected?: string;
  }[];
};

/** The checked configuration, with defaults applied. */
export type ResolvedConfig = {
  /** Root fields per model: operation → field name (absent: the operation is off). */
  readonly operations: ReadonlyMap<string, ReadonlyMap<RootOperation, string>>;
  /** `Subscription` root fields per model (only models with at least one). */
  readonly subscriptions: ReadonlyMap<string, ResolvedSubscriptions>;
  /** `field(model, name)`: the effective toggles of a field. */
  field(model: string, name: string): FieldAccess;
  readonly limits: Limits;
  /** `relay: true`: the `Node` interface and `node(id)`. */
  readonly relay: boolean;
  readonly mutationTransaction: "field" | "request";
  /** The rules of each model that has some, as configured. */
  readonly rules: ReadonlyMap<string, ConfiguredRules>;
  /** Named traversal fields per model (field name → traversal). */
  readonly traversals: ReadonlyMap<string, ReadonlyMap<string, ResolvedTraversal>>;
  /** Computed fields, Cypher-backed fields and `extend`. */
  readonly extensions: ResolvedExtensions;
  /** Read rules of fields (functions or `{ where }`), per `Model.field` where declared. */
  readonly fieldRules: ReadonlyMap<string, ConfiguredFieldRule>;
  /** Whether the field, or the interface field it implements, has a read rule (it is nullable). */
  fieldRuled(model: string, name: string): boolean;
  /** Whether the root operation (or subscription) `op` of `model` needs an authenticated request. */
  authenticated(model: string, op: AnyOperation): boolean;
  /** The operation groups of `model` `authenticated` covers as a whole (they apply everywhere). */
  authenticatedGroups(model: string): ReadonlySet<"read" | "create" | "update" | "delete">;
  /** Whether a request is authenticated (`config.isAuthenticated`, or a `user` / `jwt`). */
  isAuthenticated(ctx: unknown): boolean;
};

type AnyFn = (args: never) => unknown;

/** The rules of one model as configured (functions of the context). */
export type ConfiguredRules = {
  readonly read?: AnyFn;
  readonly create?: AnyFn;
  readonly update?: AnyFn;
  readonly delete?: AnyFn;
  readonly connect?: Readonly<Record<string, AnyFn | undefined>>;
  readonly disconnect?: Readonly<Record<string, AnyFn | undefined>>;
  readonly after?: { readonly create?: AnyFn; readonly update?: AnyFn };
};

/** A field's read rule as configured: context-only, or row-dependent (`where`). */
export type ConfiguredFieldRule =
  { readonly kind: "context"; readonly fn: AnyFn } | { readonly kind: "where"; readonly fn: AnyFn };

const RULE_KEYS = ["read", "create", "update", "delete", "connect", "disconnect", "after"] as const;

/** The default `isAuthenticated`: the context has a `user` or a `jwt`. */
function defaultIsAuthenticated(ctx: unknown): boolean {
  if (typeof ctx !== "object" || ctx === null) return false;
  const c = ctx as AnyRecord;
  return (c.user !== undefined && c.user !== null) || (c.jwt !== undefined && c.jwt !== null);
}

const LIMIT_KEYS = [
  "maxDepth",
  "maxTake",
  "maxAliases",
  "maxComplexity",
  "maxTraversalDepth",
] as const;
const FIELD_KEYS = ["read", "filter", "sort", "create", "update", "deprecated"] as const;
const TOP_KEYS = [
  "generator",
  "models",
  "defaults",
  "naming",
  "limits",
  "relay",
  "mutationTransaction",
  "isAuthenticated",
  "traversals",
  "computed",
  "cypherFields",
  "extend",
] as const;
const ROOT_OPERATIONS: readonly RootOperation[] = [
  ...READ_OPERATIONS,
  ...TRAVERSE_OPERATIONS,
  ...WRITE_OPERATIONS,
];
/** Keys of `config.naming.<Model>`: root operations, and `changed` (the subscription). */
const NAMING_KEYS: readonly string[] = [...ROOT_OPERATIONS, "changed"];
const HIDDEN: FieldAccess = {
  read: false,
  filter: false,
  sort: false,
  create: false,
  update: false,
};
const VISIBLE: FieldAccess = { read: true, filter: true, sort: true, create: true, update: true };

function checkKeys(where: string, obj: AnyRecord, allowed: readonly string[]): void {
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined && !allowed.includes(k)) {
      throw new NativeSchemaError(`${where}: unknown key "${k}" (expected ${allowed.join(", ")}).`);
    }
  }
}

/** The operations each group given in `toggles` turns on (groups not given are absent). */
function readOps(where: string, toggles: unknown): Partial<Record<Group, Set<AnyOperation>>> {
  if (toggles === undefined) return {};
  if (!isPlainObject(toggles)) throw new NativeSchemaError(`${where} must be an object.`);
  const groups = Object.keys(GROUPS) as Group[];
  checkKeys(where, toggles, groups);
  const out: Partial<Record<Group, Set<AnyOperation>>> = {};
  for (const g of groups) {
    const v = toggles[g];
    if (v === undefined) continue;
    const all: readonly AnyOperation[] = GROUPS[g];
    if (v === true) out[g] = new Set(all);
    else if (v === false) out[g] = new Set();
    else if (!Array.isArray(v)) {
      throw new NativeSchemaError(`${where}.${g} must be true, false or a list of operations.`);
    } else {
      for (const op of v) {
        if (!all.includes(op as AnyOperation)) {
          throw new NativeSchemaError(
            `${where}.${g}: unknown operation ${JSON.stringify(op)} (use ${all.join(", ")}).`,
          );
        }
      }
      out[g] = new Set(v as AnyOperation[]);
    }
  }
  return out;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** `postFindMany`: the default root field of `operation` on `model`. */
export function rootFieldName(model: string, operation: RootOperation): string {
  return `${model.charAt(0).toLowerCase()}${model.slice(1)}${capitalize(operation)}`;
}

/**
 * Check `config` against `schema` (unknown models, fields, operations, options) and apply the
 * defaults: reads on, writes off.
 *
 * @throws {NativeSchemaError} On the first problem found.
 */
export function checkConfig(schema: SchemaModel, config: GraphQLConfig = {}): ResolvedConfig {
  if (!isPlainObject(config)) throw new NativeSchemaError("config must be an object.");
  checkKeys("config", config, [...TOP_KEYS, "__context"]);
  if (config.relay !== undefined && typeof config.relay !== "boolean") {
    throw new NativeSchemaError("config.relay must be a boolean.");
  }
  if (
    config.mutationTransaction !== undefined &&
    config.mutationTransaction !== "field" &&
    config.mutationTransaction !== "request"
  ) {
    throw new NativeSchemaError('config.mutationTransaction must be "field" or "request".');
  }
  if (config.isAuthenticated !== undefined && typeof config.isAuthenticated !== "function") {
    throw new NativeSchemaError("config.isAuthenticated must be a function.");
  }
  if (config.generator !== undefined && config.generator !== 1) {
    throw new NativeSchemaError(
      `config.generator: unknown generator version ${JSON.stringify(config.generator)} (this release has 1).`,
    );
  }
  const byName = new Map(schema.nodes.map((n) => [n.name, n]));
  const known = (where: string, name: string) => {
    const node = byName.get(name);
    if (!node) {
      throw new NativeSchemaError(
        `${where}: unknown model "${name}" (models: ${[...byName.keys()].join(", ") || "none"}).`,
      );
    }
    return node;
  };

  if (config.defaults !== undefined) {
    if (!isPlainObject(config.defaults)) {
      throw new NativeSchemaError("config.defaults must be an object.");
    }
    checkKeys("config.defaults", config.defaults, ["operations"]);
  }
  const defaults = {
    read: new Set<AnyOperation>(READ_OPERATIONS),
    traverse: new Set<AnyOperation>(),
    create: new Set<AnyOperation>(),
    update: new Set<AnyOperation>(),
    delete: new Set<AnyOperation>(),
    subscribe: new Set<AnyOperation>(),
    ...readOps("config.defaults.operations", config.defaults?.operations),
  };

  const models = (config.models ?? {}) as AnyRecord;
  if (!isPlainObject(models)) throw new NativeSchemaError("config.models must be an object.");
  const fieldToggles = new Map<string, FieldAccess>();
  const opsByModel = new Map<string, Partial<Record<Group, Set<AnyOperation>>>>();
  const rulesByModel = new Map<string, ConfiguredRules>();
  const fieldRules = new Map<string, ConfiguredFieldRule>();
  const authByModel = new Map<string, Partial<Record<Group, Set<AnyOperation>>>>();
  for (const [name, mc] of Object.entries(models)) {
    if (mc === undefined) continue;
    const where = `config.models.${name}`;
    const node = known("config.models", name);
    if (!isPlainObject(mc)) throw new NativeSchemaError(`${where} must be an object.`);
    checkKeys(where, mc, ["operations", "fields", "rules", "authenticated"]);
    const ops = readOps(`${where}.operations`, mc.operations);
    opsByModel.set(name, ops);
    if (mc.rules !== undefined)
      rulesByModel.set(name, checkRules(`${where}.rules`, node, mc.rules));
    if (mc.authenticated === true || mc.authenticated === false) {
      const all = mc.authenticated;
      authByModel.set(
        name,
        Object.fromEntries(
          (Object.keys(GROUPS) as Group[]).map((g) => [g, new Set(all ? GROUPS[g] : [])]),
        ),
      );
    } else if (mc.authenticated !== undefined) {
      authByModel.set(name, readOps(`${where}.authenticated`, mc.authenticated));
    }
    // Interfaces are written through their implementations' create, unions through their members.
    const writes = (g: Group) => (ops[g]?.size ?? 0) > 0;
    if (node.union && (writes("create") || writes("update") || writes("delete"))) {
      throw new NativeSchemaError(
        `${where}.operations: ${name} is a union and has no write operations; write its members.`,
      );
    }
    if (node.abstract && writes("create")) {
      throw new NativeSchemaError(
        `${where}.operations.create: ${name} is an interface and cannot be created; turn create on for its implementations.`,
      );
    }
    if (node.abstract && writes("subscribe")) {
      throw new NativeSchemaError(
        `${where}.operations.subscribe: ${name} is ${node.union ? "a union" : "an interface"}; subscriptions are served on node models, turn subscribe on for its ${node.union ? "members" : "implementations"}.`,
      );
    }
    if (mc.fields === undefined) continue;
    if (!isPlainObject(mc.fields))
      throw new NativeSchemaError(`${where}.fields must be an object.`);
    const names = node.fields.map((f) => f.name);
    for (const [field, toggle] of Object.entries(mc.fields)) {
      if (toggle === undefined) continue;
      if (!names.includes(field)) {
        throw new NativeSchemaError(
          `${where}.fields: unknown field "${name}.${field}" (fields: ${names.join(", ") || "none"}).`,
        );
      }
      if (toggle === false) {
        fieldToggles.set(`${name}.${field}`, HIDDEN);
        continue;
      }
      if (!isPlainObject(toggle)) {
        throw new NativeSchemaError(`${where}.fields.${field} must be false or an object.`);
      }
      checkKeys(`${where}.fields.${field}`, toggle, FIELD_KEYS);
      const readRule = toggle.read;
      if (typeof readRule === "function") {
        fieldRules.set(`${name}.${field}`, { kind: "context", fn: readRule as AnyFn });
      } else if (isPlainObject(readRule)) {
        checkKeys(`${where}.fields.${field}.read`, readRule, ["where"]);
        if (typeof readRule.where !== "function") {
          throw new NativeSchemaError(`${where}.fields.${field}.read.where must be a function.`);
        }
        const f = node.fields.find((x) => x.name === field)!;
        if (f.kind !== "scalar") {
          throw new NativeSchemaError(
            `${where}.fields.${field}.read: row-dependent rules ({ where }) are for scalar fields; ${name}.${field} is a relation (use a context rule, or a read rule on its model).`,
          );
        }
        fieldRules.set(`${name}.${field}`, { kind: "where", fn: readRule.where as AnyFn });
      } else if (readRule !== undefined && typeof readRule !== "boolean") {
        throw new NativeSchemaError(
          `${where}.fields.${field}.read must be a boolean, a function or { where }.`,
        );
      }
      if (fieldRules.has(`${name}.${field}`) && field === node.idField) {
        throw new NativeSchemaError(
          `${where}.fields.${field}.read: the @id field cannot have a read rule (cursors and global ids use it); hide it with false, or use a read rule on ${name}.`,
        );
      }
      for (const k of ["filter", "sort", "create", "update"]) {
        if (toggle[k] !== undefined && typeof toggle[k] !== "boolean") {
          throw new NativeSchemaError(`${where}.fields.${field}.${k} must be a boolean.`);
        }
      }
      if (toggle.deprecated !== undefined && typeof toggle.deprecated !== "string") {
        throw new NativeSchemaError(`${where}.fields.${field}.deprecated must be a string.`);
      }
      const read = readRule !== false;
      fieldToggles.set(`${name}.${field}`, {
        read,
        filter: read && toggle.filter !== false,
        sort: read && toggle.sort !== false,
        create: (toggle.create as boolean | undefined) ?? read,
        update: (toggle.update as boolean | undefined) ?? read,
        ...(toggle.deprecated !== undefined ? { deprecated: toggle.deprecated } : {}),
      });
    }
  }

  const naming = (config.naming ?? {}) as AnyRecord;
  if (!isPlainObject(naming)) throw new NativeSchemaError("config.naming must be an object.");
  for (const [name, n] of Object.entries(naming)) {
    if (n === undefined) continue;
    known("config.naming", name);
    if (!isPlainObject(n)) throw new NativeSchemaError(`config.naming.${name} must be an object.`);
    checkKeys(`config.naming.${name}`, n, NAMING_KEYS);
    for (const [op, v] of Object.entries(n)) {
      if (v !== undefined && (typeof v !== "string" || !/^[_A-Za-z][_0-9A-Za-z]*$/.test(v))) {
        throw new NativeSchemaError(
          `config.naming.${name}.${op} must be a GraphQL name, got ${JSON.stringify(v)}.`,
        );
      }
      if (typeof v === "string" && v.startsWith("__")) {
        throw new NativeSchemaError(`config.naming.${name}.${op}: names cannot start with "__".`);
      }
    }
  }

  const limits = (config.limits ?? {}) as AnyRecord;
  if (!isPlainObject(limits)) throw new NativeSchemaError("config.limits must be an object.");
  checkKeys("config.limits", limits, LIMIT_KEYS);
  for (const k of LIMIT_KEYS) {
    const v = limits[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < 1)) {
      throw new NativeSchemaError(`config.limits.${k} must be a positive integer.`);
    }
  }

  // Inherited fields: a toggle on an interface applies to its implementations, and an
  // implementation cannot hide a field its interface exposes (GraphQL would reject the schema).
  const access = (model: string, name: string): FieldAccess => {
    const own = fieldToggles.get(`${model}.${name}`);
    const node = byName.get(model);
    const inherited = (node?.interfaces ?? [])
      .map((i) => (byName.get(i)?.fields.some((f) => f.name === name) ? i : undefined))
      .filter((i): i is string => i !== undefined)
      .map((i) => fieldToggles.get(`${i}.${name}`))
      .filter((t): t is FieldAccess => t !== undefined);
    let out: FieldAccess = own ?? VISIBLE;
    for (const t of inherited) {
      out = {
        read: out.read && t.read,
        filter: out.filter && t.filter,
        sort: out.sort && t.sort,
        create: out.create && t.create,
        update: out.update && t.update,
        ...((out.deprecated ?? t.deprecated)
          ? { deprecated: (out.deprecated ?? t.deprecated)! }
          : {}),
      };
    }
    return out;
  };
  for (const node of schema.nodes) {
    for (const i of node.interfaces ?? []) {
      const iface = byName.get(i);
      for (const f of iface?.fields ?? []) {
        const own = fieldToggles.get(`${node.name}.${f.name}`);
        if (own && !own.read && access(i, f.name).read) {
          throw new NativeSchemaError(
            `config.models.${node.name}.fields.${f.name}: cannot hide a field of the interface ${i} on one implementation; hide it on ${i}.`,
          );
        }
      }
    }
  }

  // A field rule makes the field nullable: an implementation cannot add one to a field of its
  // interface (GraphQL would reject the schema); put it on the interface.
  const ruledOn = (model: string, name: string): boolean => {
    if (fieldRules.has(`${model}.${name}`)) return true;
    const node = byName.get(model);
    return (node?.interfaces ?? []).some(
      (i) =>
        byName.get(i)?.fields.some((f) => f.name === name) === true &&
        fieldRules.has(`${i}.${name}`),
    );
  };
  for (const node of schema.nodes) {
    for (const i of node.interfaces ?? []) {
      for (const f of byName.get(i)?.fields ?? []) {
        if (fieldRules.has(`${node.name}.${f.name}`) && !ruledOn(i, f.name)) {
          throw new NativeSchemaError(
            `config.models.${node.name}.fields.${f.name}.read: a rule on a field of the interface ${i} goes on ${i} (it applies to every implementation).`,
          );
        }
      }
    }
  }

  const operations = new Map<string, Map<RootOperation, string>>();
  const subscriptions = new Map<string, ResolvedSubscriptions>();
  for (const node of schema.nodes) {
    const own = opsByModel.get(node.name) ?? {};
    const group = (g: Group) => own[g] ?? defaults[g];
    const on = (op: AnyOperation): boolean => {
      if (op === "upsert") return group("create").has(op) && group("update").has(op);
      for (const g of Object.keys(GROUPS) as Group[]) {
        if ((GROUPS[g] as readonly string[]).includes(op)) return group(g).has(op);
      }
      return false;
    };
    const hasUnique = node.uniqueFields.length > 0 || (node.compoundUniques?.length ?? 0) > 0;
    const names = new Map<RootOperation, string>();
    for (const op of ROOT_OPERATIONS) {
      if (!on(op)) continue;
      if (isWrite(op)) {
        // A union has no writes; an interface no creates (from the defaults: left out).
        if (node.union) continue;
        if (node.abstract && (op === "create" || op === "createMany" || op === "upsert")) continue;
      }
      // Operations on one node need a unique key (a union has none).
      const single = op === "findUnique" || op === "update" || op === "upsert" || op === "delete";
      if (single && (node.union || !hasUnique)) continue;
      if (!servable(node, op, byName)) continue;
      const override = (naming[node.name] as AnyRecord | undefined)?.[op];
      names.set(op, typeof override === "string" ? override : rootFieldName(node.name, op));
    }
    operations.set(node.name, names);
    const subs = subscriptionFields(node, on, byName, access, naming[node.name] as AnyRecord);
    if (subs) subscriptions.set(node.name, subs);
  }

  // A model is subject to its interfaces' `authenticated` too.
  const authGroups = (model: string): Partial<Record<Group, Set<AnyOperation>>>[] => [
    authByModel.get(model) ?? {},
    ...(byName.get(model)?.interfaces ?? []).map((i) => authByModel.get(i) ?? {}),
  ];
  const isAuthenticated =
    (config.isAuthenticated as ((ctx: unknown) => boolean) | undefined) ?? defaultIsAuthenticated;
  const traversals = checkTraversals(
    config.traversals,
    byName,
    access,
    (limits.maxTraversalDepth as number | undefined) ?? 10,
  );
  return {
    operations,
    subscriptions,
    field: access,
    limits: limits as Limits,
    relay: config.relay === true,
    mutationTransaction: config.mutationTransaction ?? "field",
    rules: rulesByModel,
    traversals,
    extensions: checkExtensions(
      schema,
      config as AnyRecord,
      (model, field) => traversals.get(model)?.has(field) === true,
    ),
    fieldRules,
    fieldRuled: ruledOn,
    authenticated: (model, op) =>
      authGroups(model).some((groups) =>
        (Object.keys(GROUPS) as Group[]).some((g) => groups[g]?.has(op) === true),
      ),
    authenticatedGroups: (model) => {
      const out = new Set<"read" | "create" | "update" | "delete">();
      for (const groups of authGroups(model)) {
        for (const g of ["read", "create", "update", "delete"] as const) {
          if (GROUPS[g].every((op) => groups[g]?.has(op))) out.add(g);
        }
      }
      return out;
    },
    isAuthenticated: (ctx) => isAuthenticated(ctx) === true,
  };
}

const TRAVERSAL_KEYS = ["via", "args", "description"] as const;
const TRAVERSAL_ARGS = ["where", "orderBy", "skip", "take"] as const;
const HOP_KEYS = ["rel", "direction", "depth"] as const;

/**
 * Check `config.traversals`: known models (not interfaces or unions), field names free on the
 * model, hops along readable relations of the model each hop reaches, `depth` only on a relation
 * back to the same model, the hops' `depth.max` adding up to at most `maxDepth`.
 */
function checkTraversals(
  traversals: unknown,
  byName: ReadonlyMap<string, ResolvedNodeModel>,
  access: (model: string, field: string) => FieldAccess,
  maxDepth: number,
): ReadonlyMap<string, ReadonlyMap<string, ResolvedTraversal>> {
  const out = new Map<string, Map<string, ResolvedTraversal>>();
  if (traversals === undefined) return out;
  if (!isPlainObject(traversals))
    throw new NativeSchemaError("config.traversals must be an object.");
  for (const [name, fields] of Object.entries(traversals)) {
    if (fields === undefined) continue;
    const where = `config.traversals.${name}`;
    const node = byName.get(name);
    if (!node) {
      throw new NativeSchemaError(
        `config.traversals: unknown model "${name}" (models: ${[...byName.keys()].join(", ") || "none"}).`,
      );
    }
    if (node.abstract) {
      throw new NativeSchemaError(
        `${where}: ${name} is an interface or a union; declare named traversals on its implementations.`,
      );
    }
    if (!isPlainObject(fields)) throw new NativeSchemaError(`${where} must be an object.`);
    const resolved = new Map<string, ResolvedTraversal>();
    for (const [field, t] of Object.entries(fields)) {
      if (t === undefined) continue;
      const at = `${where}.${field}`;
      if (!/^[A-Za-z][_0-9A-Za-z]*$/.test(field)) {
        throw new NativeSchemaError(
          `${at}: "${field}" is not a GraphQL field name (it cannot start with "_").`,
        );
      }
      if (node.fields.some((f) => f.name === field) || field === "id") {
        throw new NativeSchemaError(`${at}: ${name} already has a field "${field}".`);
      }
      if (!isPlainObject(t))
        throw new NativeSchemaError(`${at} must be an object ({ via, args? }).`);
      checkKeys(at, t, TRAVERSAL_KEYS);
      if (!Array.isArray(t.via) || t.via.length === 0) {
        throw new NativeSchemaError(
          `${at}.via must be a non-empty list of hops ({ rel, direction?, depth? }).`,
        );
      }
      let current = node;
      let total = 0;
      for (const [i, hop] of (t.via as unknown[]).entries()) {
        const h = `${at}.via[${i}]`;
        if (!isPlainObject(hop))
          throw new NativeSchemaError(`${h} must be an object ({ rel, direction?, depth? }).`);
        checkKeys(h, hop, HOP_KEYS);
        const rels = Array.isArray(hop.rel) ? hop.rel : [hop.rel];
        if (rels.length === 0 || rels.some((r) => typeof r !== "string")) {
          throw new NativeSchemaError(
            `${h}.rel must be a relation of ${current.name} or a list of them.`,
          );
        }
        const targets = new Set<string>();
        for (const r of rels as string[]) {
          const f = current.fields.find((x) => x.name === r);
          if (f?.kind !== "relation") {
            throw new NativeSchemaError(
              `${h}.rel: unknown relation "${current.name}.${r}" (relations: ${
                current.fields
                  .filter((x) => x.kind === "relation")
                  .map((x) => x.name)
                  .join(", ") || "none"
              }).`,
            );
          }
          if (!access(current.name, r).read) {
            throw new NativeSchemaError(
              `${h}.rel: ${current.name}.${r} is hidden by config.models.${current.name}.fields.`,
            );
          }
          targets.add(f.target);
        }
        if (targets.size !== 1) {
          throw new NativeSchemaError(`${h}.rel: the relations of one hop must lead to one model.`);
        }
        const next = byName.get([...targets][0]!)!;
        if (
          hop.direction !== undefined &&
          !["out", "in", "both"].includes(hop.direction as string)
        ) {
          throw new NativeSchemaError(`${h}.direction must be "out", "in" or "both".`);
        }
        let max = 1;
        if (hop.depth !== undefined) {
          const d = hop.depth as AnyRecord;
          if (next !== current) {
            throw new NativeSchemaError(
              `${h}.depth repeats a hop: only on a relation leading back to ${current.name}.`,
            );
          }
          const int = (v: unknown, min: number) =>
            typeof v === "number" && Number.isInteger(v) && v >= min;
          if (
            !isPlainObject(d) ||
            !int(d.max, 1) ||
            (d.min !== undefined && (!int(d.min, 0) || (d.min as number) > (d.max as number)))
          ) {
            throw new NativeSchemaError(
              `${h}.depth must be { min?: integer >= 0, max: integer >= min, >= 1 }.`,
            );
          }
          max = d.max as number;
        }
        total += max;
        current = next;
      }
      if (total > maxDepth) {
        throw new NativeSchemaError(
          `${at}: the hops reach up to ${total} relations deep; the limit is ${maxDepth} (limits.maxTraversalDepth, default 10).`,
        );
      }
      const args = t.args === undefined ? [] : t.args;
      if (
        !Array.isArray(args) ||
        args.some((a) => !(TRAVERSAL_ARGS as readonly unknown[]).includes(a))
      ) {
        throw new NativeSchemaError(`${at}.args must be a list of ${TRAVERSAL_ARGS.join(", ")}.`);
      }
      if (t.description !== undefined && typeof t.description !== "string") {
        throw new NativeSchemaError(`${at}.description must be a string.`);
      }
      resolved.set(field, {
        via: t.via as TraversalHop[],
        args: new Set(args as ("where" | "orderBy" | "skip" | "take")[]),
        end: current.name,
        ...(t.description !== undefined ? { description: t.description as string } : {}),
      });
    }
    out.set(name, resolved);
  }
  return out;
}

/**
 * The key a subscription event carries (`id: ID!`) and re-reads its nodes by: the model's `@id`
 * field, when it is a readable `String`, `Int` or `BigInt` (absent otherwise: no subscriptions).
 */
export function subscriptionKey(
  node: ResolvedNodeModel,
  access: (model: string, field: string) => FieldAccess,
): string | undefined {
  if (node.union) return undefined;
  const f = node.fields.find((x) => x.name === node.idField);
  if (f?.kind !== "scalar" || f.list || !["String", "Int", "BigInt"].includes(f.type)) {
    return undefined;
  }
  return access(node.name, f.name).read ? f.name : undefined;
}

/**
 * The `Subscription` fields of `node`: `<model>Changed` and, per readable relation to a model
 * with a key, `<model><Relation>Connected` / `…Disconnected`. Node models with a key only.
 */
function subscriptionFields(
  node: ResolvedNodeModel,
  on: (op: AnyOperation) => boolean,
  byName: ReadonlyMap<string, ResolvedNodeModel>,
  access: (model: string, field: string) => FieldAccess,
  naming: AnyRecord | undefined,
): ResolvedSubscriptions | undefined {
  if (node.abstract || !subscriptionKey(node, access)) return undefined;
  const base = `${node.name.charAt(0).toLowerCase()}${node.name.slice(1)}`;
  const changed = on("changed")
    ? typeof naming?.changed === "string"
      ? naming.changed
      : `${base}Changed`
    : undefined;
  const relations: { field: string; connected?: string; disconnected?: string }[] = [];
  if (on("connected") || on("disconnected")) {
    for (const f of node.fields) {
      if (f.kind !== "relation" || !access(node.name, f.name).read) continue;
      const target = byName.get(f.target);
      if (!target || !subscriptionKey(target, access)) continue;
      const prefix = `${base}${capitalize(f.name)}`;
      relations.push({
        field: f.name,
        ...(on("connected") ? { connected: `${prefix}Connected` } : {}),
        ...(on("disconnected") ? { disconnected: `${prefix}Disconnected` } : {}),
      });
    }
  }
  if (!changed && relations.length === 0) return undefined;
  return { ...(changed ? { changed } : {}), relations };
}

/** Whether a model has the indexes (or the shape) an operation needs; served only then. */
function servable(
  node: ResolvedNodeModel,
  op: RootOperation,
  byName: ReadonlyMap<string, ResolvedNodeModel>,
): boolean {
  const members = (): ResolvedNodeModel[] =>
    (node.implementations ?? []).flatMap((m) => {
      const found = byName.get(m);
      return found ? [found] : [];
    });
  switch (op) {
    case "aggregate":
    case "groupBy":
      return !node.union;
    case "search":
      return node.union
        ? members().some((m) => (m.fulltextIndexes?.length ?? 0) > 0)
        : (node.fulltextIndexes?.length ?? 0) > 0;
    case "findSimilar":
      return node.union ? members().some(hasVectorIndex) : hasVectorIndex(node);
    case "traverse":
    case "traversePaths":
    case "shortestPath":
      // Over relations back to the same model, on a node model (path nodes are of the model).
      return (
        !node.abstract && node.fields.some((f) => f.kind === "relation" && f.target === node.name)
      );
    default:
      return true;
  }
}

/** Whether a model has a `Vector(N)` field with a `@vectorIndex`. */
export function hasVectorIndex(node: ResolvedNodeModel): boolean {
  return node.fields.some((f) => f.kind === "scalar" && f.vectorIndex !== undefined);
}

/** Check the shape of `models.<M>.rules`: known keys, functions, relations of the model. */
function checkRules(where: string, node: ResolvedNodeModel, rules: unknown): ConfiguredRules {
  if (!isPlainObject(rules)) throw new NativeSchemaError(`${where} must be an object.`);
  checkKeys(where, rules, RULE_KEYS);
  if (node.union) {
    const writes = Object.keys(rules).filter((k) => k !== "read" && rules[k] !== undefined);
    if (writes.length) {
      throw new NativeSchemaError(
        `${where}: ${node.name} is a union, which is only read; put ${writes.join(", ")} rules on its members.`,
      );
    }
  }
  for (const k of ["read", "create", "update", "delete"] as const) {
    if (rules[k] !== undefined && typeof rules[k] !== "function") {
      throw new NativeSchemaError(`${where}.${k} must be a function ({ ctx }) => …`);
    }
  }
  for (const k of ["connect", "disconnect"] as const) {
    const per = rules[k];
    if (per === undefined) continue;
    if (!isPlainObject(per)) {
      throw new NativeSchemaError(`${where}.${k} must be an object keyed by relation field.`);
    }
    const relations = node.fields.filter((f) => f.kind === "relation").map((f) => f.name);
    for (const [rel, fn] of Object.entries(per)) {
      if (fn === undefined) continue;
      if (!relations.includes(rel)) {
        throw new NativeSchemaError(
          `${where}.${k}: unknown relation "${node.name}.${rel}" (relations: ${relations.join(", ") || "none"}).`,
        );
      }
      if (typeof fn !== "function") {
        throw new NativeSchemaError(`${where}.${k}.${rel} must be a function ({ ctx }) => …`);
      }
    }
  }
  if (rules.after !== undefined) {
    if (!isPlainObject(rules.after))
      throw new NativeSchemaError(`${where}.after must be an object.`);
    checkKeys(`${where}.after`, rules.after, ["create", "update"]);
    for (const [k, fn] of Object.entries(rules.after)) {
      if (fn !== undefined && typeof fn !== "function") {
        throw new NativeSchemaError(`${where}.after.${k} must be a function ({ ctx }) => …`);
      }
    }
  }
  return rules as ConfiguredRules;
}
