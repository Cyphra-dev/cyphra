/**
 * Compiles `shortestPath` / `allShortestPaths` arguments into one Cypher statement with a GQL
 * shortest-path selector (`SHORTEST 1` / `ALL SHORTEST`, Neo4j 5.21+) over the same hop pattern as
 * `traverse`:
 *
 * ```cypher
 * MATCH (s:`User`) WHERE … MATCH (t:`User`) WHERE …
 * MATCH p = SHORTEST 1 (s)((:`User`)-[e0:`FOLLOWS`]->(:`User`)){0,4}(t)
 * ```
 *
 * Filters on edges (`edgeWhere`, inside the quantified pattern) and on intermediate nodes (`where`,
 * in a parenthesized path pattern) are applied before the selector, so a filtered-out shortest path
 * makes way for the next shortest one instead of giving no result.
 * Values are parameters and identifiers come from the resolved schema; the only inlined number is
 * `maxDepth`, a validated integer (quantifiers cannot be parameters).
 *
 * @packageDocumentation
 */

import type { ResolvedNodeModel } from "@cyphra/schema";
import {
  QueryContext,
  compileProjection,
  compileWhere,
  decodeRow,
  intParam,
  nonNegativeInt,
  q,
} from "./compile.js";
import { CyphraValidationError } from "./errors.js";
import { compilePath, decodePath } from "./path.js";
import {
  compileHop,
  edgeWhereModel,
  hopBound,
  memgraphExpansion,
  viaRelations,
} from "./traverse.js";

type AnyRecord = Record<string, unknown>;

const ARG_KEYS = new Set([
  "from",
  "to",
  "via",
  "direction",
  "maxDepth",
  "where",
  "edgeWhere",
  "select",
  "include",
]);

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** A compiled shortest-path read: Cypher text, parameters and a decoder for the returned paths. */
export type CompiledShortestPath = {
  readonly text: string;
  readonly params: AnyRecord;
  readonly decode: (rows: readonly AnyRecord[]) => AnyRecord[];
};

/**
 * Compile a shortest-path query between the nodes matching `from` and the nodes matching `to`.
 *
 * - `all: false` (`shortestPath`): one shortest path per start/end pair (`SHORTEST 1`), then the
 *   shortest of those, so at most one row. When several pairs tie, which one is returned is up to
 *   Neo4j.
 * - `all: true` (`allShortestPaths`): every shortest path of each pair (`ALL SHORTEST`), keeping
 *   only the paths of the overall minimum length, capped by `take`.
 * - A node matching both `from` and `to` is joined to itself by a zero-hop path.
 * - `where` must hold on every intermediate node (not on the start node, which `from` selects, nor
 *   on the end node, which `to` selects).
 * - Path nodes are projected with `select` / `include`, like `findMany` rows.
 */
export function compileShortestPath(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  args: AnyRecord,
  cap: number,
  all: boolean,
): CompiledShortestPath {
  const op = all ? "allShortestPaths" : "shortestPath";
  for (const k of Object.keys(args)) {
    if (!ARG_KEYS.has(k) && !(all && k === "take")) {
      throw new CyphraValidationError(`${op}: unknown argument "${k}".`);
    }
  }
  for (const end of ["from", "to"] as const) {
    if (!isPlainObject(args[end])) {
      throw new CyphraValidationError(
        `${op} on ${model.name}: ${end} is required (a where filter on the ${end === "from" ? "start" : "end"} nodes).`,
      );
    }
  }
  if (args.maxDepth === undefined) {
    throw new CyphraValidationError(`${op} on ${model.name}: maxDepth is required.`);
  }
  const max = hopBound(args.maxDepth, "maxDepth", 1, cap, op);
  const rels = viaRelations(model, args.via, op);

  const label = q(model.label);
  const from = compileWhere(ctx, model, "s", args.from);
  const to = compileWhere(ctx, model, "t", args.to);
  if (ctx.dialect === "memgraph") {
    return memgraphShortestPath(ctx, model, args, max, all, { label, from, to, rels, op });
  }
  // `where` reads the group variable of the hop's end nodes (every node but the start).
  const y = args.where === undefined ? undefined : ctx.variable("y");
  const hop = compileHop(
    ctx,
    model,
    rels,
    args.direction,
    (e) =>
      args.edgeWhere === undefined
        ? null
        : compileWhere(ctx, edgeWhereModel(ctx.schema, model, rels, op), e, args.edgeWhere),
    y,
    op,
  );
  let pattern = `(s)(${hop}){0,${max}}(t)`;
  if (y) {
    // In the parenthesized pattern, so it applies before the selector picks the shortest paths. Not
    // inside the hop: Neo4j 5.26 fails to plan a hop predicate that mixes a subquery (relation
    // filters) with the outer `t`, which the end-node exemption would need.
    const x = ctx.variable("x");
    const where = compileWhere(ctx, model, x, args.where);
    if (where) pattern = `(${pattern} WHERE all(${x} IN ${y}[..-1] WHERE ${where}))`;
  }

  let text = `MATCH (s:${label})${from ? ` WHERE ${from}` : ""} `;
  text += `MATCH (t:${label})${to ? ` WHERE ${to}` : ""} `;
  text += `MATCH p = ${all ? "ALL SHORTEST" : "SHORTEST 1"} ${pattern}`;
  if (all) {
    const x = ctx.variable("x");
    text += ` WITH collect(p) AS ps, min(length(p)) AS d`;
    text += ` UNWIND [${x} IN ps WHERE length(${x}) = d] AS p`;
    if (args.take !== undefined) {
      text += ` WITH p LIMIT ${ctx.param(intParam(nonNegativeInt(args.take, "take")))}`;
    }
  } else {
    text += ` WITH p ORDER BY length(p) LIMIT 1`;
  }

  const n = ctx.variable("n");
  const { expr, shape } = compileProjection(ctx, model, n, args);
  text += ` RETURN [${n} IN nodes(p) | ${expr}] AS nodes, ${compilePath(ctx, "p")} AS path`;

  return {
    text,
    params: ctx.params,
    decode: (rows) =>
      rows.map((r) => ({
        nodes: ((r.nodes ?? []) as unknown[]).map((node) => decodeRow(shape, node)!),
        edges: decodePath(ctx.schema, r.path).edges,
      })),
  };
}

