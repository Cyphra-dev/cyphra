/**
 * Compiles `aggregate` and `groupBy` arguments into one Cypher statement each.
 *
 * Same rules as `compile.ts`: values are parameters, identifiers come from the resolved schema and
 * are backtick-quoted, and unknown fields or aggregates that do not fit a field's type are rejected
 * with a {@link CyphraValidationError}.
 *
 * @packageDocumentation
 */

import type { ResolvedNodeModel, ResolvedRelationField, ResolvedScalarField } from "@cyphra/schema";
import {
  QueryContext,
  compilePaging,
  compileScalarFilter,
  compileWhere,
  intParam,
  nonNegativeInt,
  q,
  relationField,
  relationMatch,
  scalarField,
  labelExpr,
} from "./compile.js";
import { CyphraValidationError } from "./errors.js";
import { decodeCount, decodeScalar, integerToNumber } from "./values.js";
import { isInt } from "../cypher-values.js";

type AnyRecord = Record<string, unknown>;

/** Aggregate operators, in result-key order. */
export const AGGREGATES = ["_count", "_sum", "_avg", "_min", "_max"] as const;
export type AggregateOp = (typeof AGGREGATES)[number];

const AGG_SET = new Set<string>(AGGREGATES);
const NUMERIC = new Set(["Int", "Float", "BigInt"]);
const ORDERABLE = new Set([
  "Int",
  "Float",
  "BigInt",
  "String",
  "Enum",
  "DateTime",
  "Date",
  "LocalDateTime",
  "LocalTime",
  "Time",
]);

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** A compiled read: Cypher text, parameters and a decoder for the returned records. */
export type CompiledAggregate<T> = {
  readonly text: string;
  readonly params: AnyRecord;
  readonly decode: (rows: readonly AnyRecord[]) => T;
};

/** `"_all"` (count of nodes) or a scalar field of the model. */
type AggTarget = "_all" | ResolvedScalarField;

/** Resolve and type-check the field an aggregate applies to. */
function aggTarget(model: ResolvedNodeModel, op: AggregateOp, name: string): AggTarget {
  if (name === "_all") {
    if (op !== "_count") throw new CyphraValidationError(`${op} does not take "_all".`);
    return "_all";
  }
  const f = scalarField(model, name);
  if (!f) throw new CyphraValidationError(`Unknown scalar field "${model.name}.${name}" in ${op}.`);
  if (op === "_count") return f;
  const ok = !f.list && (op === "_sum" || op === "_avg" ? NUMERIC : ORDERABLE).has(f.type);
  if (!ok) {
    const allowed =
      op === "_sum" || op === "_avg"
        ? "Int, Float and BigInt"
        : "Int, Float, BigInt, String, enum, DateTime, Date, LocalDateTime, LocalTime and Time";
    throw new CyphraValidationError(
      `${op} is not valid on ${model.name}.${name} (${f.type}${f.list ? "[]" : ""}); it takes ${allowed} fields.`,
    );
  }
  return f;
}

/** Cypher aggregate expression over node variable `alias`. Nulls are ignored, as in SQL. */
function aggExpr(alias: string, op: AggregateOp, target: AggTarget): string {
  if (target === "_all") return `count(${alias})`;
  const ref = `${alias}.${q(target.name)}`;
  switch (op) {
    case "_count":
      return `count(${ref})`;
    // Cypher's sum() is 0 on an empty set; SQL (and Prisma) return null.
    case "_sum":
      return `CASE WHEN count(${ref}) = 0 THEN null ELSE sum(${ref}) END`;
    case "_avg":
      return `avg(${ref})`;
    case "_min":
      return `min(${ref})`;
    case "_max":
      return `max(${ref})`;
  }
}

function decodeAgg(op: AggregateOp, target: AggTarget, v: unknown): unknown {
  if (op === "_count") return decodeCount(v);
  if (v === null || v === undefined) return null;
  if (op === "_avg") return isInt(v) ? integerToNumber(v) : Number(v);
  return decodeScalar(target as ResolvedScalarField, v);
}

/** The field type an aggregate's *result* is compared as in `having`. */
function aggResultField(op: AggregateOp, target: AggTarget): ResolvedScalarField {
  const base = target === "_all" ? undefined : target;
  const name = `${base?.name ?? "_all"}.${op}`;
  // `_min` / `_max` keep the field's type (and enum values); a BigInt `_sum` stays a BigInt.
  const type =
    op === "_count"
      ? "Int"
      : op === "_avg" || (op === "_sum" && base!.type !== "BigInt")
        ? "Float"
        : base!.type;
  return {
    ...(op === "_min" || op === "_max" ? base : {}),
    kind: "scalar",
    name,
    type,
    optional: op !== "_count",
    list: false,
    id: false,
    unique: false,
    index: false,
  };
}

