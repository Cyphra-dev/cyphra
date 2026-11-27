/**
 * List aggregates (internal engine entries, not in the client's types): the aggregates of
 * `@cyphra/graphql`'s `compat.v7`, computed like `@neo4j/graphql` 7 computes them, so that a
 * request served by the engine answers exactly like the compat compiler.
 *
 * Each aggregate collects the non-null values of one field over a set of nodes or edges and reduces
 * the list with list expressions (`reduce`, `head`, `last`): `sum` of nothing is `0`, `min`, `max`
 * and `avg` of nothing are `null`, and `avg` is `toFloat(sum) / size`. Strings aggregate by length:
 * `longest` is the first of the values sorted by size (descending), `shortest` the last. Counts and
 * values run over distinct nodes (`nodes`) or distinct edges (`edges`).
 *
 * - `select: { key: { $aggregate: { $relation, where?, values } } }` projects, under `key`, a map
 *   of `values` over the nodes related through `$relation` that match `where` (which may filter on
 *   the edge, `$edge`). `values` maps each result key to `{ count: "nodes" | "edges" }`,
 *   `{ node: <field>, fn }` or `{ edge: <field>, fn }`, `fn` one of `min`, `max`, `sum`, `avg`,
 *   `shortest`, `longest`.
 * - `aggregate({ where, $values })` adds the same values (`count: "nodes"` and `node`) over the
 *   matched nodes, under `$values`.
 * - `where: { $aggregate: [{ relation, of, distinct?, field?, fn?, length?, op, value }] }` compares
 *   one aggregate of the related nodes (`of: "count" | "node" | "edge"`, `fn`: `min`, `max`, `sum`,
 *   `avg`) with a value (`op`: `eq`, `lt`, `lte`, `gt`, `gte`). Strings compare by length (unless
 *   `length: false`), `DateTime` values are parsed by `datetime()`; a `null` aggregate matches
 *   nothing, even under `NOT`.
 *
 * Values come back as the driver returns them (Neo4j `Integer`, temporal objects): the caller
 * decodes them.
 *
 * @packageDocumentation
 * @internal
 */

import type { ResolvedNodeModel, ResolvedScalarField } from "@cyphra/schema";
import {
  type QueryContext,
  and,
  edgeScope,
  labelExpr,
  q,
  relationField,
  relationMatch,
  relationPattern,
  scalarField,
  scopedWhere,
} from "./compile.js";
import { CyphraValidationError } from "./errors.js";

type AnyRecord = Record<string, unknown>;

const FNS = new Set(["min", "max", "sum", "avg", "shortest", "longest"]);
const FILTER_FNS = new Set(["min", "max", "sum", "avg"]);
const COMPARISONS: Record<string, string> = { eq: "=", lt: "<", lte: "<=", gt: ">", gte: ">=" };

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `min` / `max` / `sum` / `avg` of the list `l` as a plain expression (no aggregating function). */
function reduceList(fn: string, l: string): string {
  const sum = `reduce(acc = 0, x IN ${l} | acc + x)`;
  switch (fn) {
    case "min":
      return `reduce(acc = null, x IN ${l} | CASE WHEN acc IS NULL OR x < acc THEN x ELSE acc END)`;
    case "max":
      return `reduce(acc = null, x IN ${l} | CASE WHEN acc IS NULL OR x > acc THEN x ELSE acc END)`;
    case "sum":
      return sum;
    default:
      return `CASE size(${l}) WHEN 0 THEN null ELSE toFloat(${sum}) / size(${l}) END`;
  }
}

/** The nodes (or edges) an aggregate runs over: `MATCH <pattern> [WHERE …]`, its variables. */
type Base = {
  /** `MATCH …` (with its `WHERE`). */
  readonly match: string;
  readonly node: { readonly variable: string; readonly model: ResolvedNodeModel };
  readonly edge?: { readonly variable: string; readonly model: ResolvedNodeModel };
};

