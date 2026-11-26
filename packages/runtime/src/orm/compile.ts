/**
 * Compiles ORM arguments (where / orderBy / select / include) into Cypher.
 *
 * Every user-supplied *value* becomes a parameter. Every *identifier* (label, property key,
 * relationship type) comes from the resolved schema — unknown keys are rejected — and is
 * backtick-quoted, so arguments can never inject Cypher.
 *
 * Requires Neo4j 5.6+ (`COLLECT {}` / `EXISTS {}` subquery expressions).
 *
 * @packageDocumentation
 */

import type {
  ResolvedNodeModel,
  ResolvedRelationField,
  ResolvedScalarField,
  SchemaModel,
} from "@cyphra/schema";
import { CypherInteger } from "../cypher-values.js";
import { CyphraValidationError } from "./errors.js";
import { decodeCount, decodeScalar, encodeFilterValue, isPointValue } from "./values.js";
import type { QueryMode } from "./types.js";
import type { CyphraDialect } from "../dialect.js";
import { compileLabelsFilter, decodeDynamicLabels, dynamicLabelsOf } from "./labels.js";
import type { EngineRules, RuleOperation, RuleValue } from "./scope.js";

/** Quote an identifier for Cypher (labels, property keys, relationship types). */
export function q(id: string): string {
  return "`" + id.replace(/`/g, "``") + "`";
}

/**
 * Label expression of a node model's nodes: `` `Employee`:`Person` `` for a node implementing
 * interfaces (written and matched with every label), `` `Person` `` for an interface.
 */
export function labelExpr(model: ResolvedNodeModel): string {
  if (model.union) {
    // A union has no label: its nodes are matched with `unionPredicate`.
    throw new Error(`Internal error: ${model.name} is a union and has no label expression.`);
  }
  return (model.labels ?? [model.label]).map(q).join(":");
}

/**
 * `n:`Post` OR n:`User``: the nodes of a union, as a predicate (`null` for another model, whose
 * pattern carries its labels; combine it with {@link and}, which parenthesizes). A union is never matched with `(n:A|B)`: Neo4j rejects a clause
 * mixing `|` with the `:A:B` of implementations, and FalkorDB has no label disjunction.
 */
export function unionPredicate(alias: string, model: ResolvedNodeModel): string | null {
  if (!model.union) return null;
  // Members' labels: an interface member is matched by its own label (every implementation).
  const members = unionMembers(model);
  if (members.length === 0) return "false";
  return members.map((m) => `${alias}:${q(m)}`).join(" OR ");
}

/**
 * The members of a union as declared (an interface member by its name), or the implementations of
 * an interface.
 */
export function unionMembers(model: ResolvedNodeModel): readonly string[] {
  return model.members ?? model.implementations ?? [];
}

/**
 * The names a relation write or `where.$on` of an abstract model may use: its implementations,
 * plus the interface members of a union (`union Party = Person | Team`: Person stands for every
 * node implementing it).
 */
export function memberNames(model: ResolvedNodeModel): readonly string[] {
  const impls = model.implementations ?? [];
  const extra = (model.members ?? []).filter((m) => !impls.includes(m));
  return extra.length ? [...extra, ...impls] : impls;
}

/** `(n:Label)` (every label of the model), or `(n)` for a union (see {@link unionPredicate}). */
export function nodePattern(alias: string, model: ResolvedNodeModel): string {
  return model.union ? `(${alias})` : `(${alias}:${labelExpr(model)})`;
}

/** A predicate true when `alias` is a node of `model`: `n:A:B`, or a union's disjunction. */
export function labelTest(alias: string, model: ResolvedNodeModel): string {
  const union = unionPredicate(alias, model);
  return union === null ? `${alias}:${labelExpr(model)}` : `(${union})`;
}

/**
 * `MATCH (n:Label) WHERE …` for the nodes of `model` bound to `alias` (`where` and, for a union,
 * its label predicate), without the `MATCH` keyword.
 */
export function nodeMatch(alias: string, model: ResolvedNodeModel, where?: string | null): string {
  const w = and([unionPredicate(alias, model), where ?? null]);
  return `${nodePattern(alias, model)}${w ? ` WHERE ${w}` : ""}`;
}

/** `interface` or `union`: how messages name an abstract model. */
export function abstractKind(model: ResolvedNodeModel): string {
  return model.union ? "union" : "interface";
}

/** Throw unless `model` can be created (an interface cannot: create one of its implementations). */
export function assertCreatable(model: ResolvedNodeModel, op: string): void {
  if (!model.abstract) return;
  const impls = model.implementations ?? [];
  if (model.union) {
    throw new CyphraValidationError(
      `${op}: ${model.name} is a union and cannot be created; create one of its members (${impls.join(", ")}) instead.`,
    );
  }
  throw new CyphraValidationError(
    `${op}: ${model.name} is an interface and cannot be created; create ${impls.length ? `one of its implementations (${impls.join(", ")})` : "a node implementing it"} instead.`,
  );
}

/** Collects parameters and fresh variable names for one statement. */
export class QueryContext {
  readonly params: Record<string, unknown> = {};
  private paramCount = 0;
  private varCount = 0;
  /** Above 0 while a rule's own `where` compiles: rules do not apply inside rules. */
  ruleDepth = 0;

  constructor(
    readonly schema: SchemaModel,
    /** The Cypher flavour to compile to (see `dialect.ts`). */
    readonly dialect: CyphraDialect = "neo4j",
    /**
     * Rules ANDed into every match of their model (see {@link scopedWhere}); several sets all
     * apply.
     */
    readonly rules: readonly EngineRules[] = [],
    /**
     * `true`: projected scalars (node and edge properties) are returned as the driver gives them,
     * not decoded (see {@link Shape.raw}).
     */
    readonly raw: boolean = false,
  ) {}

  /** Bind a value and return its `$placeholder`. */
  param(value: unknown): string {
    const key = `p${this.paramCount++}`;
    this.params[key] = value;
    return `$${key}`;
  }

  /** Fresh variable name, e.g. `m3`. */
  variable(prefix = "m"): string {
    return `${prefix}${this.varCount++}`;
  }

  node(name: string): ResolvedNodeModel {
    const n = this.schema.nodes.find((x) => x.name === name);
    if (!n) throw new CyphraValidationError(`Unknown model "${name}".`);
    return n;
  }
}

type AnyRecord = Record<string, unknown>;

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

export function scalarField(
  model: ResolvedNodeModel,
  name: string,
): ResolvedScalarField | undefined {
  const f = model.fields.find((x) => x.name === name);
  return f?.kind === "scalar" ? f : undefined;
}

export function relationField(
  model: ResolvedNodeModel,
  name: string,
): ResolvedRelationField | undefined {
  const f = model.fields.find((x) => x.name === name);
  return f?.kind === "relation" ? f : undefined;
}

function scalarOrThrow(model: ResolvedNodeModel, name: string): ResolvedScalarField {
  const f = scalarField(model, name);
  if (!f) throw new CyphraValidationError(`Unknown scalar field "${model.name}.${name}".`);
  return f;
}

/**
 * `(a)-[r:T]->(b:Label)` or `(a)<-[r:T]-(b:Label)`; `(b)` for a union target, whose label
 * predicate the caller adds (use {@link relationMatch}).
 */
export function relationPattern(
  ctx: QueryContext,
  from: string,
  rel: ResolvedRelationField,
  to: string,
  relVar = "",
): string {
  const target = ctx.node(rel.target);
  const edge = `[${relVar}:${q(rel.relType)}]`;
  const end = nodePattern(to, target);
  return rel.direction === "OUT" ? `(${from})-${edge}->${end}` : `(${from})<-${edge}-${end}`;
}

/**
 * {@link relationPattern} followed by `WHERE` with `where` and, for a union target, its label
 * predicate (no `WHERE` when there is neither): what goes after a `MATCH`.
 */
export function relationMatch(
  ctx: QueryContext,
  from: string,
  rel: ResolvedRelationField,
  to: string,
  relVar = "",
  where: string | null = null,
): string {
  const w = and([unionPredicate(to, ctx.node(rel.target)), where]);
  return `${relationPattern(ctx, from, rel, to, relVar)}${w ? ` WHERE ${w}` : ""}`;
}

// ---------------------------------------------------------------------------
// WHERE
// ---------------------------------------------------------------------------

const SCALAR_OPS = new Set([
  "equals",
  "not",
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "startsWith",
  "endsWith",
  "mode",
]);
const LIST_OPS = new Set(["has", "hasEvery", "hasSome", "isEmpty", "equals"]);

/** `(a) AND (b)` of the non-empty parts, or `null` when there are none. */
export function and(parts: readonly (string | null)[]): string | null {
  const p = parts.filter((x): x is string => Boolean(x));
  if (p.length === 0) return null;
  return p.length === 1 ? p[0]! : p.map((x) => `(${x})`).join(" AND ");
}

function compileListFilter(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  field: ResolvedScalarField,
  ref: string,
  filter: unknown,
): string | null {
  if (!isPlainObject(filter)) {
    throw new CyphraValidationError(
      `${model.name}.${field.name}: list filters take { has, hasEvery, hasSome, isEmpty, equals }.`,
    );
  }
  const enc = (v: unknown) => encodeFilterValue(field, v, model.name);
  const parts: string[] = [];
  for (const [op, v] of Object.entries(filter)) {
    if (v === undefined) continue;
    if (!LIST_OPS.has(op)) throw new CyphraValidationError(`Unknown list filter "${op}".`);
    const arr = (x: unknown) => {
      if (!Array.isArray(x)) throw new CyphraValidationError(`${op} expects an array.`);
      return x.map(enc);
    };
    if (op === "has") parts.push(`${ctx.param(enc(v))} IN ${ref}`);
    if (op === "hasEvery") parts.push(`all(x IN ${ctx.param(arr(v))} WHERE x IN ${ref})`);
    if (op === "hasSome") parts.push(`any(x IN ${ctx.param(arr(v))} WHERE x IN ${ref})`);
    if (op === "isEmpty") parts.push(v ? `coalesce(size(${ref}), 0) = 0` : `size(${ref}) > 0`);
    if (op === "equals") parts.push(`${ref} = ${ctx.param(arr(v))}`);
  }
  return and(parts);
}

/** Vector fields only filter on presence: `null`, `{ equals: null }`, `{ not: null }`. */
function compileVectorFilter(
  model: ResolvedNodeModel,
  field: ResolvedScalarField,
  ref: string,
  filter: unknown,
): string | null {
  if (filter === null) return `${ref} IS NULL`;
  const keys = isPlainObject(filter)
    ? Object.keys(filter).filter((k) => filter[k] !== undefined)
    : [];
  if (
    isPlainObject(filter) &&
    keys.every((k) => (k === "equals" || k === "not") && filter[k] === null)
  ) {
    const parts = keys.map((k) => (k === "equals" ? `${ref} IS NULL` : `${ref} IS NOT NULL`));
    return and(parts);
  }
  throw new CyphraValidationError(
    `${model.name}.${field.name}: Vector fields can only be filtered on null (null, { equals: null }, { not: null }); use findSimilar to search them.`,
  );
}

/**
 * Json fields compare their stored JSON text: `null`, `{ equals: value | null }`,
 * `{ not: value | null }`. There are no deep (path) queries, and a bare value is not accepted (an
 * object would be ambiguous with a filter).
 */
function compileJsonFilter(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  field: ResolvedScalarField,
  ref: string,
  filter: unknown,
): string | null {
  if (filter === null) return `${ref} IS NULL`;
  if (!isPlainObject(filter) || Object.keys(filter).some((k) => k !== "equals" && k !== "not")) {
    throw new CyphraValidationError(
      `${model.name}.${field.name}: Json fields filter with null, { equals } or { not } only.`,
    );
  }
  const parts: string[] = [];
  for (const [op, v] of Object.entries(filter)) {
    if (v === undefined) continue;
    const value = v === null ? null : ctx.param(encodeFilterValue(field, v, model.name));
    if (op === "equals") parts.push(value === null ? `${ref} IS NULL` : `${ref} = ${value}`);
    else parts.push(value === null ? `${ref} IS NOT NULL` : `${ref} <> ${value}`);
  }
  return and(parts);
}

const POINT_OPS = new Set(["equals", "not", "distance", "withinBBox"]);
const DISTANCE_OPS = { lt: "<", lte: "<=", gt: ">", gte: ">=" } as const;

/**
 * Point fields: `null`, a bare point (equality), `{ equals, not }`, `{ distance: { from, lt, lte,
 * gt, gte } }` (`point.distance`: meters for WGS-84) and `{ withinBBox: { lowerLeft, upperRight } }`
 * (`point.withinBBox`). Points of another CRS or dimension never match a distance or a box.
 */
function compilePointFilter(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  field: ResolvedScalarField,
  ref: string,
  filter: unknown,
): string | null {
  const where = `${model.name}.${field.name}`;
  const point = (v: unknown, what: string) => {
    if (!isPointValue(field.type, v)) {
      const shape = field.type === "Point" ? "{ longitude, latitude, height? }" : "{ x, y, z? }";
      throw new CyphraValidationError(`${where}: ${what} must be a ${field.type} ${shape}.`);
    }
    return ctx.param(encodeFilterValue(field, v, model.name));
  };
  if (filter === null) return `${ref} IS NULL`;
  if (isPointValue(field.type, filter)) return `${ref} = ${point(filter, "the value")}`;
  if (!isPlainObject(filter)) {
    throw new CyphraValidationError(
      `${where}: point filters take a point, null or { equals, not, distance, withinBBox }.`,
    );
  }
  const parts: string[] = [];
  for (const [op, v] of Object.entries(filter)) {
    if (v === undefined) continue;
    if (!POINT_OPS.has(op)) {
      throw new CyphraValidationError(
        `Unknown filter "${op}" on ${where} (point fields take equals, not, distance and withinBBox).`,
      );
    }
    if (op === "equals") {
      parts.push(v === null ? `${ref} IS NULL` : `${ref} = ${point(v, "equals")}`);
    } else if (op === "not") {
      parts.push(v === null ? `${ref} IS NOT NULL` : `${ref} <> ${point(v, "not")}`);
    } else if (op === "distance") {
      if (!isPlainObject(v) || v.from === undefined) {
        throw new CyphraValidationError(
          `${where}: distance takes { from: <point>, lt?, lte?, gt?, gte? }.`,
        );
      }
      const dist = `point.distance(${ref}, ${point(v.from, "distance.from")})`;
      const bounds: string[] = [];
      for (const [k, d] of Object.entries(v)) {
        if (k === "from" || d === undefined) continue;
        const sym = DISTANCE_OPS[k as keyof typeof DISTANCE_OPS];
        if (!sym) {
          throw new CyphraValidationError(
            `Unknown distance filter "${k}" on ${where} (use lt, lte, gt, gte).`,
          );
        }
        if (typeof d !== "number" || !Number.isFinite(d)) {
          throw new CyphraValidationError(`${where}: distance.${k} must be a finite number.`);
        }
        bounds.push(`${dist} ${sym} ${ctx.param(d)}`);
      }
      if (bounds.length === 0) {
        throw new CyphraValidationError(`${where}: distance needs a bound (lt, lte, gt or gte).`);
      }
      parts.push(...bounds);
    } else {
      if (!isPlainObject(v)) {
        throw new CyphraValidationError(
          `${where}: withinBBox takes { lowerLeft: <point>, upperRight: <point> }.`,
        );
      }
      const ll = point(v.lowerLeft, "withinBBox.lowerLeft");
      const ur = point(v.upperRight, "withinBBox.upperRight");
      parts.push(`point.withinBBox(${ref}, ${ll}, ${ur})`);
    }
  }
  return and(parts);
}

/** Filters a `Duration` field takes: durations have no total order. */
const DURATION_OPS = new Set(["equals", "not", "in", "notIn"]);

type StringFilterMode = QueryMode;

/**
 * Compile a filter on one scalar `field` read from the Cypher expression `ref` (a property, or a
 * variable holding an aggregate in `groupBy` `having`).
 */
export function compileScalarFilter(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  field: ResolvedScalarField,
  ref: string,
  filter: unknown,
  inheritedMode: StringFilterMode = "default",
): string | null {
  if (filter === undefined) return null;
  if (field.type === "Vector") return compileVectorFilter(model, field, ref, filter);
  if (field.type === "Json") return compileJsonFilter(ctx, model, field, ref, filter);
  if (field.list) return compileListFilter(ctx, model, field, ref, filter);
  if (field.type === "Point" || field.type === "CartesianPoint") {
    return compilePointFilter(ctx, model, field, ref, filter);
  }
  const enc = (v: unknown) => encodeFilterValue(field, v, model.name);
  if (filter === null) return `${ref} IS NULL`;
  if (!isPlainObject(filter)) return `${ref} = ${ctx.param(enc(filter))}`;
  if (field.type === "Duration") {
    const bad = Object.keys(filter).find((k) => filter[k] !== undefined && !DURATION_OPS.has(k));
    if (bad) {
      throw new CyphraValidationError(
        `${model.name}.${field.name}: "${bad}" is not valid on a Duration field (durations have no total order; use equals, not, in, notIn).`,
      );
    }
  }

  const mode = filter.mode ?? inheritedMode;
  if (mode !== "default" && mode !== "insensitive") {
    throw new CyphraValidationError(
      `${model.name}.${field.name}: mode must be "default" or "insensitive".`,
    );
  }
  if (mode === "insensitive" && field.type !== "String") {
    throw new CyphraValidationError(
      `${model.name}.${field.name}: mode "insensitive" is only valid on String fields.`,
    );
  }
  // Case-insensitive matching compares lower-cased values on both sides.
  const insensitive = mode === "insensitive";
  const lhs = insensitive ? `toLower(${ref})` : ref;
  const fold = (v: unknown) => (insensitive && typeof v === "string" ? v.toLowerCase() : v);
  const encFold = (v: unknown) => fold(enc(v));

  const parts: string[] = [];
  for (const [op, v] of Object.entries(filter)) {
    if (v === undefined || op === "mode") continue;
    if (!SCALAR_OPS.has(op)) {
      throw new CyphraValidationError(`Unknown filter "${op}" on ${model.name}.${field.name}.`);
    }
    switch (op) {
      case "equals":
        parts.push(v === null ? `${ref} IS NULL` : `${lhs} = ${ctx.param(encFold(v))}`);
        break;
      case "not":
        if (v === null) parts.push(`${ref} IS NOT NULL`);
        else if (isPlainObject(v)) {
          const inner = compileScalarFilter(ctx, model, field, ref, v, mode);
          if (inner) parts.push(`NOT (${inner})`);
        } else parts.push(`${lhs} <> ${ctx.param(encFold(v))}`);
        break;
      case "in":
      case "notIn": {
        if (!Array.isArray(v)) throw new CyphraValidationError(`${op} expects an array.`);
        const p = ctx.param(v.map(encFold));
        parts.push(op === "in" ? `${lhs} IN ${p}` : `NOT ${lhs} IN ${p}`);
        break;
      }
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        const sym = { lt: "<", lte: "<=", gt: ">", gte: ">=" }[op];
        parts.push(`${ref} ${sym} ${ctx.param(enc(v))}`);
        break;
      }
      case "contains":
      case "startsWith":
      case "endsWith": {
        if (field.type !== "String" || typeof v !== "string") {
          throw new CyphraValidationError(`${op} is only valid on String fields.`);
        }
        const kw = { contains: "CONTAINS", startsWith: "STARTS WITH", endsWith: "ENDS WITH" }[op];
        parts.push(`${lhs} ${kw} ${ctx.param(fold(v))}`);
        break;
      }
    }
  }
  return and(parts);
}

