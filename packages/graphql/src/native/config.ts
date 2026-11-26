/**
 * The configuration of the native GraphQL API (`defineGraphQL`): which operations and fields each
 * model exposes, root field names, limits. Typed from the generated client's `CyphraTypeMap`, so a
 * key naming an unknown model or field is a compile error; {@link checkConfig} checks the same
 * things at startup for JavaScript users and configs built dynamically.
 *
 * @packageDocumentation
 */

import type { ModelTypeDef, TypeMap } from "@cyphra/runtime";
import type { SchemaModel } from "@cyphra/schema";

/** Read operations a model can expose as root fields. */
export const READ_OPERATIONS = ["findUnique", "findFirst", "findMany", "count"] as const;

/** A read operation of the native API (`<model>FindMany`, …). */
export type ReadOperation = (typeof READ_OPERATIONS)[number];

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
export type RootOperation = ReadOperation | WriteOperation;

const GROUPS = {
  read: READ_OPERATIONS,
  create: CREATE_OPERATIONS,
  update: UPDATE_OPERATIONS,
  delete: DELETE_OPERATIONS,
} as const;
type Group = keyof typeof GROUPS;

/** Whether `op` is a write (a `Mutation` root field). */
export function isWrite(op: RootOperation): op is WriteOperation {
  return (WRITE_OPERATIONS as readonly string[]).includes(op);
}

/**
 * Which operations of a model are root fields, per group: `true` (every operation of the group),
 * `false` or a list of operations. `upsert` is served when both `create` and `update` include it.
 * Default: reads on, writes off.
 */
export type OperationToggles = {
  readonly read?: boolean | readonly ReadOperation[];
  readonly create?: boolean | readonly CreateOperation[];
  readonly update?: boolean | readonly UpdateOperation[];
  readonly delete?: boolean | readonly DeleteOperation[];
};

/**
 * What the API does with one field. `false` hides it everywhere (types, filters, ordering,
 * writes). `read: false` hides it from types, filters and ordering, and from writes unless
 * `create` / `update` say otherwise (a write-only field); `filter: false` / `sort: false` keep it
 * readable but remove it from `where` / `orderBy`; `create: false` / `update: false` remove it
 * from the create / update inputs (for a relation: its nested writes). `deprecated` marks the
 * field `@deprecated(reason)` in the schema.
 */
export type FieldToggle =
  | false
  | {
      readonly read?: boolean;
      readonly filter?: boolean;
      readonly sort?: boolean;
      readonly create?: boolean;
      readonly update?: boolean;
      readonly deprecated?: string;
    };

type FieldNames<M extends ModelTypeDef> = (keyof M["scalars"] | keyof M["relations"]) & string;