/** Deduplicated aggregate columns of one statement (`count(n) AS a3`, …). */
class AggColumns {
  readonly columns: string[] = [];
  readonly aliases: string[] = [];
  private readonly byExpr = new Map<string, string>();

  constructor(
    private readonly ctx: QueryContext,
    private readonly alias: string,
  ) {}

  add(op: AggregateOp, target: AggTarget): string {
    const expr = aggExpr(this.alias, op, target);
    let v = this.byExpr.get(expr);
    if (!v) {
      v = this.ctx.variable("a");
      this.byExpr.set(expr, v);
      this.columns.push(`${expr} AS ${v}`);
      this.aliases.push(v);
    }
    return v;
  }
}

type OutputAgg = {
  readonly op: AggregateOp;
  /** `null`: `_count: true` (a bare number). */
  readonly key: string | null;
  readonly target: AggTarget;
  readonly column: string;
};

function asFlag(v: unknown, where: string): boolean {
  if (v === undefined || v === false) return false;
  if (v === true) return true;
  throw new CyphraValidationError(`${where} must be true or false.`);
}

/** Parse `_count` / `_sum` / `_avg` / `_min` / `_max` selections into output columns. */
function compileSelection(
  model: ResolvedNodeModel,
  args: AnyRecord,
  cols: AggColumns,
): OutputAgg[] {
  const out: OutputAgg[] = [];
  for (const op of AGGREGATES) {
    const spec = args[op];
    if (spec === undefined || spec === false) continue;
    if (op === "_count" && spec === true) {
      out.push({ op, key: null, target: "_all", column: cols.add(op, "_all") });
      continue;
    }
    if (!isPlainObject(spec)) {
      throw new CyphraValidationError(
        `${op} must be an object of fields${op === "_count" ? " or true" : ""}.`,
      );
    }
    for (const [name, flag] of Object.entries(spec)) {
      if (!asFlag(flag, `${op}.${name}`)) continue;
      const target = aggTarget(model, op, name);
      out.push({ op, key: name, target, column: cols.add(op, target) });
    }
    // An empty selection still yields an (empty) object in the result.
    if (out.every((o) => o.op !== op)) {
      out.push({ op, key: "", target: "_all", column: "" });
    }
  }
  return out;
}

function decodeSelection(outputs: readonly OutputAgg[], row: AnyRecord, into: AnyRecord): void {
  for (const o of outputs) {
    if (o.key === null) {
      into[o.op] = decodeAgg(o.op, o.target, row[o.column]);
      continue;
    }
    const bucket = (into[o.op] ??= {}) as AnyRecord;
    if (o.key !== "") bucket[o.key] = decodeAgg(o.op, o.target, row[o.column]);
  }
}

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

/**
 * `MATCH (n:L) WHERE … [WITH n ORDER BY … SKIP … LIMIT …] RETURN <aggregates>`: always one row,
 * also on an empty match (counts are 0, the other aggregates `null`).
 */
export function compileAggregate(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  args: AnyRecord,
): CompiledAggregate<AnyRecord> {
  checkKeys(args, ["where", "orderBy", "skip", "take", ...AGGREGATES], "aggregate");
  const whereClause = compileWhere(ctx, model, "n", args.where);
  const cols = new AggColumns(ctx, "n");
  const outputs = compileSelection(model, args, cols);
  const paging = compilePaging(ctx, model, "n", args);
  let text = `MATCH (n:${labelExpr(model)})`;
  if (whereClause) text += ` WHERE ${whereClause}`;
  if (paging) text += ` WITH n${paging}`;
  text += ` RETURN ${cols.columns.length ? cols.columns.join(", ") : "count(n) AS _"}`;
  return {
    text,
    params: ctx.params,
    decode: (rows) => {
      const out: AnyRecord = {};
      decodeSelection(outputs, rows[0] ?? {}, out);
      return out;
    },
  };
}

function checkKeys(args: AnyRecord, allowed: readonly string[], op: string): void {
  for (const k of Object.keys(args)) {
    if (args[k] !== undefined && !allowed.includes(k)) {
      throw new CyphraValidationError(`Unknown ${op} argument "${k}".`);
    }
  }
}

// ---------------------------------------------------------------------------
// groupBy
// ---------------------------------------------------------------------------

type GroupKey = {
  /** `"status"` or `"author.name"`. */
  readonly path: string;
  readonly column: string;
  readonly field: ResolvedScalarField;
  /** Set for a field of a to-one related node. */
  readonly relation?: ResolvedRelationField;
};