function compileRelationFilter(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  rel: ResolvedRelationField,
  alias: string,
  filter: unknown,
): string | null {
  if (filter === undefined) return null;
  const target = ctx.node(rel.target);
  // Related nodes the rules hide are not there: no filter can probe them.
  const exists = (where: unknown): string => {
    const m = ctx.variable();
    const inner = scopedWhere(ctx, target, m, where);
    return `EXISTS { MATCH ${relationMatch(ctx, alias, rel, m, "", inner)} }`;
  };

  if (rel.many) {
    if (!isPlainObject(filter)) {
      throw new CyphraValidationError(
        `${model.name}.${rel.name}: to-many relation filters take { some, none, every }.`,
      );
    }
    const parts: string[] = [];
    for (const [op, v] of Object.entries(filter)) {
      if (v === undefined) continue;
      if (op === "some") parts.push(exists(v));
      else if (op === "none") parts.push(`NOT ${exists(v)}`);
      else if (op === "every") {
        // every(P) ≡ none(NOT P); an empty filter is vacuously true.
        const m = ctx.variable();
        const inner = compileWhere(ctx, target, m, v);
        if (inner) {
          const visible = and([ruleFilter(ctx, target, m), `NOT (${inner})`]);
          parts.push(`NOT EXISTS { MATCH ${relationMatch(ctx, alias, rel, m, "", visible)} }`);
        }
      } else throw new CyphraValidationError(`Unknown relation filter "${op}".`);
    }
    return and(parts);
  }

  if (filter === null) return `NOT ${exists(undefined)}`;
  if (!isPlainObject(filter)) {
    throw new CyphraValidationError(
      `${model.name}.${rel.name}: to-one relation filters take { is, isNot } or null.`,
    );
  }
  const parts: string[] = [];
  for (const [op, v] of Object.entries(filter)) {
    if (v === undefined) continue;
    if (op === "is") parts.push(v === null ? `NOT ${exists(undefined)}` : exists(v));
    else if (op === "isNot") parts.push(v === null ? exists(undefined) : `NOT ${exists(v)}`);
    else throw new CyphraValidationError(`Unknown relation filter "${op}".`);
  }
  return and(parts);
}

