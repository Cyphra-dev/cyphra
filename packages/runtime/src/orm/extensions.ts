/**
 * Runtime of client extensions (`db.$extends`): the accumulated extension state, the query hook
 * chain and the computed-field layer (rewrites `select` to fetch `needs`, then computes and strips).
 */
import type { ResolvedNodeModel, SchemaModel } from "@cyphra/schema";
import { CyphraValidationError } from "./errors.js";
import { traverseEndModel } from "./traverse.js";
import type { OrmOperation } from "./extensionTypes.js";

type AnyRecord = Record<string, unknown>;
type AnyFn = (...args: unknown[]) => unknown;

/** Every model operation hooks and computed fields apply to. */
export const ORM_OPERATIONS: ReadonlySet<string> = new Set<OrmOperation>([
  "findMany",
  "findFirst",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "aggregate",
  "groupBy",
  "traverse",
  "shortestPath",
  "allShortestPaths",
  "findSimilar",
  "search",
]);

/** The untyped shape of one `$extends({ … })` argument. */
export type ExtensionDef = {
  name?: string;
  query?: Record<string, Record<string, AnyFn | undefined> | undefined>;
  result?: Record<string, Record<string, ComputedDef | undefined> | undefined>;
  model?: Record<string, Record<string, unknown> | undefined>;
  client?: Record<string, unknown>;
};

type ComputedDef = { needs?: Record<string, unknown>; compute: (row: AnyRecord) => unknown };
type Computed = {
  readonly needs: readonly string[];
  readonly compute: (row: AnyRecord) => unknown;
};

type Hook = (params: {
  model: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
  client: object;
}) => unknown;