/** The configuration of one model. */
export type ModelConfig<M extends ModelTypeDef = ModelTypeDef> = {
  readonly operations?: OperationToggles;
  readonly fields?: { readonly [F in FieldNames<M>]?: FieldToggle };
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
  /** Per-model operations and fields. */
  readonly models?: { readonly [M in keyof TM & string]?: ModelConfig<TM[M]> };
  /** Defaults for every model: reads on, writes off. */
  readonly defaults?: { readonly operations?: OperationToggles };
  /** Root field names replacing `<model><Operation>` (`{ Person: { findMany: "people" } }`). */
  readonly naming?: {
    readonly [M in keyof TM & string]?: { readonly [O in RootOperation]?: string };
  };
  readonly limits?: Limits;
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

/** The checked configuration, with defaults applied. */
export type ResolvedConfig = {
  /** Root fields per model: operation → field name (absent: the operation is off). */
  readonly operations: ReadonlyMap<string, ReadonlyMap<RootOperation, string>>;
  /** `field(model, name)`: the effective toggles of a field. */
  field(model: string, name: string): FieldAccess;
  readonly limits: Limits;
  /** `relay: true`: the `Node` interface and `node(id)`. */
  readonly relay: boolean;
  readonly mutationTransaction: "field" | "request";
};

const LIMIT_KEYS = ["maxDepth", "maxTake", "maxAliases", "maxComplexity"] as const;
const FIELD_KEYS = ["read", "filter", "sort", "create", "update", "deprecated"] as const;
const TOP_KEYS = [
  "generator",
  "models",
  "defaults",
  "naming",
  "limits",
  "relay",
  "mutationTransaction",
] as const;
const ROOT_OPERATIONS: readonly RootOperation[] = [...READ_OPERATIONS, ...WRITE_OPERATIONS];
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
function readOps(where: string, toggles: unknown): Partial<Record<Group, Set<RootOperation>>> {
  if (toggles === undefined) return {};
  if (!isPlainObject(toggles)) throw new NativeSchemaError(`${where} must be an object.`);
  const groups = Object.keys(GROUPS) as Group[];
  checkKeys(where, toggles, groups);
  const out: Partial<Record<Group, Set<RootOperation>>> = {};
  for (const g of groups) {
    const v = toggles[g];
    if (v === undefined) continue;
    const all: readonly RootOperation[] = GROUPS[g];
    if (v === true) out[g] = new Set(all);
    else if (v === false) out[g] = new Set();
    else if (!Array.isArray(v)) {
      throw new NativeSchemaError(`${where}.${g} must be true, false or a list of operations.`);
    } else {
      for (const op of v) {
        if (!all.includes(op as RootOperation)) {
          throw new NativeSchemaError(
            `${where}.${g}: unknown operation ${JSON.stringify(op)} (use ${all.join(", ")}).`,
          );
        }
      }
      out[g] = new Set(v as RootOperation[]);
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
    read: new Set<RootOperation>(READ_OPERATIONS),
    create: new Set<RootOperation>(),
    update: new Set<RootOperation>(),
    delete: new Set<RootOperation>(),
    ...readOps("config.defaults.operations", config.defaults?.operations),
  };

  const models = (config.models ?? {}) as AnyRecord;
  if (!isPlainObject(models)) throw new NativeSchemaError("config.models must be an object.");
  const fieldToggles = new Map<string, FieldAccess>();
  const opsByModel = new Map<string, Partial<Record<Group, Set<RootOperation>>>>();
  for (const [name, mc] of Object.entries(models)) {
    if (mc === undefined) continue;
    const where = `config.models.${name}`;
    const node = known("config.models", name);
    if (!isPlainObject(mc)) throw new NativeSchemaError(`${where} must be an object.`);
    checkKeys(where, mc, ["operations", "fields"]);
    const ops = readOps(`${where}.operations`, mc.operations);
    opsByModel.set(name, ops);
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
      for (const k of ["read", "filter", "sort", "create", "update"]) {
        if (toggle[k] !== undefined && typeof toggle[k] !== "boolean") {
          throw new NativeSchemaError(`${where}.fields.${field}.${k} must be a boolean.`);
        }
      }
      if (toggle.deprecated !== undefined && typeof toggle.deprecated !== "string") {
        throw new NativeSchemaError(`${where}.fields.${field}.deprecated must be a string.`);
      }
      const read = toggle.read !== false;
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
    checkKeys(`config.naming.${name}`, n, ROOT_OPERATIONS);
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

  const operations = new Map<string, Map<RootOperation, string>>();
  for (const node of schema.nodes) {
    const own = opsByModel.get(node.name) ?? {};
    const group = (g: Group) => own[g] ?? defaults[g];
    const on = (op: RootOperation): boolean => {
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
      const override = (naming[node.name] as AnyRecord | undefined)?.[op];
      names.set(op, typeof override === "string" ? override : rootFieldName(node.name, op));
    }
    operations.set(node.name, names);
  }

  return {
    operations,
    field: access,
    limits: limits as Limits,
    relay: config.relay === true,
    mutationTransaction: config.mutationTransaction ?? "field",
  };
}