/**
 * `__typename` in the `where` of an interface: the implementations to keep, by label. Takes a
 * name, or `{ equals, not, in, notIn }`.
 */
function compileTypenameFilter(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  alias: string,
  filter: unknown,
): string | null {
  if (!model.abstract) {
    throw new CyphraValidationError(
      `where.__typename: ${model.name} is not an interface or a union (only their queries filter by implementation).`,
    );
  }
  const impls = model.implementations ?? [];
  const label = (v: unknown, op: string) => {
    if (typeof v !== "string" || !impls.includes(v)) {
      throw new CyphraValidationError(
        `where.__typename${op ? `.${op}` : ""} on ${model.name}: expected ${impls.length ? impls.map((i) => JSON.stringify(i)).join(" | ") : "an implementation (it has none)"}, got ${JSON.stringify(v)}.`,
      );
    }
    return `${alias}:${q(ctx.node(v).label)}`;
  };
  const anyOf = (v: unknown, op: string) => {
    if (!Array.isArray(v))
      throw new CyphraValidationError(`where.__typename.${op} expects an array.`);
    const labels = v.map((x) => label(x, op));
    if (labels.length === 0) return "false";
    return labels.length === 1 ? labels[0]! : labels.map((x) => `(${x})`).join(" OR ");
  };
  if (filter === null) {
    throw new CyphraValidationError(`where.__typename on ${model.name} cannot be null.`);
  }
  if (!isPlainObject(filter)) return label(filter, "");
  const parts: string[] = [];
  for (const [op, v] of Object.entries(filter)) {
    if (v === undefined) continue;
    if (op === "equals") parts.push(label(v, op));
    else if (op === "not") parts.push(`NOT (${label(v, op)})`);
    else if (op === "in") parts.push(anyOf(v, op));
    else if (op === "notIn") parts.push(`NOT (${anyOf(v, op)})`);
    else {
      throw new CyphraValidationError(
        `Unknown filter "${op}" on ${model.name}.__typename (use equals, not, in, notIn).`,
      );
    }
  }
  return and(parts);
}

