/**
 * Compiles `traverse` arguments into one Cypher statement: a quantified path pattern
 * (`(s)((:User)-[e:FOLLOWS]->(:User)){1,3}(n:User)`, Neo4j 5.9+) from the start nodes to the
 * reached nodes.
 *
 * Same rules as `compile.ts`: values are parameters, identifiers come from the resolved schema and
 * are backtick-quoted. The only inlined numbers are the hop bounds (quantifiers cannot be
 * parameters), which are validated integers.
 *
 * @packageDocumentation
 */

import type {
  RelationDirection,
  ResolvedNodeModel,
  ResolvedRelationField,
  SchemaModel,
} from "@cyphra/schema";
import {
  QueryContext,
  compileOrderBy,
  compilePaging,
  compileProjection,
  compileWhere,
  decodeRow,
  q,
  relationField,
} from "./compile.js";
import { CyphraValidationError } from "./errors.js";
import { compilePath, decodePath } from "./path.js";

type AnyRecord = Record<string, unknown>;

/** Default for the client option `maxTraversalDepth`. */
export const DEFAULT_MAX_TRAVERSAL_DEPTH = 10;

const ARG_KEYS = new Set([
  "from",
  "via",
  "direction",
  "depth",
  "where",
  "edgeWhere",
  "distinct",
  "select",
  "include",
  "orderBy",
  "skip",
  "take",
  "returnPaths",
]);

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** A compiled read: Cypher text, parameters and a decoder for the returned records. */
export type CompiledTraversal = {
  readonly text: string;
  readonly params: AnyRecord;
  readonly decode: (rows: readonly AnyRecord[]) => unknown[];
};

function hopBound(v: unknown, name: string, min: number, cap?: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
    throw new CyphraValidationError(`traverse: ${name} must be an integer >= ${min}.`);
  }
  if (cap !== undefined && v > cap) {
    throw new CyphraValidationError(
      `traverse: ${name} is ${v}, above the maximum traversal depth of ${cap} (client option maxTraversalDepth).`,
    );
  }
  return v;
}

/** Parse `depth: { min?, max }` against the client's cap. */
export function parseDepth(depth: unknown, cap: number): { min: number; max: number } {
  if (!isPlainObject(depth) || depth.max === undefined) {
    throw new CyphraValidationError(
      "traverse: depth.max is required (depth: { min?: number, max: number }).",
    );
  }
  for (const k of Object.keys(depth)) {
    if (k !== "min" && k !== "max") {
      throw new CyphraValidationError(`traverse: unknown depth option "${k}".`);
    }
  }
  const max = hopBound(depth.max, "depth.max", 1, cap);
  const min = depth.min === undefined ? 1 : hopBound(depth.min, "depth.min", 0);
  if (min > max) {
    throw new CyphraValidationError(`traverse: depth.min (${min}) is above depth.max (${max}).`);
  }
  return { min, max };
}

