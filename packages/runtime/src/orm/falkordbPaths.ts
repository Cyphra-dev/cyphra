/**
 * Traversals and shortest paths on FalkorDB, which has neither quantified path patterns nor
 * `SHORTEST` selectors (nor Memgraph's filter lambdas).
 *
 * - A hop is a variable-length relationship in a named path, `p0 = (s)-[:A|B*1..3]->(j0:L)`; what
 *   Neo4j checks inside the quantified pattern (the labels of the nodes stepped to, per-type
 *   directions, `edgeWhere`, a hop's `where`) is checked on the path's lists afterwards:
 *   `all(y IN tail(nodes(p0)) WHERE …)`, `all(r IN relationships(p0) WHERE …)`. The same paths
 *   qualify; FalkorDB filters them after expanding instead of while expanding.
 * - A list of hops is one `MATCH` of several named paths (`p0 = (s)-…->(j0), p1 = (j0)-…-(n)`):
 *   the relationships of one match are distinct, as in a single path.
 * - Shortest paths without filters use FalkorDB's breadth-first `shortestPath()` /
 *   `allShortestPaths()`; with filters (or relation types with mixed directions), the paths up to
 *   `maxDepth` hops are enumerated and the shortest kept.
 *
 * A `where` that needs a subquery (a relation filter) on the nodes a path steps through cannot
 * run inside `all(…)`: it throws an {@link UnsupportedFeatureError}.
 *
 * @packageDocumentation
 */

import type { ResolvedNodeModel, ResolvedRelationField } from "@cyphra/schema";
import {
  QueryContext,
  compileOrderBy,
  compilePaging,
  compileProjection,
  compileWhere,
  decodeRow,
  intParam,
  labelExpr,
  labelTest,
  nodePattern,
  nonNegativeInt,
  q,
} from "./compile.js";
import { CyphraValidationError } from "./errors.js";
import { decodePath, decodePathEdges } from "./path.js";
import { edgeWhereModel, parseDepth, resolveHops, viaRelations } from "./traverse.js";
import { unsupportedOnFalkorDB } from "../dialect.js";

type AnyRecord = Record<string, unknown>;
type RelationDirection = "OUT" | "IN";

