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

  if (args.exact === true) {
    const fn =
      index.similarity === "euclidean" ? "vector.similarity.euclidean" : "vector.similarity.cosine";
    const filters = [
      `n.${prop} IS NOT NULL`,
      `size(n.${prop}) = ${ctx.param(intParam(vector.length))}`,
    ];
    if (where) filters.push(`(${where})`);
    let text = `MATCH (n:${labelExpr(model)}) WHERE ${filters.join(" AND ")}`;
    text += ` WITH n, ${fn}(n.${prop}, ${vec}) AS score`;
    if (scoreOk) text += ` WHERE ${scoreOk}`;
    text += ` WITH n, score ORDER BY score DESC LIMIT ${limit}`;
    text += ` RETURN ${expr} AS row, score ORDER BY score DESC`;
    const rows = await exec(text, ctx.params);
    return decode(rows as { row: unknown; score: unknown }[]);
  }

  const name = ctx.param(index.name);
  const call = (count: string) =>
    `CALL db.index.vector.queryNodes(${name}, ${count}, ${vec}) YIELD node, score`;

  if (!where) {
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
  const filter = [scoreOk, where].filter(Boolean).join(" AND ");
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