/**
 * `$on` in the `where` of an interface or a union: `{ Post: { … }, User: {} }` keeps the nodes of
 * the listed implementations that match their filter (each the `where` of that model):
 * `(n:Post AND …) OR (n:User)`. Implementations not listed are left out; an empty `$on` matches
 * nothing.
 */
function compileOnFilter(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  alias: string,
  filter: unknown,
): string {
  const impls = memberNames(model);
  if (!model.abstract) {
    throw new CyphraValidationError(
      `where.$on: ${model.name} is not an interface or a union ($on filters per implementation of their queries).`,
    );
  }
  if (!isPlainObject(filter)) {
    throw new CyphraValidationError(
      `where.$on on ${model.name} takes { <${model.union ? "member" : "implementation"}>: { … } }.`,
    );
  }
  const branches: string[] = [];
  for (const [name, sub] of Object.entries(filter)) {
    if (sub === undefined) continue;
    if (!impls.includes(name)) {
      throw new CyphraValidationError(
        `where.$on.${name}: not ${model.union ? "a member" : "an implementation"} of ${model.name} (${impls.length ? impls.join(", ") : "it has none"}).`,
      );
    }
    if (!isPlainObject(sub)) {
      throw new CyphraValidationError(
        `where.$on.${name} takes the where of ${name} ({} for every ${name}).`,
      );
    }
    const impl = ctx.node(name);
    const inner = compileWhere(ctx, impl, alias, sub);
    branches.push(and([`${alias}:${q(impl.label)}`, inner])!);
  }
  if (branches.length === 0) return "false";
  return branches.length === 1 ? branches[0]! : branches.map((b) => `(${b})`).join(" OR ");
}

/**
 * Compile a `where` object for node variable `alias` into a Cypher predicate (or `null` if empty).
 */
export function compileWhere(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  alias: string,
  where: unknown,
): string | null {
  if (where === undefined || where === null) return null;
  if (!isPlainObject(where)) {
    throw new CyphraValidationError(`where on ${model.name} must be an object.`);
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === "AND" || key === "OR" || key === "NOT") {
      const list = Array.isArray(value) ? value : [value];
      const compiled = list
        .map((w) => compileWhere(ctx, model, alias, w))
        .filter((x): x is string => Boolean(x));
      if (key === "AND") {
        const a = and(compiled);
        if (a) parts.push(a);
      } else if (key === "OR") {
        // An empty OR matches nothing (same as Prisma); an OR with an empty branch matches all.
        if (list.length === 0) parts.push("false");
        else if (compiled.length === list.length) {
          parts.push(compiled.map((x) => `(${x})`).join(" OR "));
        }
      } else {
        for (const c of compiled) parts.push(`NOT (${c})`);
      }
      continue;
    }
    if (key === "__typename") {
      const c = compileTypenameFilter(ctx, model, alias, value);
      if (c) parts.push(c);
      continue;
    }
    if (key === "$labels") {
      const c = compileLabelsFilter(model, alias, value);
      if (c) parts.push(c);
      continue;
    }
    if (key === "$on") {
      parts.push(compileOnFilter(ctx, model, alias, value));
      continue;
    }
    const f = model.fields.find((x) => x.name === key);
    if (!f) throw new CyphraValidationError(`Unknown field "${model.name}.${key}" in where.`);
    const c =
      f.kind === "scalar"
        ? compileScalarFilter(ctx, model, f, `${alias}.${q(f.name)}`, value)
        : compileRelationFilter(ctx, model, f, alias, value);
    if (c) parts.push(c);
  }
  return and(parts);
}

