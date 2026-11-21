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
import neo4j from "neo4j-driver";
import { CyphraValidationError } from "./errors.js";
import { decodeCount, decodeScalar, encodeFilterValue } from "./values.js";
import type { QueryMode } from "./types.js";

/** Quote an identifier for Cypher (labels, property keys, relationship types). */
export function q(id: string): string {
  return "`" + id.replace(/`/g, "``") + "`";
}

/** Collects parameters and fresh variable names for one statement. */
export class QueryContext {
  readonly params: Record<string, unknown> = {};
  private paramCount = 0;
  private varCount = 0;

  constructor(readonly schema: SchemaModel) {}

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

/** `(a)-[r:T]->(b:Label)` or `(a)<-[r:T]-(b:Label)`. */
export function relationPattern(
  ctx: QueryContext,
  from: string,
  rel: ResolvedRelationField,
  to: string,
  relVar = "",
): string {
  const target = ctx.node(rel.target);
  const edge = `[${relVar}:${q(rel.relType)}]`;
  const end = `(${to}:${q(target.label)})`;
  return rel.direction === "OUT" ? `(${from})-${edge}->${end}` : `(${from})<-${edge}-${end}`;
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

function and(parts: readonly string[]): string | null {
  const p = parts.filter(Boolean);
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
  if (field.list) return compileListFilter(ctx, model, field, ref, filter);
  const enc = (v: unknown) => encodeFilterValue(field, v, model.name);
  if (filter === null) return `${ref} IS NULL`;
  if (!isPlainObject(filter)) return `${ref} = ${ctx.param(enc(filter))}`;

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
  const exists = (where: unknown): string => {
    const m = ctx.variable();
    const pattern = relationPattern(ctx, alias, rel, m);
    const inner = where === undefined ? null : compileWhere(ctx, target, m, where);
    return inner ? `EXISTS { MATCH ${pattern} WHERE ${inner} }` : `EXISTS { MATCH ${pattern} }`;
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
          parts.push(
            `NOT EXISTS { MATCH ${relationPattern(ctx, alias, rel, m)} WHERE NOT (${inner}) }`,
          );
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
  const pattern = relationPattern(ctx, alias, rel, m);
  const inner = compileWhere(ctx, ctx.node(rel.target), m, where);
  return inner ? `COUNT { MATCH ${pattern} WHERE ${inner} }` : `COUNT { MATCH ${pattern} }`;
}

function sortDirection(dir: unknown, what: string): string {
  if (dir !== "asc" && dir !== "desc") {
    throw new CyphraValidationError(`orderBy ${what} must be "asc" or "desc".`);
  }
  return dir.toUpperCase();
}

/**
 * Compile `orderBy` into `a.x ASC, a.y DESC` (or `null`). A to-many relation sorts by its number
 * of related nodes: `{ posts: { _count: "desc" } }`.
 */
export function compileOrderBy(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  alias: string,
  orderBy: unknown,
): string | null {
  if (orderBy === undefined || orderBy === null) return null;
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  const parts: string[] = [];
  for (const item of list) {
    if (!isPlainObject(item)) throw new CyphraValidationError("orderBy entries must be objects.");
    for (const [key, dir] of Object.entries(item)) {
      if (dir === undefined) continue;
      const rel = relationField(model, key);
      if (rel) {
        if (!isPlainObject(dir) || Object.keys(dir).some((k) => k !== "_count")) {
          throw new CyphraValidationError(
            `orderBy ${model.name}.${key} takes { _count: "asc" | "desc" }.`,
          );
        }
        if (dir._count === undefined) continue;
        const d = sortDirection(dir._count, `${model.name}.${key}._count`);
        parts.push(`${compileRelationCount(ctx, model, alias, rel)} ${d}`);
        continue;
      }
      if (scalarOrThrow(model, key).type === "Vector") {
        throw new CyphraValidationError(
          `orderBy ${model.name}.${key}: Vector fields cannot be sorted.`,
        );
      }
      parts.push(`${alias}.${q(key)} ${sortDirection(dir, `${model.name}.${key}`)}`);
    }
  }
  return parts.length ? parts.join(", ") : null;
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
  return neo4j.int(n);
}

// ---------------------------------------------------------------------------
// Projection (select / include) and decoding
// ---------------------------------------------------------------------------

/** How to decode one projected row back into JS. */
export type Shape = {
  readonly model: ResolvedNodeModel;
  readonly scalars: readonly ResolvedScalarField[];
  readonly relations: readonly {
    readonly field: ResolvedRelationField;
    readonly shape: Shape;
    readonly edge?: readonly ResolvedScalarField[];
  }[];
  /** Relations counted under `_count` (absent: no `_count` key in the result). */
  readonly counts?: readonly ResolvedRelationField[];
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
  const rels: { field: ResolvedRelationField; args: LoadArgs }[] = [];
  const allScalars = model.fields.filter((f): f is ResolvedScalarField => f.kind === "scalar");
  let counts: { field: ResolvedRelationField; where: unknown }[] | undefined;

  const takeRelations = (spec: AnyRecord, label: string) => {
    for (const [key, v] of Object.entries(spec)) {
      if (v === undefined || v === false) continue;
      if (key === "_count") {
        counts = relationCounts(model, v, label);
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
        rels.push({ field: f, args: isPlainObject(v) ? (v as LoadArgs) : {} });
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

  const entries: string[] = scalars.map((f) => `.${q(f.name)}`);
  const relShapes: Shape["relations"][number][] = [];
  for (const { field, args: sub } of rels) {
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
    const where = compileWhere(ctx, target, m, sub.where);
    const paging = compilePaging(ctx, target, m, sub);
    let body = `MATCH ${relationPattern(ctx, alias, field, m, r)}`;
    if (where) body += ` WHERE ${where}`;
    if (paging) body += ` WITH ${m}, ${r}${paging}`;
    body += ` RETURN ${item}`;
    const collected = `COLLECT { ${body} }`;
    entries.push(`${q(field.name)}: ${field.many ? collected : `head(${collected})`}`);
    relShapes.push({
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
      relations: relShapes,
      ...(counts ? { counts: counts.map((c) => c.field) } : {}),
    },
  };
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

/** Decode a projected map according to its {@link Shape}. */
export function decodeRow(shape: Shape, row: unknown): AnyRecord | null {
  if (row === null || row === undefined) return null;
  const src = row as AnyRecord;
  const out: AnyRecord = {};
  for (const f of shape.scalars) out[f.name] = decodeScalar(f, src[f.name]);
  for (const r of shape.relations) {
    const decodeItem = (v: unknown) => {
      const item = decodeRow(r.shape, v);
      if (item && r.edge) {
        const rawEdge = ((v as AnyRecord)["$edge"] ?? {}) as AnyRecord;
        const edge: AnyRecord = {};
        for (const p of r.edge) edge[p.name] = decodeScalar(p, rawEdge[p.name]);
        item.$edge = edge;
      }
      return item;
    };
    const v = src[r.field.name];
    out[r.field.name] = r.field.many
      ? ((v as unknown[] | null) ?? []).map(decodeItem)
      : decodeItem(v);
  }
  if (shape.counts) {
    const raw = (src["_count"] ?? {}) as AnyRecord;
    const counts: AnyRecord = {};
    for (const f of shape.counts) counts[f.name] = decodeCount(raw[f.name]);
    out._count = counts;
  }
  return out;
}
