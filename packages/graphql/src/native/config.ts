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

/** Write groups: not served yet (writes come with the native write API), so only `false`. */
const WRITE_GROUPS = ["create", "update", "delete"] as const;

/**
 * Which operations of a model are root fields. `read` takes `true` (every read operation), `false`
 * or a list of operations. Writes are not served yet: `create`, `update` and `delete` only take
 * `false`.
 */
export type OperationToggles = {
  readonly read?: boolean | readonly ReadOperation[];
  readonly create?: false;
  readonly update?: false;
  readonly delete?: false;
};

/**
 * What the API does with one field. `false` hides it everywhere (types, filters, ordering).
 * `read: false` is the same; `filter: false` / `sort: false` keep it readable but remove it from
 * `where` / `orderBy`. `create` / `update` are for writes (not served yet). `deprecated` marks the
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
    readonly [M in keyof TM & string]?: { readonly [O in ReadOperation]?: string };
  };
  readonly limits?: Limits;
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
  readonly deprecated?: string;
};

/** The checked configuration, with defaults applied. */
export type ResolvedConfig = {
  /** Root fields per model: operation → field name (absent: the operation is off). */
  readonly operations: ReadonlyMap<string, ReadonlyMap<ReadOperation, string>>;
  /** `field(model, name)`: the effective toggles of a field. */
  field(model: string, name: string): FieldAccess;
  readonly limits: Limits;
};

const LIMIT_KEYS = ["maxDepth", "maxTake", "maxAliases", "maxComplexity"] as const;
const FIELD_KEYS = ["read", "filter", "sort", "create", "update", "deprecated"] as const;
const TOP_KEYS = ["generator", "models", "defaults", "naming", "limits"] as const;

function checkKeys(where: string, obj: AnyRecord, allowed: readonly string[]): void {
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined && !allowed.includes(k)) {
      throw new NativeSchemaError(`${where}: unknown key "${k}" (expected ${allowed.join(", ")}).`);
    }
  }
}

function readOps(where: string, toggles: unknown): Set<ReadOperation> | undefined {
  if (toggles === undefined) return undefined;
  if (!isPlainObject(toggles)) throw new NativeSchemaError(`${where} must be an object.`);
  checkKeys(where, toggles, ["read", ...WRITE_GROUPS]);
  for (const g of WRITE_GROUPS) {
    const v = toggles[g];
    if (v !== undefined && v !== false) {
      throw new NativeSchemaError(
        `${where}.${g}: writes are not available in the native API yet; only false is accepted.`,
      );
    }
  }
  const read = toggles.read;
  if (read === undefined) return undefined;
  if (read === true) return new Set(READ_OPERATIONS);
  if (read === false) return new Set();
  if (!Array.isArray(read)) {
    throw new NativeSchemaError(`${where}.read must be true, false or a list of operations.`);
  }
  for (const op of read) {
    if (!(READ_OPERATIONS as readonly unknown[]).includes(op)) {
      throw new NativeSchemaError(
        `${where}.read: unknown operation ${JSON.stringify(op)} (use ${READ_OPERATIONS.join(", ")}).`,
      );
    }
  }
  return new Set(read as ReadOperation[]);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** `postFindMany`: the default root field of `operation` on `model`. */
export function rootFieldName(model: string, operation: ReadOperation): string {
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
  const defaults =
    readOps("config.defaults.operations", config.defaults?.operations) ?? new Set(READ_OPERATIONS);

  const models = (config.models ?? {}) as AnyRecord;
  if (!isPlainObject(models)) throw new NativeSchemaError("config.models must be an object.");
  const fieldToggles = new Map<string, FieldAccess>();
  const opsByModel = new Map<string, Set<ReadOperation>>();
  for (const [name, mc] of Object.entries(models)) {
    if (mc === undefined) continue;
    const where = `config.models.${name}`;
    const node = known("config.models", name);
    if (!isPlainObject(mc)) throw new NativeSchemaError(`${where} must be an object.`);
    checkKeys(where, mc, ["operations", "fields"]);
    const ops = readOps(`${where}.operations`, mc.operations);
    if (ops) opsByModel.set(name, ops);
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
        fieldToggles.set(`${name}.${field}`, { read: false, filter: false, sort: false });
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
    checkKeys(`config.naming.${name}`, n, READ_OPERATIONS);
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
    let out: FieldAccess = own ?? { read: true, filter: true, sort: true };
    for (const t of inherited) {
      out = {
        read: out.read && t.read,
        filter: out.filter && t.filter,
        sort: out.sort && t.sort,
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

  const operations = new Map<string, Map<ReadOperation, string>>();
  for (const node of schema.nodes) {
    const ops = opsByModel.get(node.name) ?? defaults;
    const names = new Map<ReadOperation, string>();
    for (const op of READ_OPERATIONS) {
      if (!ops.has(op)) continue;
      // A union has no unique key.
      if (op === "findUnique" && node.union) continue;
      if (op === "findUnique" && node.uniqueFields.length === 0 && !node.compoundUniques?.length)
        continue;
      const override = (naming[node.name] as AnyRecord | undefined)?.[op];
      names.set(op, typeof override === "string" ? override : rootFieldName(node.name, op));
    }
    operations.set(node.name, names);
  }

  return { operations, field: access, limits: limits as Limits };
}