/** The predicate of one rule value on `model` (`null`: no restriction). */
function compileRule(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  alias: string,
  rule: RuleValue,
): string | null {
  if (rule === true) return null;
  if (rule === false) return "false";
  ctx.ruleDepth++;
  try {
    return compileWhere(ctx, model, alias, rule);
  } finally {
    ctx.ruleDepth--;
  }
}

/** The rules of `op` on the model `name` itself, as predicates on `alias`. */
function ownRules(ctx: QueryContext, name: string, alias: string, op: RuleOperation): string[] {
  const out: string[] = [];
  for (const set of ctx.rules) {
    const rule = set[name]?.[op];
    if (rule === undefined) continue;
    const c = compileRule(ctx, ctx.node(name), alias, rule);
    if (c) out.push(c);
  }
  return out;
}

/**
 * The rules of `op` that apply to a node of `model` bound to `alias`, as one predicate (`null`:
 * none). A node is subject to the rules of its model and of every interface it implements; matched
 * through an interface or a union, each implementation's own rules apply to its nodes
 * (`NOT n:Post OR <Post rule>`). A rule's `where` is trusted: rules do not apply inside it.
 */
export function ruleFilter(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  alias: string,
  op: RuleOperation = "read",
): string | null {
  if (ctx.rules.length === 0 || ctx.ruleDepth > 0) return null;
  if (!model.abstract) {
    const parts = [model.name, ...(model.interfaces ?? [])].flatMap((n) =>
      ownRules(ctx, n, alias, op),
    );
    return and(parts);
  }
  const parts = ownRules(ctx, model.name, alias, op);
  for (const name of model.implementations ?? []) {
    const impl = ctx.node(name);
    const names = [impl.name, ...(impl.interfaces ?? [])].filter((n) => n !== model.name);
    const own = and(names.flatMap((n) => ownRules(ctx, n, alias, op)));
    if (own) parts.push(`NOT ${alias}:${q(impl.label)} OR (${own})`);
  }
  return and(parts);
}

/**
 * The `where` of a place that matches nodes of `model` (a root, a relation load, a relation
 * filter, a count, a write target): the rules of `op` on it (see {@link ruleFilter}) AND `where`.
 */
export function scopedWhere(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  alias: string,
  where: unknown,
  op: RuleOperation = "read",
): string | null {
  return and([ruleFilter(ctx, model, alias, op), compileWhere(ctx, model, alias, where)]);
}

/**
 * `COUNT { MATCH (alias)-[:T]->(m:Target) WHERE … }`: the number of nodes related to `alias`
 * through the to-many relation `rel`, optionally filtered by a `where` on the related node.
 */
export function compileRelationCount(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  alias: string,
  rel: ResolvedRelationField,
  where?: unknown,
): string {
  if (!rel.many) {
    throw new CyphraValidationError(
      `${model.name}.${rel.name} is a to-one relation; only to-many relations can be counted.`,
    );
  }
  const m = ctx.variable();
  const inner = scopedWhere(ctx, ctx.node(rel.target), m, where);
  return `COUNT { MATCH ${relationMatch(ctx, alias, rel, m, "", inner)} }`;
}

function sortDirection(dir: unknown, what: string): string {
  if (dir !== "asc" && dir !== "desc") {
    throw new CyphraValidationError(`orderBy ${what} must be "asc" or "desc".`);
  }
  return dir.toUpperCase();
}

/** Scalar types without a meaningful sort order (points sort by distance instead). */
const UNSORTABLE = new Set(["Vector", "Json", "Duration", "Point", "CartesianPoint"]);

/**
 * `{ distanceFrom: <point>, sort?: "asc" | "desc" }` on a point field: `point.distance(…) ASC`
 * (nearest first by default; nodes without the property, or with a point of another CRS, last).
 */
function compileDistanceOrder(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  alias: string,
  field: ResolvedScalarField,
  dir: unknown,
): { expr: string; dir: "ASC" | "DESC" } {
  const where = `orderBy ${model.name}.${field.name}`;
  if (
    !isPlainObject(dir) ||
    !isPointValue(field.type, dir.distanceFrom) ||
    Object.keys(dir).some((k) => k !== "distanceFrom" && k !== "sort")
  ) {
    throw new CyphraValidationError(
      `${where}: point fields sort by distance: { distanceFrom: <point>, sort?: "asc" | "desc" }.`,
    );
  }
  const from = ctx.param(encodeFilterValue(field, dir.distanceFrom, model.name));
  const d = dir.sort === undefined ? "ASC" : sortDirection(dir.sort, `${model.name}.${field.name}`);
  return { expr: `point.distance(${alias}.${q(field.name)}, ${from})`, dir: d as "ASC" | "DESC" };
}

/**
 * `head(COLLECT { MATCH (alias)<-[:T]-(m:Target) RETURN m.field })`: the value of a scalar of the
 * node related to `alias` through the to-one relation `rel` (`null` when there is none, or when the
 * rules hide it).
 */
function compileRelatedScalar(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  alias: string,
  rel: ResolvedRelationField,
  name: string,
): { expr: string; field: ResolvedScalarField; owner: string } {
  const target = ctx.node(rel.target);
  const f = scalarField(target, name);
  if (!f) {
    throw new CyphraValidationError(
      `orderBy ${model.name}.${rel.name}: unknown scalar field "${target.name}.${name}".`,
    );
  }
  if (UNSORTABLE.has(f.type) || f.list) {
    throw new CyphraValidationError(
      `orderBy ${model.name}.${rel.name}.${name}: list, Vector, Json, Duration and point fields cannot be sorted.`,
    );
  }
  const m = ctx.variable();
  const w = ruleFilter(ctx, target, m);
  return {
    expr: `head(COLLECT { MATCH ${relationMatch(ctx, alias, rel, m, "", w)} RETURN ${m}.${q(name)} })`,
    field: f,
    owner: target.name,
  };
}

/**
 * `CASE WHEN n:A THEN 'A' … ELSE 'Interface' END`: the `__typename` of an interface's node, as
 * its results report it (sorting by implementation name).
 */
function typenameExpr(ctx: QueryContext, model: ResolvedNodeModel, alias: string): string {
  if (!model.abstract) {
    throw new CyphraValidationError(
      `orderBy __typename: ${model.name} is not an interface or a union (only their queries sort by implementation).`,
    );
  }
  const whens = (model.implementations ?? []).map(
    (i) => `WHEN ${alias}:${q(ctx.node(i).label)} THEN ${ctx.param(i)}`,
  );
  const fallback = ctx.param(model.name);
  return whens.length ? `CASE ${whens.join(" ")} ELSE ${fallback} END` : fallback;
}

/**
 * How the value of a sort key is read back and bound again (keyset cursors): a scalar field's
 * value, a relation count, a text (`__typename`, an element id) or a number (a distance).
 */