/**
 * Memgraph: `*BFS` (one shortest path per start/end pair) or `*ALLSHORTEST` with a constant
 * weight (every shortest path), with the hop's checks and `where` in the filter lambda, so they
 * apply during the search. Memgraph's searches need at least one hop: a node matching both `from`
 * and `to` gets its zero-hop path from a second branch.
 *
 * ```cypher
 * MATCH (s:`User`) WHERE … MATCH (t:`User`) WHERE …
 * CALL { WITH s, t MATCH p = (s) WHERE s = t RETURN p
 *        UNION WITH s, t MATCH p = (s)-[:`FOLLOWS` *BFS ..4 (r, m | …)]->(t) WHERE s <> t RETURN p }
 * ```
 */
function memgraphShortestPath(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  args: AnyRecord,
  max: number,
  all: boolean,
  parts: {
    label: string;
    from: string | null;
    to: string | null;
    rels: ReturnType<typeof viaRelations>;
    op: string;
  },
): CompiledShortestPath {
  const { label, from, to, rels, op } = parts;
  let range = `*BFS ..${max}`;
  if (all) {
    const wr = ctx.variable("r");
    const wm = ctx.variable("m");
    range = `*ALLSHORTEST ..${max} (${wr}, ${wm} | 1) ${ctx.variable("w")}`;
  }
  const expansion = memgraphExpansion(
    ctx,
    model,
    rels,
    args.direction,
    (e) =>
      args.edgeWhere === undefined
        ? null
        : compileWhere(ctx, edgeWhereModel(ctx.schema, model, rels, op), e, args.edgeWhere),
    // `where` holds on intermediate nodes only: the end node, which `to` selects, is exempt.
    args.where === undefined
      ? undefined
      : (m) => {
          const where = compileWhere(ctx, model, m, args.where);
          return where ? `${m} = t OR (${where})` : null;
        },
    range,
    op,
  );

  let text = `MATCH (s:${label})${from ? ` WHERE ${from}` : ""} `;
  text += `MATCH (t:${label})${to ? ` WHERE ${to}` : ""} `;
  text += `CALL { WITH s, t MATCH p = (s) WHERE s = t RETURN p`;
  text += ` UNION WITH s, t MATCH p = (s)${expansion}(t) WHERE s <> t RETURN p }`;
  if (all) {
    const x = ctx.variable("x");
    text += ` WITH collect(p) AS ps, min(length(p)) AS d`;
    text += ` UNWIND [${x} IN ps WHERE length(${x}) = d] AS p`;
    if (args.take !== undefined) {
      text += ` WITH p LIMIT ${ctx.param(intParam(nonNegativeInt(args.take, "take")))}`;
    }
  } else {
    text += ` WITH p ORDER BY length(p) LIMIT 1`;
  }

  // Not a list comprehension over nodes(p): Memgraph cannot run the projection's subqueries
  // (relation counts, includes) there. UNWIND keeps the path's order.
  const n = ctx.variable("n");
  const { expr, shape } = compileProjection(ctx, model, n, args);
  text += ` CALL { WITH p UNWIND nodes(p) AS ${n} RETURN collect(${expr}) AS nodes }`;
  text += ` RETURN nodes, ${compilePath(ctx, "p")} AS path`;

  return {
    text,
    params: ctx.params,
    decode: (rows) =>
      rows.map((r) => ({
        nodes: ((r.nodes ?? []) as unknown[]).map((node) => decodeRow(shape, node)!),
        edges: decodePath(ctx.schema, r.path).edges,
      })),
  };
}