/** The field and variable an `{ node | edge: field }` value aggregates. */
function target(
  base: Base,
  on: "node" | "edge",
  name: unknown,
  at: string,
): { variable: string; field: ResolvedScalarField } {
  const scope = on === "node" ? base.node : base.edge;
  if (!scope) throw new CyphraValidationError(`${at}: the relation has no edge properties.`);
  const field = typeof name === "string" ? scalarField(scope.model, name) : undefined;
  if (!field) {
    throw new CyphraValidationError(`${at}: unknown field ${scope.model.name}.${String(name)}.`);
  }
  return { variable: scope.variable, field };
}

/** One value of `values` (see the module comment) over `base`, as an expression. */
function valueExpr(ctx: QueryContext, base: Base, spec: unknown, at: string): string {
  if (!isPlainObject(spec)) throw new CyphraValidationError(`${at} must be an object.`);
  if (spec.count !== undefined) {
    const v =
      spec.count === "nodes"
        ? base.node.variable
        : spec.count === "edges"
          ? base.edge?.variable
          : undefined;
    if (!v) throw new CyphraValidationError(`${at}.count takes "nodes" or "edges".`);
    return `COUNT { ${base.match} WITH DISTINCT ${v} RETURN ${v} }`;
  }
  const on = spec.node !== undefined ? "node" : spec.edge !== undefined ? "edge" : undefined;
  if (!on) throw new CyphraValidationError(`${at} takes { count }, { node, fn } or { edge, fn }.`);
  const fn = spec.fn;
  if (typeof fn !== "string" || !FNS.has(fn)) {
    throw new CyphraValidationError(`${at}.fn must be one of ${[...FNS].join(", ")}.`);
  }
  const { variable, field } = target(base, on, spec[on], at);
  const prop = `${variable}.${q(field.name)}`;
  const values = `${base.match} WITH DISTINCT ${variable} WHERE ${prop} IS NOT NULL`;
  const l = ctx.variable("l");
  if (fn === "shortest" || fn === "longest") {
    const list = `COLLECT { ${values} WITH ${variable} ORDER BY size(${prop}) DESC RETURN ${prop} }`;
    return `[${l} IN [${list}] | ${fn === "longest" ? `head(${l})` : `last(${l})`}][0]`;
  }
  return `[${l} IN [COLLECT { ${values} RETURN ${prop} }] | ${reduceList(fn, l)}][0]`;
}