export type SortKeyValue =
  | { readonly kind: "scalar"; readonly field: ResolvedScalarField; readonly owner: string }
  | { readonly kind: "count" }
  | { readonly kind: "text" }
  | { readonly kind: "number" };

/** One key of an `ORDER BY`: a Cypher expression on the node, its direction and its value kind. */
export type SortKey = {
  readonly expr: string;
  readonly dir: "ASC" | "DESC";
  readonly value: SortKeyValue;
};

/**
 * Compile `orderBy` into `a.x ASC, a.y DESC` (or `null`). A to-many relation sorts by its number
 * of related nodes: `{ posts: { _count: "desc" } }`, optionally only those matching a filter
 * (`{ posts: { _count: "desc", where: { published: true } } }`); a to-one relation by a scalar of
 * the related node: `{ author: { name: "asc" } }` (nodes without one sort as `null`: last ascending).
 */
export function compileOrderBy(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  alias: string,
  orderBy: unknown,
): string | null {
  const keys = compileSortKeys(ctx, model, alias, orderBy);
  return keys.length ? keys.map((k) => `${k.expr} ${k.dir}`).join(", ") : null;
}

/** The keys of `orderBy`, in order (see {@link compileOrderBy}). */
export function compileSortKeys(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  alias: string,
  orderBy: unknown,
): SortKey[] {
  if (orderBy === undefined || orderBy === null) return [];
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  const keys: SortKey[] = [];
  const dirOf = (d: unknown, what: string) => sortDirection(d, what) as "ASC" | "DESC";
  for (const item of list) {
    if (!isPlainObject(item)) throw new CyphraValidationError("orderBy entries must be objects.");
    for (const [key, dir] of Object.entries(item)) {
      if (dir === undefined) continue;
      if (key === "__typename") {
        keys.push({
          expr: typenameExpr(ctx, model, alias),
          dir: dirOf(dir, `${model.name}.__typename`),
          value: { kind: "text" },
        });
        continue;
      }
      const rel = relationField(model, key);
      if (rel && !rel.many) {
        if (!isPlainObject(dir)) {
          throw new CyphraValidationError(
            `orderBy ${model.name}.${key} takes { <field>: "asc" | "desc" }.`,
          );
        }
        for (const [name, d] of Object.entries(dir)) {
          if (d === undefined) continue;
          if (name === "_count") {
            throw new CyphraValidationError(
              `${model.name}.${key} is a to-one relation; only to-many relations can be counted.`,
            );
          }
          const related = compileRelatedScalar(ctx, model, alias, rel, name);
          keys.push({
            expr: related.expr,
            dir: dirOf(d, `${model.name}.${key}.${name}`),
            value: { kind: "scalar", field: related.field, owner: related.owner },
          });
        }
        continue;
      }
      if (rel) {
        if (!isPlainObject(dir) || Object.keys(dir).some((k) => k !== "_count" && k !== "where")) {
          throw new CyphraValidationError(
            `orderBy ${model.name}.${key} takes { _count: "asc" | "desc", where? }.`,
          );
        }
        if (dir._count === undefined) continue;
        const d = dirOf(dir._count, `${model.name}.${key}._count`);
        keys.push({
          expr: compileRelationCount(ctx, model, alias, rel, dir.where),
          dir: d,
          value: { kind: "count" },
        });
        continue;
      }
      const sortField = scalarOrThrow(model, key);
      const sortType = sortField.type;
      if ((sortType === "Point" || sortType === "CartesianPoint") && !sortField.list) {
        keys.push({
          ...compileDistanceOrder(ctx, model, alias, sortField, dir),
          value: { kind: "number" },
        });
        continue;
      }
      if (UNSORTABLE.has(sortType)) {
        throw new CyphraValidationError(
          `orderBy ${model.name}.${key}: ${sortType} fields cannot be sorted.`,
        );
      }
      keys.push({
        expr: `${alias}.${q(key)}`,
        dir: dirOf(dir, `${model.name}.${key}`),
        value: { kind: "scalar", field: sortField, owner: model.name },
      });
    }
  }
  return keys;
}

export function nonNegativeInt(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new CyphraValidationError(`${name} must be a non-negative integer.`);
  }
  return v;
}

/** `ORDER BY … SKIP … LIMIT …` suffix for a `WITH`, or `""`. */
export function compilePaging(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  alias: string,
  args: { orderBy?: unknown; skip?: unknown; take?: unknown },
): string {
  let s = "";
  const order = compileOrderBy(ctx, model, alias, args.orderBy);
  if (order) s += ` ORDER BY ${order}`;
  if (args.skip !== undefined)
    s += ` SKIP ${ctx.param(intParam(nonNegativeInt(args.skip, "skip")))}`;
  if (args.take !== undefined)
    s += ` LIMIT ${ctx.param(intParam(nonNegativeInt(args.take, "take")))}`;
  return s;
}

// SKIP/LIMIT must be integers on the wire; the driver sends JS numbers as floats.
export function intParam(n: number): unknown {
  return new CypherInteger(n);
}

// ---------------------------------------------------------------------------
// Projection (select / include) and decoding
// ---------------------------------------------------------------------------

/** One implementation of an interface, in the {@link Shape} of an interface query. */
export type ShapeVariant = {
  readonly name: string;
  readonly label: string;
  /** Its scalars to decode (absent with `select`: the selected interface fields). */
  readonly scalars?: readonly ResolvedScalarField[];
  /** What `$on: { <name>: … }` loads for it, projected under {@link onKey} (absent: nothing). */
  readonly on?: Shape;
};

/**
 * Key of the labels projected next to a node's properties: on an interface to pick `__typename`,
 * and when `$labels` is selected.
 */
const LABELS_KEY = "__labels";

/** Key of what `$on` loads for the implementation `name`, in an interface's projection. */
function onKey(name: string): string {
  return `__on_${name}`;
}

/** How to decode one projected row back into JS. */
export type Shape = {
  readonly model: ResolvedNodeModel;
  readonly scalars: readonly ResolvedScalarField[];
  /**
   * On an interface: its implementations. The row then carries the node's labels, the result a
   * `__typename` and (without `select`) the scalars of the implementation it is.
   */
  readonly variants?: readonly ShapeVariant[];
  readonly relations: readonly {
    /** The key of the result (the relation's name, or the alias of an aliased load). */
    readonly key: string;
    readonly field: ResolvedRelationField;
    readonly shape: Shape;
    readonly edge?: readonly ResolvedScalarField[];
  }[];
  /** Relations counted under `_count` (absent: no `_count` key in the result). */
  readonly counts?: readonly ResolvedRelationField[];
  /** `true` when `$labels` is selected: the result gets the node's dynamic labels. */
  readonly labels?: true;
  /**
   * `true`: scalars and edge properties are returned as the driver gives them (`Integer`,
   * temporal and point objects, `null` lists), not decoded for their schema type.
   */
  readonly raw?: true;
};

type LoadArgs = {
  where?: unknown;
  orderBy?: unknown;
  skip?: unknown;
  take?: unknown;
  select?: unknown;
  include?: unknown;
};