function compileGroupKeys(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  by: unknown,
): { keys: GroupKey[]; related: string[]; keyColumns: string[] } {
  const list = Array.isArray(by) ? by : [by];
  if (list.length === 0 || list.some((x) => typeof x !== "string")) {
    throw new CyphraValidationError(
      "groupBy: by must be a field name or a non-empty array of them.",
    );
  }
  const keys: GroupKey[] = [];
  const related: string[] = []; // `head(COLLECT { … }) AS g0`
  const relVars = new Map<string, string>();
  const keyColumns: string[] = [];
  for (const path of new Set(list as string[])) {
    const dot = path.indexOf(".");
    const column = ctx.variable("k");
    if (dot === -1) {
      const field = scalarField(model, path);
      if (!field) {
        throw new CyphraValidationError(
          `Unknown scalar field "${model.name}.${path}" in groupBy.by.`,
        );
      }
      keys.push({ path, column, field });
      keyColumns.push(`n.${q(field.name)} AS ${column}`);
      continue;
    }
    const relName = path.slice(0, dot);
    const fieldName = path.slice(dot + 1);
    const relation = relationField(model, relName);
    if (!relation) {
      throw new CyphraValidationError(`Unknown relation "${model.name}.${relName}" in groupBy.by.`);
    }
    if (relation.many) {
      throw new CyphraValidationError(
        `groupBy.by "${path}": only fields of to-one relations can be grouped by (${model.name}.${relName} is a list).`,
      );
    }
    const target = ctx.node(relation.target);
    const field = scalarField(target, fieldName);
    if (!field) {
      throw new CyphraValidationError(
        `Unknown scalar field "${target.name}.${fieldName}" in groupBy.by.`,
      );
    }
    let g = relVars.get(relName);
    if (!g) {
      g = ctx.variable("g");
      relVars.set(relName, g);
      const m = ctx.variable();
      related.push(
        `head(COLLECT { MATCH ${relationMatch(ctx, "n", relation, m)} RETURN ${m} }) AS ${g}`,
      );
    }
    keys.push({ path, column, field, relation });
    keyColumns.push(`${g}.${q(field.name)} AS ${column}`);
  }
  return { keys, related, keyColumns };
}

function keyFor(keys: readonly GroupKey[], path: string, clause: string): GroupKey {
  const k = keys.find((x) => x.path === path);
  if (!k) throw new CyphraValidationError(`groupBy ${clause}: "${path}" must be listed in by.`);
  return k;
}