/** `{ k: <value>, … }` of `values` over `base`. */
function valuesMap(ctx: QueryContext, base: Base, values: unknown, at: string): string {
  if (!isPlainObject(values)) throw new CyphraValidationError(`${at}.values must be an object.`);
  const entries = Object.entries(values)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${q(k)}: ${valueExpr(ctx, base, v, `${at}.values.${k}`)}`);
  return `{${entries.join(", ")}}`;
}

/**
 * `select: { key: { $aggregate: { $relation, where?, values } } }` on node variable `alias`: the
 * map of `values` over the related nodes.
 */
export function compileAggregateLoad(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  alias: string,
  spec: AnyRecord,
  at: string,
): string {
  const { $relation, where, values, ...rest } = spec;
  const extra = Object.keys(rest)[0];
  if (extra !== undefined) throw new CyphraValidationError(`${at}: unknown key "${extra}".`);
  const rel = typeof $relation === "string" ? relationField(model, $relation) : undefined;
  if (!rel) {
    throw new CyphraValidationError(
      `${at}.$relation: unknown relation ${model.name}.${String($relation)}.`,
    );
  }
  const m = ctx.variable();
  const r = ctx.variable("r");
  const edge = edgeScope(ctx, rel, m, r);
  const targetModel = ctx.node(rel.target);
  const w = scopedWhere(ctx, targetModel, m, where);
  const base: Base = {
    match: `MATCH ${relationMatch(ctx, alias, rel, m, r, w)}`,
    node: { variable: m, model: targetModel },
    edge: edge
      ? { variable: r, model: edge.model }
      : { variable: r, model: emptyEdge(rel.relType) },
  };
  return valuesMap(ctx, base, values, at);
}

/** The edge model of a relation without properties (it can only be counted). */
function emptyEdge(relType: string): ResolvedNodeModel {
  return { name: relType, label: relType, uniqueFields: [], fields: [] };
}

/**
 * `aggregate({ $values })`: the map of `values` over the nodes of `model` matching `where`, as an
 * expression of its own (it does not use the statement's variables).
 */
export function compileRootValues(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  where: unknown,
  values: unknown,
): string {
  const v = ctx.variable("v");
  const w = scopedWhere(ctx, model, v, where);
  const base: Base = {
    match: `MATCH (${v}:${labelExpr(model)})${w ? ` WHERE ${w}` : ""}`,
    node: { variable: v, model },
  };
  for (const [k, spec] of Object.entries(isPlainObject(values) ? values : {})) {
    if (isPlainObject(spec) && (spec.edge !== undefined || spec.count === "edges")) {
      throw new CyphraValidationError(`aggregate.$values.${k}: nodes have no edge to aggregate.`);
    }
  }
  return valuesMap(ctx, base, values, "aggregate.$values");
}

/**
 * `where: { $aggregate: [...] }` on node variable `alias` (see the module comment): one predicate
 * per entry, ANDed.
 */
export function compileAggregateFilters(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  alias: string,
  value: unknown,
): string | null {
  const at = `${model.name}: where.$aggregate`;
  if (!Array.isArray(value)) throw new CyphraValidationError(`${at} takes [{ relation, of, … }].`);
  const parts = value.map((entry, i) => aggregateFilter(ctx, model, alias, entry, `${at}[${i}]`));
  return and(parts);
}

function aggregateFilter(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  alias: string,
  entry: unknown,
  at: string,
): string {
  if (!isPlainObject(entry)) throw new CyphraValidationError(`${at} must be an object.`);
  const rel = typeof entry.relation === "string" ? relationField(model, entry.relation) : undefined;
  if (!rel) {
    throw new CyphraValidationError(
      `${at}.relation: unknown relation ${model.name}.${String(entry.relation)}.`,
    );
  }
  const cmp = typeof entry.op === "string" ? COMPARISONS[entry.op] : undefined;
  if (!cmp) throw new CyphraValidationError(`${at}.op must be eq, lt, lte, gt or gte.`);
  const m = ctx.variable("n");
  const r = ctx.variable("r");
  const pattern = relationPattern(ctx, alias, rel, m, r);
  const distinct = entry.distinct === true;
  let expr: string;
  let field: ResolvedScalarField | undefined;
  if (entry.of === "count") {
    expr = distinct
      ? `COUNT { MATCH ${pattern} WITH DISTINCT ${m} RETURN ${m} }`
      : `COUNT { MATCH ${pattern} }`;
  } else if (entry.of === "node" || entry.of === "edge") {
    const edge = rel.edge ? ctx.schema.relationships.find((x) => x.name === rel.edge) : undefined;
    const owner =
      entry.of === "node"
        ? ctx.node(rel.target)
        : edge && { ...emptyEdge(edge.relType), fields: edge.properties };
    field = owner && typeof entry.field === "string" ? scalarField(owner, entry.field) : undefined;
    if (!field) throw new CyphraValidationError(`${at}.field: unknown ${entry.of} field.`);
    const fn = entry.fn;
    if (typeof fn !== "string" || !FILTER_FNS.has(fn)) {
      throw new CyphraValidationError(`${at}.fn must be one of ${[...FILTER_FNS].join(", ")}.`);
    }
    const v = entry.of === "node" ? m : r;
    const prop = `${v}.${q(field.name)}`;
    // Strings compare by length (`length: false`: as they are).
    const length = typeof entry.length === "boolean" ? entry.length : field.type === "String";
    const item = length ? `size(${prop})` : prop;
    const dedupe = distinct ? ` WITH DISTINCT ${v}` : "";
    const list = `COLLECT { MATCH ${pattern}${dedupe} WITH ${v} WHERE ${prop} IS NOT NULL RETURN ${item} }`;
    const l = ctx.variable("l");
    expr = `[${l} IN [${list}] | ${reduceList(fn, l)}][0]`;
  } else {
    throw new CyphraValidationError(`${at}.of must be "count", "node" or "edge".`);
  }
  const p = ctx.param(entry.value ?? null);
  return `${expr} ${cmp} ${field?.type === "DateTime" ? `datetime(${p})` : p}`;
}