function hasSubquery(cypher: string): boolean {
  return /\b(?:EXISTS|COUNT|COLLECT) \{/.test(cypher);
}

/** One variable-length hop: the relationship pattern and the checks on its path. */
type Segment = { rel: string; preds: string[] };

/**
 * The relationship part of one hop (`-[:A|B*1..3]->`) and the predicates on the path `path` that
 * hold what a quantified hop pattern would check.
 */
function segment(
  ctx: QueryContext,
  path: string,
  to: ResolvedNodeModel,
  rels: readonly ResolvedRelationField[],
  direction: unknown,
  edgePredicate: (edge: string) => string | null,
  nodePredicate: ((node: string) => string | null) | undefined,
  range: string,
  op: string,
  checkLabels = true,
): Segment {
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
  const kind = kinds.size === 1 ? [...kinds][0]! : "BOTH";
  const types = [...byType.keys()].map(q).join("|");
  const preds: string[] = [];
  const y = ctx.variable("y");
  if (checkLabels) preds.push(`all(${y} IN tail(nodes(${path})) WHERE ${labelTest(y, to)})`);
  if (kinds.size > 1) {
    // Undirected expansion; each type keeps its own direction: an OUT edge starts at the node the
    // hop comes from (nodes(p)[k]), an IN edge ends there.
    const k = ctx.variable("k");
    const r = `relationships(${path})[${k}]`;
    const alts = [...byType].map(([type, dirs]) => {
      const tp = `type(${r}) = ${ctx.param(type)}`;
      if (dirs.size === 2) return tp;
      return `${tp} AND ${dirs.has("OUT") ? "startNode" : "endNode"}(${r}) = nodes(${path})[${k}]`;
    });
    preds.push(
      `all(${k} IN range(0, length(${path}) - 1) WHERE ${alts.map((a) => `(${a})`).join(" OR ")})`,
    );
  }
  const e = ctx.variable("r");
  const edgeWhere = edgePredicate(e);
  if (edgeWhere) preds.push(`all(${e} IN relationships(${path}) WHERE ${edgeWhere})`);
  const m = ctx.variable("m");
  const nodeWhere = nodePredicate?.(m);
  if (nodeWhere) {
    if (hasSubquery(nodeWhere)) {
      throw unsupportedOnFalkorDB(
        `${op}: a relation filter in where (checked on the nodes a path steps through)`,
        "FalkorDB cannot run a subquery for every node of a path. Filter on the nodes' own fields, or filter the results afterwards.",
      );
    }
    preds.push(`all(${m} IN tail(nodes(${path})) WHERE ${nodeWhere})`);
  }
  const edge = `[:${types}${range}]`;
  const rel = kind === "OUT" ? `-${edge}->` : kind === "IN" ? `<-${edge}-` : `-${edge}-`;
  return { rel, preds };
}

/**
 * The path value `compilePath` builds, from a list of nodes and the list of relationships between
 * them.
 */
function listPath(ctx: QueryContext, nodes: string, rels: string, nodeProperties = true): string {
  const x = ctx.variable("x");
  const i = ctx.variable("i");
  const rel = `${rels}[${i}]`;
  const props = nodeProperties ? `, properties: properties(${x})` : "";
  return (
    `{nodes: [${x} IN ${nodes} | {labels: labels(${x})${props}}], ` +
    `edges: [${i} IN range(0, size(${rels}) - 1) | ` +
    `{type: type(${rel}), properties: properties(${rel}), out: startNode(${rel}) = ${nodes}[${i}]}]}`
  );
}

/** `compileTraverse` on FalkorDB (see the module comment); `from` is the compiled start filter. */
export function falkordbTraverse(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  args: AnyRecord,
  maxDepth: number,
  from: string | null,
  distinct: boolean,
  returnPaths: boolean,
): { text: string; params: AnyRecord; decode: (rows: readonly AnyRecord[]) => unknown[] } {
  const parts: string[] = [];
  const preds: string[] = [];
  const paths: string[] = [];
  let end: ResolvedNodeModel;
  let min: number;
  let at = "s";
  if (Array.isArray(args.via) && args.via.some((h) => typeof h === "object" && h !== null)) {
    const hops = resolveHops(ctx.schema, model, args.via, maxDepth);
    hops.forEach((h, i) => {
      const where = `traverse: via[${i}]`;
      const path = ctx.variable("p");
      const last = i === hops.length - 1;
      const next = last ? "n" : ctx.variable("j");
      const seg = segment(
        ctx,
        path,
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
        h.spec.where === undefined ? undefined : (t) => compileWhere(ctx, h.to, t, h.spec.where),
        `*${h.min}..${h.max}`,
        where,
      );
      parts.push(`${path} = (${at})${seg.rel}${nodePattern(next, h.to)}`);
      preds.push(...seg.preds);
      paths.push(path);
      at = next;
    });
    end = hops.at(-1)!.to;
    min = hops.reduce((sum, h) => sum + h.min, 0);
  } else {
    const rels = viaRelations(model, args.via);
    const depth = parseDepth(args.depth, maxDepth);
    const path = ctx.variable("p");
    const seg = segment(
      ctx,
      path,
      model,
      rels,
      args.direction,
      (e) =>
        args.edgeWhere === undefined
          ? null
          : compileWhere(ctx, edgeWhereModel(ctx.schema, model, rels), e, args.edgeWhere),
      undefined,
      `*${depth.min}..${depth.max}`,
      "traverse",
    );
    parts.push(`${path} = (s)${seg.rel}(n:${labelExpr(model)})`);
    preds.push(...seg.preds);
    paths.push(path);
    end = model;
    min = depth.min;
  }
  const reached = [
    ...preds,
    min > 0 ? "n <> s" : null,
    compileWhere(ctx, end, "n", args.where),
  ].filter((x): x is string => Boolean(x));

  let text = `MATCH (s:${labelExpr(model)})${from ? ` WHERE ${from}` : ""} `;
  text += `MATCH ${parts.join(", ")}`;
  if (reached.length) text += ` WHERE ${reached.map((x) => `(${x})`).join(" AND ")}`;

  const paging = compilePaging(ctx, end, "n", args);
  let pathExpr = "";
  if (returnPaths) {
    const nodes = paths.map((p, i) => (i === 0 ? `nodes(${p})` : `tail(nodes(${p}))`)).join(" + ");
    const rels = paths.map((p) => `relationships(${p})`).join(" + ");
    text += ` WITH n, ${nodes} AS pn, ${rels} AS pr`;
    if (distinct) {
      // One shortest path per reached node.
      const x = ctx.variable("x");
      text += ` WITH n, collect({n: pn, r: pr}) AS ps, min(size(pr)) AS d`;
      text += ` WITH n, [${x} IN ps WHERE size(${x}.r) = d][0] AS pp`;
      text += ` WITH n, pp.n AS pn, pp.r AS pr`;
    }
    text += ` WITH n, pn, pr${paging}`;
    pathExpr = listPath(ctx, "pn", "pr");
  } else {
    text += ` WITH ${distinct ? "DISTINCT " : ""}n${paging}`;
  }

  const { expr, shape } = compileProjection(ctx, end, "n", args);
  text += ` RETURN ${expr} AS row`;
  if (returnPaths) text += `, ${pathExpr} AS path`;
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

/** `compileShortestPath` on FalkorDB (see the module comment). */
export function falkordbShortestPath(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  args: AnyRecord,
  max: number,
  all: boolean,
  parts: {
    label: string;
    from: string | null;
    to: string | null;
    rels: readonly ResolvedRelationField[];
    op: string;
  },
): { text: string; params: AnyRecord; decode: (rows: readonly AnyRecord[]) => AnyRecord[] } {
  const { label, from, to, rels, op } = parts;
  const p = "p";
  // `where` holds on intermediate nodes only: the end node, which `to` selects, is exempt.
  const seg = segment(
    ctx,
    p,
    model,
    rels,
    args.direction,
    (e) =>
      args.edgeWhere === undefined
        ? null
        : compileWhere(ctx, edgeWhereModel(ctx.schema, model, rels, op), e, args.edgeWhere),
    args.where === undefined
      ? undefined
      : (m) => {
          const where = compileWhere(ctx, model, m, args.where);
          return where ? `${m} = t OR (${where})` : null;
        },
    `*1..${max}`,
    op,
    false,
  );
  let text = `MATCH (s:${label})${from ? ` WHERE ${from}` : ""} `;
  text += `MATCH (t:${label})${to ? ` WHERE ${to}` : ""} `;
  const zero = `WITH s, t MATCH ${p} = (s) WHERE s = t RETURN ${p}`;
  // FalkorDB's shortestPath() / allShortestPaths() take no filters and no undirected pattern.
  const directed = seg.rel.startsWith("<") || seg.rel.endsWith(">");
  if (seg.preds.length === 0 && directed) {
    // Breadth-first search, without filters (FalkorDB's shortestPath takes none).
    const bfs = all
      ? `WITH s, t MATCH ${p} = allShortestPaths((s)${seg.rel}(t)) WHERE s <> t RETURN ${p}`
      : `WITH s, t WITH s, t, shortestPath((s)${seg.rel}(t)) AS ${p} WHERE s <> t RETURN ${p}`;
    text += `CALL { ${zero} UNION ${bfs} }`;
  } else {
    const y = ctx.variable("y");
    const preds = [`all(${y} IN nodes(${p}) WHERE ${y}:${labelExpr(model)})`, ...seg.preds];
    text +=
      `CALL { ${zero} UNION WITH s, t MATCH ${p} = (s)${seg.rel}(t) ` +
      `WHERE s <> t AND ${preds.map((x) => `(${x})`).join(" AND ")} RETURN ${p} }`;
  }
  // FalkorDB's shortestPath() may return the path end to start: lists in path order, from s.
  const fwd = `head(nodes(${p})) = s`;
  text += ` WITH s, ${p} WHERE ${p} IS NOT NULL`;
  text += ` WITH CASE WHEN ${fwd} THEN nodes(${p}) ELSE reverse(nodes(${p})) END AS pn,`;
  text += ` CASE WHEN ${fwd} THEN relationships(${p}) ELSE reverse(relationships(${p})) END AS pr`;
  if (all) {
    const x = ctx.variable("x");
    text += ` WITH collect({n: pn, r: pr}) AS ps, min(size(pr)) AS d`;
    text += ` UNWIND [${x} IN ps WHERE size(${x}.r) = d] AS pp WITH pp.n AS pn, pp.r AS pr`;
    if (args.take !== undefined) {
      text += ` WITH pn, pr LIMIT ${ctx.param(intParam(nonNegativeInt(args.take, "take")))}`;
    }
  } else {
    text += ` WITH pn, pr ORDER BY size(pr) LIMIT 1`;
  }
  // Not a list comprehension over the nodes: the projection's subqueries (relation counts,
  // includes) become CALL {} subqueries, which need a variable. UNWIND keeps the path's order.
  const n = ctx.variable("n");
  const { expr, shape } = compileProjection(ctx, model, n, args);
  text += ` CALL { WITH pn UNWIND pn AS ${n} RETURN collect(${expr}) AS nodes }`;
  // The nodes are projected above: the path only types the edges.
  text += ` RETURN nodes, ${listPath(ctx, "pn", "pr", false)} AS path`;
  return {
    text,
    params: ctx.params,
    decode: (rows) =>
      rows.map((r) => ({
        nodes: ((r.nodes ?? []) as unknown[]).map((node) => decodeRow(shape, node)!),
        edges: decodePathEdges(ctx.schema, r.path),
      })),
  };
}