/** Resolve `via` to relation fields of `model` that lead back to `model`. */
function viaRelations(model: ResolvedNodeModel, via: unknown): ResolvedRelationField[] {
  const names = Array.isArray(via) ? via : [via];
  if (via === undefined || names.length === 0) {
    throw new CyphraValidationError(
      `traverse on ${model.name}: via is required (a relation name or a list of them).`,
    );
  }
  const out: ResolvedRelationField[] = [];
  for (const name of names) {
    const rel = typeof name === "string" ? relationField(model, name) : undefined;
    if (!rel) {
      throw new CyphraValidationError(
        `traverse: unknown relation "${model.name}.${String(name)}" in via.`,
      );
    }
    if (rel.target !== model.name) {
      throw new CyphraValidationError(
        `traverse: ${model.name}.${rel.name} leads to ${rel.target}; via takes relations from ${model.name} to ${model.name}.`,
      );
    }
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

/**
 * The hop of the quantified path pattern, e.g. `(:User)-[e:FOLLOWS]->(:User)`. Several relations
 * with the same arrow direction share one pattern (`[e:A|B]`); mixed directions use an undirected
 * pattern with a predicate on each relationship type.
 */
function compileHop(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  rels: readonly ResolvedRelationField[],
  direction: unknown,
  edgePredicate: (edge: string) => string | null,
): string {
  if (
    direction !== undefined &&
    direction !== "out" &&
    direction !== "in" &&
    direction !== "both"
  ) {
    throw new CyphraValidationError('traverse: direction must be "out", "in" or "both".');
  }
  const byType = new Map<string, Set<RelationDirection>>();
  for (const rel of rels) {
    const dirs = byType.get(rel.relType) ?? new Set<RelationDirection>();
    if (direction === "both") dirs.add("OUT").add("IN");
    else dirs.add(direction === "out" ? "OUT" : direction === "in" ? "IN" : rel.direction);
    byType.set(rel.relType, dirs);
  }
  const kinds = new Set([...byType.values()].map((d) => (d.size === 2 ? "BOTH" : [...d][0]!)));
  const e = ctx.variable("e");
  const types = [...byType.keys()].map(q).join("|");
  const label = `:${q(model.label)}`;
  const preds: string[] = [];
  let pattern: string;
  if (kinds.size === 1) {
    const kind = [...kinds][0];
    const edge = `[${e}:${types}]`;
    const arrow = kind === "OUT" ? `-${edge}->` : kind === "IN" ? `<-${edge}-` : `-${edge}-`;
    pattern = `(${label})${arrow}(${label})`;
  } else {
    const x = ctx.variable("x");
    const y = ctx.variable("y");
    pattern = `(${x}${label})-[${e}:${types}]-(${y}${label})`;
    const alts = [...byType].map(([type, dirs]) => {
      const t = `type(${e}) = ${ctx.param(type)}`;
      if (dirs.size === 2) return t;
      return `${t} AND ${dirs.has("OUT") ? "startNode" : "endNode"}(${e}) = ${x}`;
    });
    preds.push(alts.map((a) => `(${a})`).join(" OR "));
  }
  const edgeWhere = edgePredicate(e);
  if (edgeWhere) preds.push(edgeWhere);
  const where = preds.length === 0 ? "" : ` WHERE ${preds.map((p) => `(${p})`).join(" AND ")}`;
  return `${pattern}${where}`;
}

/** The `relationship { … }` model shared by every relation of `via`, as a model for `compileWhere`. */
function edgeWhereModel(
  schema: SchemaModel,
  model: ResolvedNodeModel,
  rels: readonly ResolvedRelationField[],
): ResolvedNodeModel {
  const names = new Set(rels.map((r) => r.edge));
  const name = rels[0]!.edge;
  const edge = name ? schema.relationships.find((r) => r.name === name) : undefined;
  if (!edge || names.size !== 1) {
    throw new CyphraValidationError(
      `traverse: edgeWhere needs every relation in via (${rels.map((r) => `${model.name}.${r.name}`).join(", ")}) to share one relationship { … } model.`,
    );
  }
  return { name: edge.name, label: edge.relType, uniqueFields: [], fields: edge.properties };
}

/**
 * Compile a traversal from the nodes matching `from` along the relations `via`.
 *
 * - Reached nodes are filtered with `where`, projected with `select` / `include` and paged with
 *   `orderBy` / `skip` / `take`, like `findMany`.
 * - With `distinct` (default), each reached node is returned once; with `returnPaths`, together
 *   with one of its shortest paths. Without `distinct`, one result per path.
 * - A path that comes back to its own start node is skipped (with `depth.min: 0`, the start node
 *   itself is a result, at zero hops).
 */
export function compileTraverse(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  args: AnyRecord,
  maxDepth: number,
): CompiledTraversal {
  for (const k of Object.keys(args)) {
    if (!ARG_KEYS.has(k)) throw new CyphraValidationError(`traverse: unknown argument "${k}".`);
  }
  if (!isPlainObject(args.from)) {
    throw new CyphraValidationError(
      `traverse on ${model.name}: from is required (a where filter on the start nodes).`,
    );
  }
  const rels = viaRelations(model, args.via);
  const { min, max } = parseDepth(args.depth, maxDepth);
  const distinct = args.distinct ?? true;
  const returnPaths = args.returnPaths ?? false;
  if (typeof distinct !== "boolean") throw new CyphraValidationError("distinct must be a boolean.");
  if (typeof returnPaths !== "boolean") {
    throw new CyphraValidationError("returnPaths must be a boolean.");
  }

  const label = q(model.label);
  const from = compileWhere(ctx, model, "s", args.from);
  const hop = compileHop(ctx, model, rels, args.direction, (e) =>
    args.edgeWhere === undefined
      ? null
      : compileWhere(ctx, edgeWhereModel(ctx.schema, model, rels), e, args.edgeWhere),
  );
  const reached = [min > 0 ? "n <> s" : null, compileWhere(ctx, model, "n", args.where)].filter(
    (x): x is string => Boolean(x),
  );

  let text = `MATCH (s:${label})${from ? ` WHERE ${from}` : ""} `;
  text += `MATCH ${returnPaths ? "p = " : ""}(s)(${hop}){${min},${max}}(n:${label})`;
  if (reached.length) text += ` WHERE ${reached.map((x) => `(${x})`).join(" AND ")}`;

  const paging = compilePaging(ctx, model, "n", args);
  const keep = returnPaths ? "n, p" : "n";
  if (returnPaths && distinct) {
    // One shortest path per reached node: deterministic, unlike head(collect()) after ORDER BY.
    const x = ctx.variable("x");
    text += ` WITH n, collect(p) AS ps, min(length(p)) AS d`;
    text += ` WITH n, [${x} IN ps WHERE length(${x}) = d][0] AS p`;
    if (paging) text += ` WITH n, p${paging}`;
  } else {
    text += ` WITH ${distinct ? "DISTINCT " : ""}${keep}${paging}`;
  }

  const { expr, shape } = compileProjection(ctx, model, "n", args);
  text += ` RETURN ${expr} AS row`;
  if (returnPaths) text += `, ${compilePath(ctx, "p")} AS path`;
  // Re-apply the order on the projected rows (WITH … ORDER BY only orders that clause).
  const order = compileOrderBy(ctx, model, "n", args.orderBy);
  if (order) text += ` ORDER BY ${order}`;

  return {
    text,
    params: ctx.params,
    decode: (rows) =>
      rows.map((r) => {
        const node = decodeRow(shape, r.row)!;
        return returnPaths ? { node, path: decodePath(ctx.schema, r.path) } : node;
      }),
  };
}
