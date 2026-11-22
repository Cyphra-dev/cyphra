/**
 * `findSimilar`: nearest-neighbour search on a `Vector(N)` field with a `@vectorIndex`.
 *
 * Three plans, all read-only:
 *
 * - **No `where`**: one call to the vector index, `db.index.vector.queryNodes(index, k, vector)`
 *   (Neo4j 5.15+), returning its top `k` (or `candidates`, then the best `k`).
 * - **With `where`**: the index procedure has no filter argument and returns its top hits first, so
 *   filtering afterwards can leave fewer than `k` rows. `findSimilar` over-fetches `candidates`
 *   neighbours (default `max(10 × k, 100)`), filters them in the same statement, and if fewer than
 *   `k` pass, asks again with 4× as many until it has `k` rows, the index has no more nodes to
 *   give, the scores drop below `minScore`, or `maxCandidates` is reached.
 * - **`exact: true`**: no index; scans the nodes matching `where` and ranks them with
 *   `vector.similarity.cosine` / `vector.similarity.euclidean` (Neo4j 5.18+). Exact, and the right
 *   choice when `where` is selective (e.g. the chunks of one document).
 *
 * Scores are the index's: in `[0, 1]`, higher is more similar (`(1 + cos) / 2` for cosine,
 * `1 / (1 + d²)` for euclidean), so `minScore` means the same thing in every plan.
 *
 * @packageDocumentation
 */

import type { ResolvedNodeModel, ResolvedScalarField } from "@cyphra/schema";
import {
  QueryContext,
  compileProjection,
  compileWhere,
  decodeRow,
  intParam,
  q,
  and,
  labelExpr,
} from "./compile.js";
import { CyphraValidationError } from "./errors.js";
import { decodeCount, encodeVector } from "./values.js";

type AnyRecord = Record<string, unknown>;
type Executor = (text: string, params: AnyRecord) => Promise<AnyRecord[]>;

const ARG_KEYS = new Set([
  "field",
  "vector",
  "k",
  "where",
  "select",
  "include",
  "minScore",
  "candidates",
  "maxCandidates",
  "exact",
]);

/** Growth factor of the candidate count between two filtered index queries. */
const CANDIDATE_GROWTH = 4;

function positiveInt(v: unknown, name: string, op: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new CyphraValidationError(`${op}: ${name} must be a positive integer.`);
  }
  return v;
}