/**
 * Build the projection expression for `alias` (a map projection with nested `COLLECT {}`
 * subqueries for loaded relations) and the matching decode {@link Shape}.
 */
export function compileProjection(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  alias: string,
  args: LoadArgs,
  extraEntries: readonly string[] = [],
): { expr: string; shape: Shape } {
  if (args.select !== undefined && args.include !== undefined) {
    throw new CyphraValidationError("Use either select or include, not both.");
  }
  const scalars: ResolvedScalarField[] = [];
  const rels: { key: string; field: ResolvedRelationField; args: LoadArgs }[] = [];
  const allScalars = model.fields.filter((f): f is ResolvedScalarField => f.kind === "scalar");
  let counts: { field: ResolvedRelationField; where: unknown }[] | undefined;
  let on: { spec: AnyRecord; label: string } | undefined;
  let withLabels = false;

  const takeRelations = (spec: AnyRecord, label: string) => {
    for (const [key, v] of Object.entries(spec)) {
      if (v === undefined || v === false) continue;
      if (key === "_count") {
        counts = relationCounts(model, v, label);
        continue;
      }
      if (key === "$labels") {
        if (v !== true) throw new CyphraValidationError(`${label}.$labels takes true.`);
        if (dynamicLabelsOf(model).length === 0) {
          throw new CyphraValidationError(
            `${label}.$labels: ${model.name} declares no dynamic labels (add @@labels([…]) to the model).`,
          );
        }
        withLabels = true;
        continue;
      }
      if (key === "$on") {
        if (!model.abstract) {
          throw new CyphraValidationError(
            `${label}.$on: ${model.name} is not an interface or a union ($on loads per-implementation fields of their queries).`,
          );
        }
        if (!isPlainObject(v)) {
          throw new CyphraValidationError(
            `${label}.$on on ${model.name} takes { <implementation>: { … } }.`,
          );
        }
        on = { spec: v, label };
        continue;
      }
      if (isPlainObject(v) && v.$relation !== undefined) {
        rels.push(aliasedLoad(ctx, model, key, v, label));
        continue;
      }
      const f = model.fields.find((x) => x.name === key);
      if (!f) throw new CyphraValidationError(`Unknown field "${model.name}.${key}" in ${label}.`);
      if (f.kind === "scalar") {
        if (label === "include") {
          throw new CyphraValidationError(`include only takes relations ("${key}" is a scalar).`);
        }
        scalars.push(f);
      } else {
        rels.push({ key, field: f, args: isPlainObject(v) ? (v as LoadArgs) : {} });
      }
    }
  };

  if (args.select !== undefined) {
    if (!isPlainObject(args.select)) throw new CyphraValidationError("select must be an object.");
    takeRelations(args.select, "select");
  } else {
    scalars.push(...allScalars);
    if (args.include !== undefined) {
      if (!isPlainObject(args.include))
        throw new CyphraValidationError("include must be an object.");
      takeRelations(args.include, "include");
    }
  }

  // An interface reads the fields of every implementation (without `select`) and the labels that
  // tell which one each node is.
  let variants: ShapeVariant[] | undefined;
  let projected: readonly ResolvedScalarField[] = scalars;
  if (model.abstract) {
    const selected = args.select !== undefined;
    variants = (model.implementations ?? []).map((name) => {
      const impl = ctx.node(name);
      const own = impl.fields.filter((f): f is ResolvedScalarField => f.kind === "scalar");
      return selected ? { name, label: impl.label } : { name, label: impl.label, scalars: own };
    });
    if (!selected) {
      const names = new Set(scalars.map((f) => f.name));
      const extra = variants
        .flatMap((v) => v.scalars ?? [])
        .filter((f) => {
          if (names.has(f.name)) return false;
          names.add(f.name);
          return true;
        });
      projected = [...scalars, ...extra];
    }
  }
  const entries: string[] = projected.map((f) => `.${q(f.name)}`);
  if (variants || withLabels) entries.push(`${q(LABELS_KEY)}: labels(${alias})`);
  if (on && variants) {
    const { label } = on;
    const impls = memberNames(model);
    for (const [name, sub] of Object.entries(expandInterfaceMembers(ctx, model, on.spec))) {
      if (sub === undefined || sub === false) continue;
      const i = variants.findIndex((v) => v.name === name);
      if (i < 0) {
        throw new CyphraValidationError(
          `${label}.$on.${name}: not ${model.union ? "a member" : "an implementation"} of ${model.name} (${impls.length ? impls.join(", ") : "it has none"}).`,
        );
      }
      if (!isPlainObject(sub)) {
        throw new CyphraValidationError(
          `${label}.$on.${name} takes the ${label} of ${name} ({ <field>: true | { … } }).`,
        );
      }
      const impl = ctx.node(name);
      if (label === "include") {
        for (const [key, v] of Object.entries(sub)) {
          if (v === undefined || v === false || key === "_count" || key === "$labels") continue;
          const f = impl.fields.find((x) => x.name === key);
          if (!f) throw new CyphraValidationError(`Unknown field "${name}.${key}" in include.$on.`);
          if (f.kind === "scalar") {
            throw new CyphraValidationError(
              `include only takes relations ("${key}" is a scalar; use select.$on.${name} to pick it).`,
            );
          }
        }
      }
      // The implementation's own projection of the same node, evaluated only on its nodes.
      const p = compileProjection(ctx, impl, alias, { select: sub });
      entries.push(`${q(onKey(name))}: CASE WHEN ${alias}:${q(impl.label)} THEN ${p.expr} END`);
      variants[i] = { ...variants[i]!, on: p.shape };
    }
  }
  const relShapes: Shape["relations"][number][] = [];
  for (const { key, field, args: sub } of rels) {
    const target = ctx.node(field.target);
    const m = ctx.variable();
    const r = ctx.variable("r");
    const edgeModel = field.edge
      ? ctx.schema.relationships.find((x) => x.name === field.edge)
      : undefined;
    const inner = compileProjection(
      ctx,
      target,
      m,
      sub,
      edgeModel ? [`${q("$edge")}: properties(${r})`] : [],
    );
    const item = inner.expr;
    const where = scopedWhere(ctx, target, m, sub.where);
    const paging = compilePaging(ctx, target, m, sub);
    let body = `MATCH ${relationMatch(ctx, alias, field, m, r, where)}`;
    if (paging) body += ` WITH ${m}, ${r}${paging}`;
    body += ` RETURN ${item}`;
    const collected = `COLLECT { ${body} }`;
    entries.push(`${q(key)}: ${field.many ? collected : `head(${collected})`}`);
    relShapes.push({
      key,
      field,
      shape: inner.shape,
      ...(edgeModel ? { edge: edgeModel.properties } : {}),
    });
  }
  if (counts) {
    const map = counts.map(
      ({ field, where }) =>
        `${q(field.name)}: ${compileRelationCount(ctx, model, alias, field, where)}`,
    );
    entries.push(`${q("_count")}: {${map.join(", ")}}`);
  }
  entries.push(...extraEntries);
  return {
    expr: `${alias}{${entries.join(", ")}}`,
    shape: {
      model,
      scalars,
      ...(variants ? { variants } : {}),
      relations: relShapes,
      ...(counts ? { counts: counts.map((c) => c.field) } : {}),
      ...(withLabels ? { labels: true as const } : {}),
      ...(ctx.raw ? { raw: true as const } : {}),
    },
  };
}