const ALL = "$allModels";
const ALL_OPS = "$allOperations";

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function delegateKey(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/** Every extension applied to a client, in order, with lookups cached per model. */
export class ExtensionState {
  private readonly computedCache = new Map<string, ReadonlyMap<string, Computed>>();
  private readonly hookCache = new Map<string, readonly Hook[]>();
  private readonly methodCache = new Map<string, ReadonlyMap<string, unknown>>();
  /** `true` when some extension declares computed fields. */
  readonly hasComputed: boolean;

  private constructor(
    private readonly schema: SchemaModel,
    readonly layers: readonly ExtensionDef[],
  ) {
    this.hasComputed = layers.some((l) => l.result && Object.keys(l.result).length > 0);
  }

  static empty(schema: SchemaModel): ExtensionState {
    return new ExtensionState(schema, []);
  }

  /** This state plus `ext` (validated). */
  extend(ext: ExtensionDef): ExtensionState {
    validateExtension(this.schema, ext);
    return new ExtensionState(this.schema, [...this.layers, ext]);
  }

  /** Computed fields of model `model` (`$allModels` ones first; later extensions win). */
  computed(model: string): ReadonlyMap<string, Computed> {
    let out = this.computedCache.get(model);
    if (!out) {
      const map = new Map<string, Computed>();
      const key = delegateKey(model);
      for (const layer of this.layers) {
        for (const k of [ALL, key]) {
          for (const [name, def] of Object.entries(layer.result?.[k] ?? {})) {
            if (!def) continue;
            map.delete(name);
            const needs = Object.entries(def.needs ?? {})
              .filter(([, v]) => v)
              .map(([n]) => n);
            map.set(name, { needs, compute: def.compute });
          }
        }
      }
      out = map;
      this.computedCache.set(model, out);
    }
    return out;
  }

  /**
   * Hooks around `operation` on `model`, outermost first: extensions in the order they were
   * added; within one, `$allModels.$allOperations`, `$allModels.<op>`, `<model>.$allOperations`,
   * `<model>.<op>`.
   */
  hooks(model: string, operation: string): readonly Hook[] {
    const cacheKey = `${model}.${operation}`;
    let out = this.hookCache.get(cacheKey);
    if (!out) {
      const list: Hook[] = [];
      const key = delegateKey(model);
      for (const layer of this.layers) {
        for (const k of [ALL, key]) {
          for (const op of [ALL_OPS, operation]) {
            const fn = layer.query?.[k]?.[op];
            if (typeof fn === "function") list.push(fn as Hook);
          }
        }
      }
      out = list;
      this.hookCache.set(cacheKey, out);
    }
    return out;
  }

  /** Custom methods of model `model` (`$allModels` ones first; later extensions win). */
  methods(model: string): ReadonlyMap<string, unknown> {
    let out = this.methodCache.get(model);
    if (!out) {
      const map = new Map<string, unknown>();
      const key = delegateKey(model);
      for (const layer of this.layers) {
        for (const k of [ALL, key]) {
          for (const [name, fn] of Object.entries(layer.model?.[k] ?? {})) map.set(name, fn);
        }
      }
      out = map;
      this.methodCache.set(model, out);
    }
    return out;
  }

  /** Custom client members, later extensions winning. */
  clientMembers(): AnyRecord {
    return Object.assign({}, ...this.layers.map((l) => l.client ?? {})) as AnyRecord;
  }
}

const delegateKeys = new WeakMap<SchemaModel, ReadonlyMap<string, ResolvedNodeModel>>();

/** The models of `schema` by delegate key (cached: `$extends` per request stays cheap). */
function delegatesOf(schema: SchemaModel): ReadonlyMap<string, ResolvedNodeModel> {
  let map = delegateKeys.get(schema);
  if (!map) {
    map = new Map(schema.nodes.map((n) => [delegateKey(n.name), n]));
    delegateKeys.set(schema, map);
  }
  return map;
}

function validateExtension(schema: SchemaModel, ext: ExtensionDef): void {
  if (!isPlainObject(ext))
    throw new CyphraValidationError("$extends takes an object or a function.");
  const label = ext.name ? `$extends (${ext.name})` : "$extends";
  const byKey = delegatesOf(schema);
  for (const k of Object.keys(ext)) {
    if (!["name", "query", "result", "model", "client"].includes(k)) {
      throw new CyphraValidationError(
        `${label}: unknown key "${k}" (expected query, result, model or client).`,
      );
    }
  }
  const models = (section: string, value: unknown): [string, AnyRecord][] => {
    if (value === undefined) return [];
    if (!isPlainObject(value))
      throw new CyphraValidationError(`${label}: ${section} must be an object.`);
    return Object.entries(value).map(([k, v]) => {
      if (k !== ALL && !byKey.has(k)) {
        throw new CyphraValidationError(
          `${label}: ${section}.${k} is not a model (use a delegate name such as "${[...byKey.keys()][0] ?? "user"}", or $allModels).`,
        );
      }
      if (!isPlainObject(v))
        throw new CyphraValidationError(`${label}: ${section}.${k} must be an object.`);
      return [k, v];
    });
  };
  for (const [k, hooks] of models("query", ext.query)) {
    for (const [op, fn] of Object.entries(hooks)) {
      if (op !== ALL_OPS && !ORM_OPERATIONS.has(op)) {
        throw new CyphraValidationError(`${label}: query.${k}.${op} is not a model operation.`);
      }
      if (typeof fn !== "function") {
        throw new CyphraValidationError(`${label}: query.${k}.${op} must be a function.`);
      }
    }
  }
  for (const [k, fields] of models("result", ext.result)) {
    const node = byKey.get(k);
    for (const [name, def] of Object.entries(fields)) {
      const where = `${label}: result.${k}.${name}`;
      if (!isPlainObject(def) || typeof def.compute !== "function") {
        throw new CyphraValidationError(`${where} must be { needs?, compute(row) }.`);
      }
      if (def.needs !== undefined && !isPlainObject(def.needs)) {
        throw new CyphraValidationError(`${where}.needs must be an object ({ field: true }).`);
      }
      if (node) {
        const field = node.fields.find((f) => f.name === name);
        if (field?.kind === "relation") {
          throw new CyphraValidationError(`${where}: ${node.name}.${name} is a relation.`);
        }
        for (const n of Object.keys(def.needs ?? {})) {
          const f = node.fields.find((x) => x.name === n);
          if (f?.kind !== "scalar") {
            throw new CyphraValidationError(
              `${where}.needs.${n} is not a scalar field of ${node.name}.`,
            );
          }
        }
      }
    }
  }
  for (const [k, methods] of models("model", ext.model)) {
    for (const [name, fn] of Object.entries(methods)) {
      if (typeof fn !== "function") {
        throw new CyphraValidationError(`${label}: model.${k}.${name} must be a function.`);
      }
    }
  }
  if (ext.client !== undefined && !isPlainObject(ext.client)) {
    throw new CyphraValidationError(`${label}: client must be an object.`);
  }
}

/** Run `run` through the query hooks of `operation` on `model`. */
export function runHooks(
  state: ExtensionState,
  model: string,
  operation: string,
  args: unknown,
  client: () => object,
  run: (args: unknown) => Promise<unknown>,
): Promise<unknown> {
  const hooks = state.hooks(model, operation);
  if (hooks.length === 0) return run(args);
  const call = async (i: number, a: unknown): Promise<unknown> =>
    i === hooks.length
      ? run(a)
      : hooks[i]!({
          model,
          operation,
          args: a ?? {},
          query: (next) => call(i + 1, next),
          client: client(),
        });
  return call(0, args ?? {});
}

// ---------------------------------------------------------------------------
// Computed fields
// ---------------------------------------------------------------------------

/** What to compute on one level of a result (a node, then its loaded relations). */
type Plan = {
  readonly model: string;
  /** Computed fields asked for in `select` (`null`: no `select`, so all of them). */
  readonly selected: ReadonlySet<string> | null;
  /** `needs` fields added to `select` only for `compute`: removed from the result. */
  readonly strip: readonly string[];
  readonly relations: readonly (readonly [string, Plan])[];
  /** On an interface: what to compute for `$on: { <implementation>: … }`, by `__typename`. */
  readonly on?: readonly (readonly [string, Plan])[];
};

function nodeByName(schema: SchemaModel, name: string): ResolvedNodeModel | undefined {
  return schema.nodes.find((n) => n.name === name);
}

/**
 * Rewrite `args` for the engine (computed keys out of `select`, their `needs` in) and plan what
 * to compute on the result.
 */
function prepare(
  state: ExtensionState,
  schema: SchemaModel,
  node: ResolvedNodeModel,
  args: AnyRecord,
): { args: AnyRecord; plan: Plan } {
  const computed = state.computed(node.name);
  const relations: [string, Plan][] = [];
  const on: [string, Plan][] = [];
  const relation = (key: string) => {
    const f = node.fields.find((x) => x.name === key);
    return f?.kind === "relation" ? nodeByName(schema, f.target) : undefined;
  };
  const loadRelations = (spec: AnyRecord): AnyRecord => {
    const out: AnyRecord = { ...spec };
    for (const [key, v] of Object.entries(spec)) {
      if (!v || key === "_count") continue;
      if (key === "$on" && isPlainObject(v)) {
        // Each implementation's part is that implementation's own select / include.
        const kind = spec === args.select ? "select" : "include";
        const parts: AnyRecord = { ...v };
        for (const [name, sub] of Object.entries(v)) {
          const impl = nodeByName(schema, name);
          if (!impl || !isPlainObject(sub)) continue;
          const prepared = prepare(state, schema, impl, { [kind]: sub });
          parts[name] = prepared.args[kind];
          on.push([name, prepared.plan]);
        }
        out[key] = parts;
        continue;
      }
      // A Cypher expression (`{ $cypher, $model?, … }`, internal) returns nodes of `$model`, if any.
      if (isPlainObject(v) && v.$cypher !== undefined) {
        const model = typeof v.$model === "string" ? nodeByName(schema, v.$model) : undefined;
        if (!model) continue;
        const sub = prepare(state, schema, model, v);
        out[key] = sub.args;
        relations.push([key, sub.plan]);
        continue;
      }
      // An aliased load (`{ $relation: "posts", … }`, internal) loads the relation it names.
      const name = isPlainObject(v) && typeof v.$relation === "string" ? v.$relation : key;
      const target = relation(name);
      if (!target) continue;
      const sub = prepare(state, schema, target, isPlainObject(v) ? v : {});
      if (isPlainObject(v)) out[key] = sub.args;
      relations.push([key, sub.plan]);
    }
    return out;
  };

  if (isPlainObject(args.select)) {
    const original = args.select;
    const select = loadRelations(original);
    const selected = new Set<string>();
    for (const [name] of computed) {
      if (!(name in select)) continue;
      if (select[name]) selected.add(name);
      delete select[name];
    }
    const strip: string[] = [];
    const scalar = (n: string) => node.fields.some((f) => f.kind === "scalar" && f.name === n);
    for (const name of selected) {
      for (const n of computed.get(name)!.needs) {
        if (select[n] || !scalar(n)) continue;
        select[n] = true;
        if (!selected.has(n)) strip.push(n);
      }
    }
    return {
      args: { ...args, select },
      plan: { model: node.name, selected, strip, relations, ...(on.length ? { on } : {}) },
    };
  }
  const include = isPlainObject(args.include) ? loadRelations(args.include) : undefined;
  return {
    args: include ? { ...args, include } : args,
    plan: { model: node.name, selected: null, strip: [], relations, ...(on.length ? { on } : {}) },
  };
}

function applyPlan(state: ExtensionState, plan: Plan, value: unknown): void {
  if (!isPlainObject(value)) return;
  let fields = state.computed(plan.model);
  const typename = value.__typename;
  if (plan.selected === null && typeof typename === "string" && typename !== plan.model) {
    // An interface result: the implementation's computed fields apply too (and win).
    fields = new Map([...fields, ...state.computed(typename)]);
  }
  if (fields.size > 0) {
    const row = { ...value };
    for (const [name, def] of fields) {
      if (plan.selected === null || plan.selected.has(name)) value[name] = def.compute(row);
    }
    for (const s of plan.strip) delete value[s];
  }
  for (const [key, sub] of plan.relations) {
    const v = value[key];
    if (Array.isArray(v)) for (const item of v) applyPlan(state, sub, item);
    else applyPlan(state, sub, v);
  }
  for (const [name, sub] of plan.on ?? []) if (typename === name) applyPlan(state, sub, value);
}

/** Operations whose results are nodes (or carry nodes), with where the nodes are. */
const NODE_RESULTS: Record<string, (result: unknown, args: AnyRecord) => unknown[]> = {
  findMany: (r) => r as unknown[],
  findSimilar: (r) => r as unknown[],
  search: (r) => r as unknown[],
  findFirst: (r) => [r],
  findUnique: (r) => [r],
  findUniqueOrThrow: (r) => [r],
  create: (r) => [r],
  update: (r) => [r],
  upsert: (r) => [r],
  delete: (r) => [r],
  createMany: (r) => (r as { nodes?: unknown[] }).nodes ?? [],
  updateMany: (r) => (r as { nodes?: unknown[] }).nodes ?? [],
  deleteMany: (r) => (r as { nodes?: unknown[] }).nodes ?? [],
  traverse: (r, args) =>
    args.returnPaths ? (r as { node: unknown }[]).map((x) => x.node) : (r as unknown[]),
  shortestPath: (r) => (r ? (r as { nodes: unknown[] }).nodes : []),
  allShortestPaths: (r) => (r as { nodes: unknown[] }[]).flatMap((p) => p.nodes),
};

/** Run `run` with computed fields: `needs` fetched, fields computed, extra fields stripped. */
export async function withComputed(
  state: ExtensionState,
  schema: SchemaModel,
  node: ResolvedNodeModel,
  operation: string,
  args: unknown,
  run: (args: unknown) => Promise<unknown>,
): Promise<unknown> {
  const nodes = NODE_RESULTS[operation];
  if (!state.hasComputed || !nodes || !isPlainObject(args ?? {})) return run(args);
  // A traversal along a list of hops returns nodes of the last hop's model.
  if (operation === "traverse") node = traverseEndModel(schema, node, args);
  const prepared = prepare(state, schema, node, (args ?? {}) as AnyRecord);
  const result = await run(args === undefined ? undefined : prepared.args);
  for (const n of nodes(result, prepared.args)) applyPlan(state, prepared.plan, n);
  return result;
}

/**
 * `this` inside a custom model method (`model: { user: { … } }`), typed: the extended delegate,
 * with `$name` (the model name) and `$parent` (its client). Same value as `this`; it helps when a
 * method is defined outside the `$extends` call or `this` is not inferred.
 *
 * @example
 * ```ts
 * findByEmail(email: string) {
 *   const ctx = getExtensionContext(this);
 *   return ctx.findUnique({ where: { email } });
 * }
 * ```
 */
export function getExtensionContext<T>(that: T): T {
  return that;
}
