/**
 * Compiles `traverse` arguments into one Cypher statement: a quantified path pattern
 * (`(s)((:User)-[e:FOLLOWS]->(:User)){1,3}(n:User)`, Neo4j 5.9+) from the start nodes to the
 * reached nodes, or a sequence of them for a list of hops across models.
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
  scopedWhere,
  decodeRow,
  q,
  relationField,
  labelExpr,
  labelTest,
  nodePattern,
  unionPredicate,
  type Shape,
} from "./compile.js";
import { CyphraValidationError } from "./errors.js";
import { compilePath, decodePath } from "./path.js";
import { unsupportedOnFalkorDB, unsupportedOnMemgraph } from "../dialect.js";
import { falkordbTraverse } from "./falkordbPaths.js";

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

/** Validate a hop bound (inlined in the statement, so it must be a checked integer). */
export function hopBound(
  v: unknown,
  name: string,
  min: number,
  cap?: number,
  op = "traverse",
): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
    throw new CyphraValidationError(`${op}: ${name} must be an integer >= ${min}.`);
  }
  if (cap !== undefined && v > cap) {
    throw new CyphraValidationError(
      `${op}: ${name} is ${v}, above the maximum traversal depth of ${cap} (client option maxTraversalDepth).`,
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
export function viaRelations(
  model: ResolvedNodeModel,
  via: unknown,
  op = "traverse",
): ResolvedRelationField[] {
  const names = Array.isArray(via) ? via : [via];
  if (via === undefined || names.length === 0) {
    throw new CyphraValidationError(
      `${op} on ${model.name}: via is required (a relation name or a list of them).`,
    );
  }
  const out: ResolvedRelationField[] = [];
  for (const name of names) {
    const rel = typeof name === "string" ? relationField(model, name) : undefined;
    if (!rel) {
      throw new CyphraValidationError(
        `${op}: unknown relation "${model.name}.${String(name)}" in via.`,
      );
    }
    if (rel.target !== model.name) {
      throw new CyphraValidationError(
        `${op}: ${model.name}.${rel.name} leads to ${rel.target}; via takes relations from ${model.name} to ${model.name}.`,
      );
    }
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

/**
 * The hop of the quantified path pattern, e.g. `(:User)-[e:FOLLOWS]->(:User)`. Several relations
 * with the same arrow direction share one pattern (`[e:A|B]`); mixed directions use an undirected
 * pattern with a predicate on each relationship type. `target` names the node each hop steps to,
 * so that it can be read as a group variable (the list of every node of the path but the first).
 */
export function compileHop(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  rels: readonly ResolvedRelationField[],
  direction: unknown,
  edgePredicate: (edge: string) => string | null,
  target?: string,
  op = "traverse",
): string {
  return hopPattern(ctx, model, model, rels, direction, edgePredicate, undefined, target, op);
}

/**
 * {@link compileHop} from `from` nodes to `to` nodes (models may differ), with a predicate on the
 * node each hop steps to.
 */
function hopPattern(
  ctx: QueryContext,
  from: ResolvedNodeModel,
  to: ResolvedNodeModel,
  rels: readonly ResolvedRelationField[],
  direction: unknown,
  edgePredicate: (edge: string) => string | null,
  nodePredicate: ((node: string) => string | null) | undefined,
  target: string | undefined,
  op: string,
): string {
  if (
    direction !== undefined &&
    direction !== "out" &&
    direction !== "in" &&
    direction !== "both"
  ) {
    throw new CyphraValidationError(`${op}: direction must be "out", "in" or "both".`);
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
  const fromLabel = `:${labelExpr(from)}`;
  // A union has no label: the node stepped to is checked by its label predicate.
  const toLabel = to.union ? "" : `:${labelExpr(to)}`;
  const preds: string[] = [];
  let pattern: string;
  // The node each hop steps to gets a name when something refers to it.
  const t = target ?? (nodePredicate || to.union ? ctx.variable("t") : undefined);
  const nodeWhere = (v: string) => {
    const u = unionPredicate(v, to);
    if (u) preds.push(u);
    const w = nodePredicate?.(v);
    if (w) preds.push(w);
  };
  if (kinds.size === 1) {
    const kind = [...kinds][0];
    const edge = `[${e}:${types}]`;
    const arrow = kind === "OUT" ? `-${edge}->` : kind === "IN" ? `<-${edge}-` : `-${edge}-`;
    pattern = `(${fromLabel})${arrow}(${t ?? ""}${toLabel})`;
    if (t) nodeWhere(t);
  } else {
    const x = ctx.variable("x");
    const y = t ?? ctx.variable("y");
    pattern = `(${x}${fromLabel})-[${e}:${types}]-(${y}${toLabel})`;
    const alts = [...byType].map(([type, dirs]) => {
      const tp = `type(${e}) = ${ctx.param(type)}`;
      if (dirs.size === 2) return tp;
      return `${tp} AND ${dirs.has("OUT") ? "startNode" : "endNode"}(${e}) = ${x}`;
    });
    preds.push(alts.map((a) => `(${a})`).join(" OR "));
    nodeWhere(y);
  }
  const edgeWhere = edgePredicate(e);
  if (edgeWhere) preds.push(edgeWhere);
  const where = preds.length === 0 ? "" : ` WHERE ${preds.map((p) => `(${p})`).join(" AND ")}`;
  return `${pattern}${where}`;
}

/**
 * The predicate on the nodes a path steps through, for model `model`: its `read` rules AND `where`
 * (`undefined` when there is neither), so that a path never goes through a node the rules hide.
 */
export function stepWhere(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  where: unknown,
): ((node: string) => string | null) | undefined {
  if (where === undefined && (ctx.rules.length === 0 || ctx.ruleDepth > 0)) return undefined;
  return (node) => scopedWhere(ctx, model, node, where);
}

/**
 * The predicate on the nodes a shortest path steps through: `where` and the read rules, the end
 * node (which `to` selects) exempt.
 */
export function stepOrEnd(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  where: unknown,
): ((node: string) => string | null) | undefined {
  const step = stepWhere(ctx, model, where);
  if (!step) return undefined;
  return (m) => {
    const w = step(m);
    return w ? `${m} = t OR (${w})` : null;
  };
}

/** Whether compiled Cypher contains a subquery expression (`EXISTS {`, `COUNT {`, `COLLECT {`). */
function hasSubquery(cypher: string): boolean {
  return /\b(?:EXISTS|COUNT|COLLECT) \{/.test(cypher);
}

/**
 * Memgraph: the relationship part of a variable-length expansion from `from` nodes to `to` nodes,
 * e.g. ``-[:`FOLLOWS` *1..3 (r0, m1 | m1:`User` AND …)]->``. Memgraph has no quantified path
 * patterns; its filter lambda (`(edge, node | predicate)`, checked on every hop while expanding)
 * holds what the hop pattern of {@link hopPattern} checks: the labels of the node stepped to, the
 * relationship types and directions, `edgeWhere`, and `nodePredicate` on the node stepped to.
 *
 * `range` is what follows the types: `*1..3`, `*BFS ..4`, or
 * `*ALLSHORTEST ..4 (r, m | 1) w` (the weight lambda comes before the filter lambda).
 *
 * Memgraph cannot evaluate a subquery (a relation filter) inside a filter lambda, so a
 * `nodePredicate` that needs one throws an `UnsupportedFeatureError`.
 */
export function memgraphExpansion(
  ctx: QueryContext,
  to: ResolvedNodeModel,
  rels: readonly ResolvedRelationField[],
  direction: unknown,
  edgePredicate: (edge: string) => string | null,
  nodePredicate: ((node: string) => string | null) | undefined,
  range: string,
  op: string,
): string {
  if (
    direction !== undefined &&
    direction !== "out" &&
    direction !== "in" &&
    direction !== "both"
  ) {
    throw new CyphraValidationError(`${op}: direction must be "out", "in" or "both".`);
  }
  const byType = new Map<string, Set<RelationDirection>>();
  for (const rel of rels) {
    const dirs = byType.get(rel.relType) ?? new Set<RelationDirection>();
    if (direction === "both") dirs.add("OUT").add("IN");
    else dirs.add(direction === "out" ? "OUT" : direction === "in" ? "IN" : rel.direction);
    byType.set(rel.relType, dirs);
  }
  const kinds = new Set([...byType.values()].map((d) => (d.size === 2 ? "BOTH" : [...d][0]!)));
  const r = ctx.variable("r");
  const m = ctx.variable("m");
  const types = [...byType.keys()].map(q).join("|");
  const preds: string[] = [labelTest(m, to)];
  const kind = kinds.size === 1 ? [...kinds][0]! : "BOTH";
  if (kinds.size > 1) {
    // Undirected expansion; each type keeps its own direction: an OUT edge ends at the node it
    // steps to, an IN edge starts there.
    const alts = [...byType].map(([type, dirs]) => {
      const tp = `type(${r}) = ${ctx.param(type)}`;
      if (dirs.size === 2) return tp;
      return `${tp} AND ${dirs.has("OUT") ? "endNode" : "startNode"}(${r}) = ${m}`;
    });
    preds.push(alts.map((a) => `(${a})`).join(" OR "));
  }
  const edgeWhere = edgePredicate(r);
  if (edgeWhere) preds.push(edgeWhere);
  const nodeWhere = nodePredicate?.(m);
  if (nodeWhere) {
    if (hasSubquery(nodeWhere)) {
      throw unsupportedOnMemgraph(
        `${op}: a relation filter in where (checked on the nodes a path steps through)`,
        "Memgraph cannot run a subquery inside a path's filter lambda. Filter on the nodes' own fields, or filter the results afterwards.",
      );
    }
    preds.push(nodeWhere);
  }
  const lambda = ` (${r}, ${m} | ${preds.map((x) => `(${x})`).join(" AND ")})`;
  const edge = `[:${types} ${range}${lambda}]`;
  return kind === "OUT" ? `-${edge}->` : kind === "IN" ? `<-${edge}-` : `-${edge}-`;
}

/** The `relationship { … }` model shared by every relation of `via`, as a model for `compileWhere`. */
export function edgeWhereModel(
  schema: SchemaModel,
  model: ResolvedNodeModel,
  rels: readonly ResolvedRelationField[],
  op = "traverse",
): ResolvedNodeModel {
  const names = new Set(rels.map((r) => r.edge));
  const name = rels[0]!.edge;
  const edge = name ? schema.relationships.find((r) => r.name === name) : undefined;
  if (!edge || names.size !== 1) {
    throw new CyphraValidationError(
      `${op}: edgeWhere needs every relation in via (${rels.map((r) => `${model.name}.${r.name}`).join(", ")}) to share one relationship { … } model.`,
    );
  }
  return { name: edge.name, label: edge.relType, uniqueFields: [], fields: edge.properties };
}

const HOP_KEYS = new Set(["rel", "direction", "depth", "where", "edgeWhere"]);

/** Whether `via` is a list of hops (`[{ rel }, …]`) rather than relation names. */
export function isHopList(via: unknown): via is readonly unknown[] {
  return Array.isArray(via) && via.some((h) => isPlainObject(h));
}

/** One resolved hop of a multi-hop traversal. */
type Hop = {
  readonly from: ResolvedNodeModel;
  readonly to: ResolvedNodeModel;
  readonly rels: readonly ResolvedRelationField[];
  readonly spec: AnyRecord;
  readonly min: number;
  readonly max: number;
};

/**
 * Resolve the hops of `via: [{ rel, direction?, depth?, where?, edgeWhere? }, …]` from `model`:
 * each hop's relations must exist on the model the previous hop reached and lead to one model;
 * `depth` is only for relations leading back to the same model; the hops' `depth.max` (1 for a
 * hop without `depth`) add up to at most `maxDepth`.
 */
export function resolveHops(
  schema: SchemaModel,
  model: ResolvedNodeModel,
  via: readonly unknown[],
  maxDepth: number,
): Hop[] {
  const hops: Hop[] = [];
  let at = model;
  let total = 0;
  via.forEach((spec, i) => {
    const where = `traverse: via[${i}]`;
    if (!isPlainObject(spec)) {
      throw new CyphraValidationError(
        `${where}: a list of hops takes objects only ({ rel, direction?, depth?, where?, edgeWhere? }).`,
      );
    }
    for (const k of Object.keys(spec)) {
      if (!HOP_KEYS.has(k)) throw new CyphraValidationError(`${where}: unknown hop option "${k}".`);
    }
    const names = Array.isArray(spec.rel) ? spec.rel : [spec.rel];
    if (spec.rel === undefined || names.length === 0) {
      throw new CyphraValidationError(`${where}: rel is required (a relation of ${at.name}).`);
    }
    const rels: ResolvedRelationField[] = [];
    for (const name of names) {
      const rel = typeof name === "string" ? relationField(at, name) : undefined;
      if (!rel) {
        throw new CyphraValidationError(
          `${where}: unknown relation "${at.name}.${String(name)}" (each hop follows relations of the model the previous hop reached).`,
        );
      }
      if (!rels.includes(rel)) rels.push(rel);
    }
    const targets = new Set(rels.map((r) => r.target));
    if (targets.size !== 1) {
      throw new CyphraValidationError(
        `${where}: the relations of one hop must lead to one model (${rels.map((r) => `${at.name}.${r.name} → ${r.target}`).join(", ")}).`,
      );
    }
    const to = schema.nodes.find((n) => n.name === rels[0]!.target);
    if (!to) throw new CyphraValidationError(`Unknown model "${rels[0]!.target}".`);
    let min = 1;
    let max = 1;
    if (spec.depth !== undefined) {
      if (to !== at) {
        throw new CyphraValidationError(
          `${where}: depth repeats a hop, so its relations must lead back to ${at.name} (${at.name}.${rels[0]!.name} leads to ${to.name}).`,
        );
      }
      ({ min, max } = parseDepth(spec.depth, maxDepth));
    }
    total += max;
    if (total > maxDepth) {
      throw new CyphraValidationError(
        `traverse: the hops of via add up to more than the maximum traversal depth of ${maxDepth} (client option maxTraversalDepth).`,
      );
    }
    hops.push({ from: at, to, rels, spec, min, max });
    at = to;
  });
  if (hops.length === 0) {
    throw new CyphraValidationError(`traverse on ${model.name}: via is an empty list of hops.`);
  }
  return hops;
}

/** The model a traversal's results are of: the last hop's for a list of hops, else `model`. */
export function traverseEndModel(
  schema: SchemaModel,
  model: ResolvedNodeModel,
  args: unknown,
  maxDepth = Number.MAX_SAFE_INTEGER,
): ResolvedNodeModel {
  if (!isPlainObject(args) || !isHopList(args.via)) return model;
  return resolveHops(schema, model, args.via, maxDepth).at(-1)!.to;
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
 * - `via` can also be a list of hops (`[{ rel, direction?, depth?, where?, edgeWhere? }, …]`),
 *   possibly across models: one quantified path pattern per hop, in sequence
 *   (`(s)((:Chunk)-[e:MENTIONS]->(:Entity)){1,1}((:Entity)-[e2:RELATED_TO]-(:Entity)){0,2}…`), a
 *   hop's `where` checked on every node it steps to. The results are of the last hop's model.
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
  const hops = isHopList(args.via) ? resolveHops(ctx.schema, model, args.via, maxDepth) : null;
  if (hops) {
    for (const k of ["depth", "direction", "edgeWhere"]) {
      if (args[k] !== undefined) {
        throw new CyphraValidationError(
          `traverse: with a list of hops in via, ${k} goes on each hop ({ rel, ${k} }).`,
        );
      }
    }
  }
  const distinct = args.distinct ?? true;
  const returnPaths = args.returnPaths ?? false;
  if (typeof distinct !== "boolean") throw new CyphraValidationError("distinct must be a boolean.");
  if (typeof returnPaths !== "boolean") {
    throw new CyphraValidationError("returnPaths must be a boolean.");
  }

  const from = scopedWhere(ctx, model, "s", args.from);
  if (ctx.dialect === "falkordb") {
    return falkordbTraverse(ctx, model, args, maxDepth, from, distinct, returnPaths);
  }
  let segments: string;
  let end: ResolvedNodeModel;
  let min: number;
  if (ctx.dialect === "memgraph") {
    // Variable-length expansions in sequence: (s)-[*a..b (r, m | …)]->(j0:Next)-[…]-(n:End).
    if (hops) {
      segments = hops
        .map((h, i) => {
          const where = `traverse: via[${i}]`;
          const rel = memgraphExpansion(
            ctx,
            h.to,
            h.rels,
            h.spec.direction,
            (e) =>
              h.spec.edgeWhere === undefined
                ? null
                : compileWhere(
                    ctx,
                    edgeWhereModel(ctx.schema, h.from, h.rels, where),
                    e,
                    h.spec.edgeWhere,
                  ),
            stepWhere(ctx, h.to, h.spec.where),
            `*${h.min}..${h.max}`,
            where,
          );
          return i === hops.length - 1 ? rel : `${rel}(${ctx.variable("j")}:${labelExpr(h.to)})`;
        })
        .join("");
      end = hops.at(-1)!.to;
      min = hops.reduce((sum, h) => sum + h.min, 0);
    } else {
      const rels = viaRelations(model, args.via);
      const depth = parseDepth(args.depth, maxDepth);
      segments = memgraphExpansion(
        ctx,
        model,
        rels,
        args.direction,
        (e) =>
          args.edgeWhere === undefined
            ? null
            : compileWhere(ctx, edgeWhereModel(ctx.schema, model, rels), e, args.edgeWhere),
        stepWhere(ctx, model, undefined),
        `*${depth.min}..${depth.max}`,
        "traverse",
      );
      end = model;
      min = depth.min;
    }
  } else if (hops) {
    segments = hops
      .map((h, i) => {
        const pattern = hopPattern(
          ctx,
          h.from,
          h.to,
          h.rels,
          h.spec.direction,
          (e) =>
            h.spec.edgeWhere === undefined
              ? null
              : compileWhere(
                  ctx,
                  edgeWhereModel(ctx.schema, h.from, h.rels, `traverse: via[${i}]`),
                  e,
                  h.spec.edgeWhere,
                ),
          stepWhere(ctx, h.to, h.spec.where),
          undefined,
          `traverse: via[${i}]`,
        );
        return `(${pattern}){${h.min},${h.max}}`;
      })
      .join("");
    end = hops.at(-1)!.to;
    min = hops.reduce((sum, h) => sum + h.min, 0);
  } else {
    const rels = viaRelations(model, args.via);
    const depth = parseDepth(args.depth, maxDepth);
    const hop = hopPattern(
      ctx,
      model,
      model,
      rels,
      args.direction,
      (e) =>
        args.edgeWhere === undefined
          ? null
          : compileWhere(ctx, edgeWhereModel(ctx.schema, model, rels), e, args.edgeWhere),
      stepWhere(ctx, model, undefined),
      undefined,
      "traverse",
    );
    segments = `(${hop}){${depth.min},${depth.max}}`;
    end = model;
    min = depth.min;
  }
  const reached = [
    min > 0 ? "n <> s" : null,
    unionPredicate("n", end),
    scopedWhere(ctx, end, "n", args.where),
  ].filter((x): x is string => Boolean(x));

  let text = `MATCH (s:${labelExpr(model)})${from ? ` WHERE ${from}` : ""} `;
  text += `MATCH ${returnPaths ? "p = " : ""}(s)${segments}${nodePattern("n", end)}`;
  if (reached.length) text += ` WHERE ${reached.map((x) => `(${x})`).join(" AND ")}`;

  const paging = compilePaging(ctx, end, "n", args);
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

  const { expr, shape } = compileProjection(ctx, end, "n", args);
  text += ` RETURN ${expr} AS row`;
  if (returnPaths) text += `, ${compilePath(ctx, "p")} AS path`;
  // Re-apply the order on the projected rows (WITH … ORDER BY only orders that clause).
  const order = compileOrderBy(ctx, end, "n", args.orderBy);
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

/**
 * A traversal load (internal, not in the client's types; the native GraphQL API's named
 * traversal fields): `select: { context: { $traverse: { via: [{ rel }, …] }, where, orderBy, skip,
 * take, select } }` loads, under `context`, the nodes the hops of `via` reach from the node bound to
 * `alias` (each once; the start node itself only with a zero minimum), as a `COLLECT {}` in the
 * parent's projection: one statement for the whole selection. The nodes a path steps through
 * follow the read rules, like the reached ones. Neo4j only (quantified path patterns in a
 * subquery).
 */
export function compileTraverseLoad(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  alias: string,
  key: string,
  spec: AnyRecord,
  label: string,
): { expr: string; shape: Shape } {
  const { $traverse, ...args } = spec;
  if (ctx.dialect !== "neo4j") {
    const feature = `${label}.${key}: a traversal load ($traverse)`;
    throw ctx.dialect === "memgraph"
      ? unsupportedOnMemgraph(feature)
      : unsupportedOnFalkorDB(feature);
  }
  if (!isPlainObject($traverse) || !isHopList($traverse.via)) {
    throw new CyphraValidationError(
      `${label}.${key}.$traverse takes { via: [{ rel, direction?, depth?, where? }, …] }.`,
    );
  }
  for (const k of Object.keys($traverse)) {
    if (k !== "via")
      throw new CyphraValidationError(`${label}.${key}.$traverse: unknown option "${k}".`);
  }
  const scalarNames = model.fields.filter((f) => f.kind === "scalar").map((f) => f.name);
  if (
    key === "_count" ||
    key.startsWith("$") ||
    key.startsWith("__") ||
    scalarNames.includes(key)
  ) {
    throw new CyphraValidationError(
      `${label}.${key}: "${key}" cannot name a traversal load (it is ${scalarNames.includes(key) ? `a scalar field of ${model.name}` : "a reserved key"}).`,
    );
  }
  const hops = resolveHops(ctx.schema, model, $traverse.via, DEFAULT_MAX_TRAVERSAL_DEPTH);
  const segments = hops
    .map((h, i) => {
      const where = `${label}.${key}.$traverse.via[${i}]`;
      const pattern = hopPattern(
        ctx,
        h.from,
        h.to,
        h.rels,
        h.spec.direction,
        (e) =>
          h.spec.edgeWhere === undefined
            ? null
            : compileWhere(
                ctx,
                edgeWhereModel(ctx.schema, h.from, h.rels, where),
                e,
                h.spec.edgeWhere,
              ),
        stepWhere(ctx, h.to, h.spec.where),
        undefined,
        where,
      );
      return `(${pattern}){${h.min},${h.max}}`;
    })
    .join("");
  const end = hops.at(-1)!.to;
  const min = hops.reduce((sum, h) => sum + h.min, 0);
  const n = ctx.variable("n");
  const reached = [
    min > 0 ? `${n} <> ${alias}` : null,
    unionPredicate(n, end),
    scopedWhere(ctx, end, n, args.where),
  ].filter((x): x is string => Boolean(x));
  const inner = compileProjection(ctx, end, n, args);
  let body = `MATCH (${alias})${segments}${nodePattern(n, end)}`;
  if (reached.length) body += ` WHERE ${reached.map((x) => `(${x})`).join(" AND ")}`;
  body += ` WITH DISTINCT ${n}${compilePaging(ctx, end, n, args)} RETURN ${inner.expr}`;
  return { expr: `COLLECT { ${body} }`, shape: inner.shape };
}