/**
 * An aliased relation load (internal, not in the client's types): `select: { recent: { $relation:
 * "posts", take: 3 } }` loads `posts` under the key `recent`, so that one projection can load the
 * same relation several times with different arguments (GraphQL aliases). The alias cannot be a
 * scalar field of the model or a reserved key (`_count`, `$…`, `__…`).
 */
function aliasedLoad(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  key: string,
  spec: AnyRecord,
  label: string,
): { key: string; field: ResolvedRelationField; args: LoadArgs } {
  const { $relation, ...args } = spec;
  if (typeof $relation !== "string") {
    throw new CyphraValidationError(`${label}.${key}.$relation must be a relation name.`);
  }
  const field = relationField(model, $relation);
  if (!field) {
    throw new CyphraValidationError(
      `${label}.${key}.$relation: "${$relation}" is not a relation of ${model.name}.`,
    );
  }
  const scalarNames = [model, ...(model.implementations ?? []).map((i) => ctx.node(i))].flatMap(
    (m) => m.fields.filter((f) => f.kind === "scalar").map((f) => f.name),
  );
  if (
    key === "_count" ||
    key.startsWith("$") ||
    key.startsWith("__") ||
    scalarNames.includes(key)
  ) {
    throw new CyphraValidationError(
      `${label}.${key}: "${key}" cannot alias a relation load (it is ${scalarNames.includes(key) ? `a scalar field of ${model.name}` : "a reserved key"}).`,
    );
  }
  return { key, field, args: args as LoadArgs };
}

/**
 * Parse `_count` in `select` / `include`: `true` counts every to-many relation;
 * `{ select: { posts: true, comments: { where } } }` counts the listed ones.
 */
function relationCounts(
  model: ResolvedNodeModel,
  spec: unknown,
  label: string,
): { field: ResolvedRelationField; where: unknown }[] {
  if (spec === true) {
    return model.fields
      .filter((f): f is ResolvedRelationField => f.kind === "relation" && f.many)
      .map((field) => ({ field, where: undefined }));
  }
  if (!isPlainObject(spec) || Object.keys(spec).some((k) => k !== "select")) {
    throw new CyphraValidationError(
      `${label}._count on ${model.name} takes true or { select: { <relation>: true | { where } } }.`,
    );
  }
  if (!isPlainObject(spec.select)) {
    throw new CyphraValidationError(`${label}._count.select on ${model.name} must be an object.`);
  }
  const out: { field: ResolvedRelationField; where: unknown }[] = [];
  for (const [key, v] of Object.entries(spec.select)) {
    if (v === undefined || v === false) continue;
    const field = relationField(model, key);
    if (!field) {
      throw new CyphraValidationError(
        `Unknown relation "${model.name}.${key}" in ${label}._count.select.`,
      );
    }
    if (!field.many) {
      throw new CyphraValidationError(
        `${model.name}.${key} is a to-one relation; only to-many relations can be counted.`,
      );
    }
    if (v === true) out.push({ field, where: undefined });
    else if (isPlainObject(v) && Object.keys(v).every((k) => k === "where")) {
      out.push({ field, where: v.where });
    } else {
      throw new CyphraValidationError(
        `${label}._count.select.${key} on ${model.name} takes true or { where }.`,
      );
    }
  }
  return out;
}

/**
 * `select.$on` / `include.$on` of a union with interface members: `{ Person: … }` applies to every
 * implementation of `Person` that the spec does not list itself.
 */
function expandInterfaceMembers(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  spec: AnyRecord,
): AnyRecord {
  if (!model.members) return spec;
  const out: AnyRecord = {};
  for (const [name, sub] of Object.entries(spec)) {
    const m = model.members.includes(name) ? ctx.node(name) : undefined;
    if (!m?.abstract) {
      out[name] = sub;
      continue;
    }
    for (const impl of m.implementations ?? []) if (!(impl in spec)) out[impl] = sub;
  }
  return out;
}

/** A scalar of a {@link Shape.raw} projection: the driver's value (`null` when absent). */
function rawScalar(_field: ResolvedScalarField, value: unknown): unknown {
  return value ?? null;
}

/** Decode a projected map according to its {@link Shape}. */
export function decodeRow(shape: Shape, row: unknown): AnyRecord | null {
  if (row === null || row === undefined) return null;
  const src = row as AnyRecord;
  const out: AnyRecord = {};
  let scalars = shape.scalars;
  /** What `$on` loaded for the node's implementation, merged into the result last. */
  let on: AnyRecord | null = null;
  if (shape.variants) {
    // The implementation whose label the node carries; a node with none of them (written outside
    // Cyphra) is reported as the interface itself, with the interface's fields.
    const labels = (src[LABELS_KEY] ?? []) as unknown[];
    const variant = shape.variants.find((v) => labels.includes(v.label));
    // Through a union's interface member, such a node is reported as that interface.
    const member = shape.model.members?.find((m) => labels.includes(m));
    out.__typename = variant?.name ?? member ?? shape.model.name;
    if (variant?.scalars) scalars = variant.scalars;
    if (variant?.on) on = decodeRow(variant.on, src[onKey(variant.name)]);
  }
  const decode = shape.raw ? rawScalar : decodeScalar;
  for (const f of scalars) out[f.name] = decode(f, src[f.name]);
  if (shape.labels) out.$labels = decodeDynamicLabels(shape.model, src[LABELS_KEY]);
  for (const r of shape.relations) {
    const decodeItem = (v: unknown) => {
      const item = decodeRow(r.shape, v);
      if (item && r.edge) {
        const rawEdge = ((v as AnyRecord)["$edge"] ?? {}) as AnyRecord;
        const edge: AnyRecord = {};
        for (const p of r.edge) edge[p.name] = decode(p, rawEdge[p.name]);
        item.$edge = edge;
      }
      return item;
    };
    const v = src[r.key];
    out[r.key] = r.field.many ? ((v as unknown[] | null) ?? []).map(decodeItem) : decodeItem(v);
  }
  if (shape.counts) {
    const raw = (src["_count"] ?? {}) as AnyRecord;
    const counts: AnyRecord = {};
    for (const f of shape.counts) counts[f.name] = decodeCount(raw[f.name]);
    out._count = counts;
  }
  if (on) {
    const { _count, ...rest } = on;
    Object.assign(out, rest);
    if (_count) out._count = { ...((out._count as AnyRecord | undefined) ?? {}), ..._count };
  }
  return out;
}