function toScore(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

/** The vector field `findSimilar` searches, checked against the schema. */
function vectorField(model: ResolvedNodeModel, name: unknown, op: string): ResolvedScalarField {
  const indexed = model.fields.filter(
    (f): f is ResolvedScalarField => f.kind === "scalar" && Boolean(f.vectorIndex),
  );
  if (typeof name !== "string") {
    throw new CyphraValidationError(
      `${op}: field is required (${indexed.map((f) => f.name).join(", ") || `${model.name} has no @vectorIndex field`}).`,
    );
  }
  const f = model.fields.find((x) => x.name === name);
  if (!f || f.kind !== "scalar" || f.type !== "Vector") {
    throw new CyphraValidationError(`${op}: ${model.name}.${name} is not a Vector field.`);
  }
  if (!f.vectorIndex) {
    throw new CyphraValidationError(
      `${op}: ${model.name}.${name} has no @vectorIndex; declare one to search it.`,
    );
  }
  return f;
}

/**
 * Run a `findSimilar` on `model` through `exec` (a read transaction, or the current
 * `$transaction`). Rows come back best first, each with its `$score`.
 */
export async function findSimilar(
  exec: Executor,
  ctxFactory: () => QueryContext,
  model: ResolvedNodeModel,
  args: AnyRecord,
): Promise<AnyRecord[]> {
  const op = `${model.name}.findSimilar`;
  for (const key of Object.keys(args)) {
    if (!ARG_KEYS.has(key)) throw new CyphraValidationError(`${op}: unknown argument "${key}".`);
  }
  const field = vectorField(model, args.field, op);
  const index = field.vectorIndex!;
  const vector = encodeVector(args.vector, field.dimensions ?? 0, `${op} vector`);
  if (args.k === undefined) throw new CyphraValidationError(`${op}: k is required.`);
  const k = positiveInt(args.k, "k", op);
  const minScore = args.minScore;
  if (minScore !== undefined && (typeof minScore !== "number" || !Number.isFinite(minScore))) {
    throw new CyphraValidationError(`${op}: minScore must be a finite number.`);
  }
  if (args.exact !== undefined && typeof args.exact !== "boolean") {
    throw new CyphraValidationError(`${op}: exact must be a boolean.`);
  }
  const ctx = ctxFactory();
  // An index inherited from an interface covers every implementation: keep this model's nodes.
  const where = and([
    field.inheritedFrom ? `n:${labelExpr(model)}` : null,
    compileWhere(ctx, model, "n", args.where),
  ]);
  const candidates =
    args.candidates === undefined
      ? where
        ? Math.max(10 * k, 100)
        : k
      : positiveInt(args.candidates, "candidates", op);
  if (candidates < k) {
    throw new CyphraValidationError(`${op}: candidates must be at least k (${k}).`);
  }
  const maxCandidates =
    args.maxCandidates === undefined
      ? Number.POSITIVE_INFINITY
      : positiveInt(args.maxCandidates, "maxCandidates", op);
  if (maxCandidates < candidates) {
    throw new CyphraValidationError(`${op}: maxCandidates must be at least candidates.`);
  }

  const prop = q(field.name);
  const vec = ctx.param(vector);
  const limit = ctx.param(intParam(k));
  const scoreOk = minScore === undefined ? null : `score >= ${ctx.param(minScore)}`;
  const { expr, shape } = compileProjection(ctx, model, "n", args);
  const decode = (rows: readonly { row: unknown; score: unknown }[]) =>
    rows
      .map((r) => ({ ...decodeRow(shape, r.row)!, $score: toScore(r.score) }))
      .sort((a, b) => b.$score - a.$score)
      .slice(0, k);

  const memgraph = ctx.dialect === "memgraph";
  const falkordb = ctx.dialect === "falkordb";
  if (args.exact === true) {
    const fn =
      index.similarity === "euclidean" ? "vector.similarity.euclidean" : "vector.similarity.cosine";
    const similarity = memgraph
      ? memgraphSimilarity(ctx, index.similarity, `n.${prop}`, vec)
      : falkordb
        ? falkordbScore(index.similarity, falkordbDistance(index.similarity, `n.${prop}`, vec))
        : `${fn}(n.${prop}, ${vec})`;
    // FalkorDB vectors (`vecf32`) have no size(): its vector functions check the dimensions.
    const filters = falkordb
      ? [`n.${prop} IS NOT NULL`]
      : [`n.${prop} IS NOT NULL`, `size(n.${prop}) = ${ctx.param(intParam(vector.length))}`];
    if (where) filters.push(`(${where})`);
    let text = `MATCH (n:${labelExpr(model)}) WHERE ${filters.join(" AND ")}`;
    text += ` WITH n, ${similarity} AS score`;
    if (scoreOk) text += ` WHERE ${scoreOk}`;
    text += ` WITH n, score ORDER BY score DESC LIMIT ${limit}`;
    text += ` RETURN ${expr} AS row, score ORDER BY score DESC`;
    const rows = await exec(text, ctx.params);
    return decode(rows as { row: unknown; score: unknown }[]);
  }

  const name = ctx.param(index.name);
  // Memgraph's `similarity` is the raw cosine for a cosine index: rescaled to [0, 1] like Neo4j's
  // score. For an `l2sq` index it is already 1 / (1 + d²), Neo4j's euclidean score.
  // Memgraph's index also returns nodes deleted since its last garbage collection: each hit is
  // matched again by id (null when deleted, filtered out below, still counted as fetched).
  // FalkorDB's index is found by label and property, and returns a distance (lower is closer):
  // rescaled to Neo4j's score.
  const falkordbIndex = falkordb
    ? `${ctx.param(field.inheritedFrom ? ctx.node(field.inheritedFrom).label : model.label)}, ${ctx.param(field.name)}`
    : "";
  const call = (count: string) =>
    memgraph
      ? `CALL vector_search.search(${name}, ${count}, ${vec}) YIELD node AS hit, similarity ` +
        `OPTIONAL MATCH (node) WHERE id(node) = id(hit) ` +
        `WITH node, ${index.similarity === "euclidean" ? "similarity" : "(1 + similarity) / 2"} AS score`
      : falkordb
        ? `CALL db.idx.vector.queryNodes(${falkordbIndex}, ${count}, ${vec}) ` +
          `YIELD node, score AS distance WITH node, ${falkordbScore(index.similarity, "distance")} AS score`
        : `CALL db.index.vector.queryNodes(${name}, ${count}, ${vec}) YIELD node, score`;

  if (!where && !memgraph) {
    let text = `${call(ctx.param(intParam(candidates)))} WITH node AS n, score`;
    if (scoreOk) text += ` WHERE ${scoreOk}`;
    text += ` WITH n, score ORDER BY score DESC LIMIT ${limit}`;
    text += ` RETURN ${expr} AS row, score ORDER BY score DESC`;
    const rows = await exec(text, ctx.params);
    return decode(rows as { row: unknown; score: unknown }[]);
  }

  // Filtered: one statement per attempt, reporting how many hits the index gave (to know when it
  // is exhausted) and the lowest score among them (to stop once below minScore).
  const count = "$cyphraCandidates";
  const filter = [memgraph ? "n IS NOT NULL" : null, scoreOk, where].filter(Boolean).join(" AND ");
  const text =
    `${call(count)} WITH collect({n: node, s: score}) AS hits ` +
    `CALL { WITH hits UNWIND hits AS h WITH h.n AS n, h.s AS score WHERE ${filter} ` +
    `WITH n, score ORDER BY score DESC LIMIT ${limit} ` +
    `RETURN collect({row: ${expr}, score: score}) AS rows } ` +
    `RETURN size(hits) AS fetched, hits[-1].s AS lowest, rows`;
  let asked = Math.min(candidates, maxCandidates);
  for (;;) {
    const [res] = await exec(text, { ...ctx.params, cyphraCandidates: intParam(asked) });
    const rows = (res?.rows ?? []) as { row: unknown; score: unknown }[];
    const fetched = decodeCount(res?.fetched);
    const lowest = res?.lowest;
    const exhausted =
      fetched < asked ||
      asked >= maxCandidates ||
      (minScore !== undefined &&
        lowest !== null &&
        lowest !== undefined &&
        toScore(lowest) < minScore);
    if (rows.length >= k || exhausted) return decode(rows);
    asked = Math.min(asked * CANDIDATE_GROWTH, maxCandidates);
  }
}

/** FalkorDB: the distance between vectors `a` and `b` (`vec.cosineDistance` is `1 - cos`). */
function falkordbDistance(similarity: string, a: string, b: string): string {
  return similarity === "euclidean"
    ? `vec.euclideanDistance(${a}, ${b})`
    : `vec.cosineDistance(${a}, ${b})`;
}

/** FalkorDB: Neo4j's score for a distance `d`: `1 / (1 + d²)` (euclidean), `1 - d / 2` (cosine). */
function falkordbScore(similarity: string, d: string): string {
  return similarity === "euclidean" ? `1.0 / (1.0 + ${d} ^ 2)` : `1.0 - ${d} / 2.0`;
}

/**
 * Memgraph: Neo4j's `vector.similarity.cosine` / `.euclidean` scores of `a` and `b`:
 * `(1 + cos) / 2` and `1 / (1 + d²)`. Memgraph only has the raw cosine
 * (`vector_search.cosine_similarity`); the squared distance is summed in Cypher.
 */
function memgraphSimilarity(ctx: QueryContext, similarity: string, a: string, b: string): string {
  if (similarity !== "euclidean") return `(1 + vector_search.cosine_similarity(${a}, ${b})) / 2`;
  const i = ctx.variable("i");
  const sum = `reduce(acc = 0.0, ${i} IN range(0, size(${b}) - 1) | acc + (${a}[${i}] - ${b}[${i}]) ^ 2)`;
  return `1.0 / (1.0 + ${sum})`;
}