function compileHaving(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  keys: readonly GroupKey[],
  cols: AggColumns,
  having: unknown,
): string | null {
  if (having === undefined || having === null) return null;
  if (!isPlainObject(having)) throw new CyphraValidationError("groupBy having must be an object.");
  const parts: string[] = [];
  for (const [key, value] of Object.entries(having)) {
    if (value === undefined) continue;
    if (key === "AND" || key === "OR" || key === "NOT") {
      const list = Array.isArray(value) ? value : [value];
      const compiled = list
        .map((h) => compileHaving(ctx, model, keys, cols, h))
        .filter((x): x is string => Boolean(x));
      if (key === "AND") {
        if (compiled.length) parts.push(compiled.map((x) => `(${x})`).join(" AND "));
      } else if (key === "OR") {
        if (list.length === 0) parts.push("false");
        else if (compiled.length === list.length)
          parts.push(compiled.map((x) => `(${x})`).join(" OR "));
      } else for (const c of compiled) parts.push(`NOT (${c})`);
      continue;
    }
    const field = scalarField(model, key);
    if (field) {
      const rest: AnyRecord = {};
      let hasRest = !isPlainObject(value);
      if (isPlainObject(value)) {
        for (const [op, filter] of Object.entries(value)) {
          if (filter === undefined) continue;
          if (AGG_SET.has(op)) {
            const agg = op as AggregateOp;
            const target = aggTarget(model, agg, key);
            const c = compileScalarFilter(
              ctx,
              model,
              aggResultField(agg, target),
              cols.add(agg, target),
              filter,
            );
            if (c) parts.push(c);
          } else {
            rest[op] = filter;
            hasRest = true;
          }
        }
      }
      if (hasRest) {
        const k = keyFor(keys, key, "having");
        const c = compileScalarFilter(
          ctx,
          model,
          field,
          k.column,
          isPlainObject(value) ? rest : value,
        );
        if (c) parts.push(c);
      }
      continue;
    }
    const rel = relationField(model, key);
    if (rel && !rel.many) {
      if (!isPlainObject(value)) {
        throw new CyphraValidationError(
          `groupBy having.${key} must be an object of ${rel.target} fields.`,
        );
      }
      const target = ctx.node(rel.target);
      for (const [name, filter] of Object.entries(value)) {
        const k = keyFor(keys, `${key}.${name}`, "having");
        const c = compileScalarFilter(ctx, target, k.field, k.column, filter);
        if (c) parts.push(c);
      }
      continue;
    }
    throw new CyphraValidationError(`Unknown field "${model.name}.${key}" in having.`);
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : parts.map((x) => `(${x})`).join(" AND ");
}

function sortDir(dir: unknown, where: string): string {
  if (dir !== "asc" && dir !== "desc") {
    throw new CyphraValidationError(`orderBy ${where} must be "asc" or "desc".`);
  }
  return dir.toUpperCase();
}

function compileGroupOrder(
  model: ResolvedNodeModel,
  keys: readonly GroupKey[],
  cols: AggColumns,
  orderBy: unknown,
): string | null {
  if (orderBy === undefined || orderBy === null) return null;
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  const parts: string[] = [];
  for (const item of list) {
    if (!isPlainObject(item)) throw new CyphraValidationError("orderBy entries must be objects.");
    for (const [key, dir] of Object.entries(item)) {
      if (dir === undefined) continue;
      if (AGG_SET.has(key)) {
        const op = key as AggregateOp;
        if (!isPlainObject(dir)) {
          throw new CyphraValidationError(`orderBy ${op} must be an object of fields.`);
        }
        for (const [name, d] of Object.entries(dir)) {
          if (d === undefined) continue;
          parts.push(`${cols.add(op, aggTarget(model, op, name))} ${sortDir(d, `${op}.${name}`)}`);
        }
        continue;
      }
      if (isPlainObject(dir)) {
        const rel = relationField(model, key);
        if (!rel || rel.many) {
          throw new CyphraValidationError(
            `Unknown to-one relation "${model.name}.${key}" in orderBy.`,
          );
        }
        for (const [name, d] of Object.entries(dir)) {
          if (d === undefined) continue;
          parts.push(
            `${keyFor(keys, `${key}.${name}`, "orderBy").column} ${sortDir(d, `${key}.${name}`)}`,
          );
        }
        continue;
      }
      if (!scalarField(model, key)) {
        throw new CyphraValidationError(`Unknown field "${model.name}.${key}" in orderBy.`);
      }
      parts.push(`${keyFor(keys, key, "orderBy").column} ${sortDir(dir, key)}`);
    }
  }
  return parts.length ? parts.join(", ") : null;
}

/**
 * ```
 * MATCH (n:L) WHERE …
 * [WITH n, head(COLLECT { MATCH (n)<-[:R]-(m:T) RETURN m }) AS g0]   -- to-one relation keys
 * WITH n.`status` AS k0, g0.`name` AS k1, count(n) AS a2, …          -- implicit grouping
 * [WHERE <having>]
 * RETURN … [ORDER BY …] [SKIP …] [LIMIT …]
 * ```
 */
export function compileGroupBy(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  args: AnyRecord,
): CompiledAggregate<AnyRecord[]> {
  checkKeys(args, ["by", "where", "having", "orderBy", "skip", "take", ...AGGREGATES], "groupBy");
  const whereClause = compileWhere(ctx, model, "n", args.where);
  const { keys, related, keyColumns } = compileGroupKeys(ctx, model, args.by);
  const cols = new AggColumns(ctx, "n");
  const outputs = compileSelection(model, args, cols);
  const having = compileHaving(ctx, model, keys, cols, args.having);
  const order = compileGroupOrder(model, keys, cols, args.orderBy);
  // Without any aggregate the WITH would not group; count(n) makes the grouping explicit.
  if (cols.columns.length === 0) cols.add("_count", "_all");

  let text = `MATCH (n:${labelExpr(model)})`;
  if (whereClause) text += ` WHERE ${whereClause}`;
  if (related.length) text += ` WITH n, ${related.join(", ")}`;
  text += ` WITH ${[...keyColumns, ...cols.columns].join(", ")}`;
  if (having) text += ` WHERE ${having}`;
  const returned = [...keys.map((k) => k.column), ...cols.aliases];
  text += ` RETURN ${returned.join(", ")}`;
  if (order) text += ` ORDER BY ${order}`;
  if (args.skip !== undefined)
    text += ` SKIP ${ctx.param(intParam(nonNegativeInt(args.skip, "skip")))}`;
  if (args.take !== undefined)
    text += ` LIMIT ${ctx.param(intParam(nonNegativeInt(args.take, "take")))}`;

  return {
    text,
    params: ctx.params,
    decode: (rows) =>
      rows.map((row) => {
        const out: AnyRecord = {};
        for (const k of keys) {
          const v = decodeScalar(k.field, row[k.column]);
          if (k.relation) {
            const bucket = (out[k.relation.name] ??= {}) as AnyRecord;
            bucket[k.field.name] = v;
          } else out[k.field.name] = v;
        }
        decodeSelection(outputs, row, out);
        return out;
      }),
  };
}
