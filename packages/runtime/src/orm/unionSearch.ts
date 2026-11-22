/**
 * `search` and `findSimilar` over a union: one index per member, merged by rank.
 *
 * Scores of different indexes are not comparable: Lucene's (BM25) depend on each index's
 * statistics, and vector indexes may use different similarity functions. So the hits of each
 * member's index are ranked on their own, and the lists are merged with reciprocal rank fusion
 * (RRF): a node's fused score is `Σ 1 / (k + rank)` over the lists it appears in (`k` = 60 by
 * default, `rrfK`), its rank in each list counting from 1.
 *
 * Each list is also min-max normalised (`(score - min) / (max - min)` over the hits that index
 * contributes, `1` when they all score the same), reported in `$scores` and used to break ties.
 * The order is total: fused score (desc), best normalised score (desc), the member's position in
 * the search (`indexes` / `fields` order, else the union's), then the node's id. Within one list,
 * hits with the same raw score are ranked by node id, so the result is deterministic.
 *
 * One read-only statement: a `CALL { … }` subquery per index collects its hits (filtered by the
 * union `where`, ranked, cut to the `skip + take` best), then the lists are fused, paged and
 * projected (`select` / `include`, per member with `$on`), so related nodes are loaded for the
 * page only. Subqueries chained this way (rather than a `UNION` inside one `CALL`) give each index
 * its own list, which ranking needs, and run unchanged on Neo4j, Memgraph and FalkorDB.
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
  labelTest,
  memberNames,
  nonNegativeInt,
  unionMembers,
} from "./compile.js";
import { CyphraValidationError } from "./errors.js";
import { SEARCH_MODES, falkordbFulltextCall, fulltextCall, isSearchMode } from "./fulltext.js";
import { decodeCount, encodeVector } from "./values.js";
import { vectorField, vectorIndexCall } from "./vector.js";

type AnyRecord = Record<string, unknown>;
type Executor = (text: string, params: AnyRecord) => Promise<AnyRecord[]>;

/** Default `k` of reciprocal rank fusion (the constant of the original RRF paper). */
export const DEFAULT_RRF_K = 60;

const SEARCH_KEYS = new Set([
  "query",
  "mode",
  "indexes",
  "where",
  "minScore",
  "skip",
  "take",
  "rrfK",
  "scores",
  "select",
  "include",
]);

const SIMILAR_KEYS = new Set([
  "vector",
  "fields",
  "where",
  "minScore",
  "candidates",
  "skip",
  "take",
  "rrfK",
  "scores",
  "select",
  "include",
]);

/** One member's list: the procedure call yielding `node, score`, and its filters. */
type Branch = {
  /** The index (search) or field (findSimilar) name, as `$scores` reports it. */
  readonly index: string;
  readonly call: string;
  readonly filters: readonly string[];
};

/** A compiled union search: run `text` with `params`, then `decode` its rows. */
export type CompiledUnionSearch = {
  readonly text: string;
  readonly params: AnyRecord;
  readonly decode: (rows: readonly AnyRecord[]) => AnyRecord[];
};

/** Per-index detail of a hit (`scores: true`). */
export type IndexScore = { score: number; normalized: number; rank: number };

function toNumber(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

function checkKeys(args: AnyRecord, keys: ReadonlySet<string>, op: string, hints: AnyRecord) {
  for (const key of Object.keys(args)) {
    if (keys.has(key)) continue;
    const hint = hints[key];
    throw new CyphraValidationError(
      `${op}: unknown argument "${key}"${typeof hint === "string" ? ` (${hint})` : ""}.`,
    );
  }
}

/** The options both searches share. */
function common(args: AnyRecord, op: string) {
  const minScore = args.minScore;
  if (minScore !== undefined && (typeof minScore !== "number" || !Number.isFinite(minScore))) {
    throw new CyphraValidationError(`${op}: minScore must be a finite number.`);
  }
  const k = args.rrfK ?? DEFAULT_RRF_K;
  if (typeof k !== "number" || !Number.isFinite(k) || k < 0) {
    throw new CyphraValidationError(`${op}: rrfK must be a non-negative number.`);
  }
  if (args.scores !== undefined && typeof args.scores !== "boolean") {
    throw new CyphraValidationError(`${op}: scores must be a boolean.`);
  }
  const skip = args.skip === undefined ? undefined : nonNegativeInt(args.skip, `${op}: skip`);
  return { minScore: minScore as number | undefined, k, skip, scores: args.scores === true };
}

/**
 * The members a union search goes through, each with its index (or vector field): the ones named
 * in `spec` (`{ Member: name }`), else every member with exactly one candidate.
 */
function resolveMembers(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  op: string,
  spec: unknown,
  arg: "indexes" | "fields",
  what: string,
  whats: string,
  candidates: (m: ResolvedNodeModel) => readonly string[],
): { member: ResolvedNodeModel; name: string }[] {
  const allowed = memberNames(model);
  if (spec === undefined) {
    const out: { member: ResolvedNodeModel; name: string }[] = [];
    for (const name of unionMembers(model)) {
      const member = ctx.node(name);
      const options = candidates(member);
      if (options.length > 1) {
        throw new CyphraValidationError(
          `${op}: ${name} has several ${whats} (${options.join(", ")}); name the one to search in ${arg}: { ${name}: "…" }.`,
        );
      }
      if (options.length === 1) out.push({ member, name: options[0]! });
    }
    if (out.length === 0) {
      throw new CyphraValidationError(`${op}: no member of ${model.name} has a ${what}.`);
    }
    return out;
  }
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new CyphraValidationError(
      `${op}: ${arg} must be an object: { <member>: <${what}> } (members: ${allowed.join(", ")}).`,
    );
  }
  const out: { member: ResolvedNodeModel; name: string }[] = [];
  for (const [key, value] of Object.entries(spec as AnyRecord)) {
    if (value === undefined) continue;
    if (!allowed.includes(key)) {
      throw new CyphraValidationError(
        `${op}: ${arg}.${key}: not a member of ${model.name} (${allowed.join(", ")}).`,
      );
    }
    const member = ctx.node(key);
    const options = candidates(member);
    if (typeof value !== "string" || !options.includes(value)) {
      throw new CyphraValidationError(
        `${op}: ${arg}.${key}: ${JSON.stringify(value)} is not a ${what} of ${key} (${options.join(", ") || "it has none"}).`,
      );
    }
    out.push({ member, name: value });
  }
  if (out.length === 0) {
    throw new CyphraValidationError(`${op}: ${arg} names no member to search.`);
  }
  return out;
}

/** The node's id, for a deterministic order between equal scores. */
function nodeId(ctx: QueryContext, alias: string): string {
  return ctx.dialect === "neo4j" ? `elementId(${alias})` : `id(${alias})`;
}

/**
 * The statement fusing `branches`: one `CALL { … }` per list, then RRF, paging and the
 * projection. `window` cuts each list to its best hits (`skip + take`).
 */
function fuse(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  args: AnyRecord,
  branches: readonly Branch[],
  o: {
    k: number;
    skip: number | undefined;
    take: number | undefined;
    window: number | undefined;
    scores: boolean;
  },
): CompiledUnionSearch {
  const id = nodeId(ctx, "n");
  const window = o.window === undefined ? "" : ` LIMIT ${ctx.param(intParam(o.window))}`;
  const lists = branches.map(() => ctx.variable("hits"));
  let text = branches
    .map((b, i) => {
      const where = b.filters.length ? ` WHERE ${b.filters.join(" AND ")}` : "";
      return (
        `CALL { ${b.call} WITH node AS n, score${where} ` +
        `WITH n, score ORDER BY score DESC, ${id} ASC${window} ` +
        `RETURN collect({n: n, s: score}) AS ${lists[i]} }`
      );
    })
    .join(" ");
  const k = ctx.param(o.k);
  text +=
    ` WITH [${lists.join(", ")}] AS lists` +
    ` UNWIND range(0, size(lists) - 1) AS li` +
    ` WITH li, lists[li] AS hits` +
    ` UNWIND range(0, size(hits) - 1) AS pos` +
    ` WITH li, hits[pos].n AS n, hits[pos].s AS score, pos + 1 AS rank,` +
    ` hits[0].s AS hi, hits[size(hits) - 1].s AS lo` +
    ` WITH n, li, score, rank, CASE WHEN hi = lo THEN 1.0 ELSE (score - lo) / (hi - lo) END AS norm` +
    ` WITH n, sum(1.0 / (${k} + rank)) AS fused, max(norm) AS best, min(li) AS first,` +
    ` collect({li: li, score: score, norm: norm, rank: rank}) AS parts` +
    ` ORDER BY fused DESC, best DESC, first ASC, ${id} ASC`;
  if (o.skip !== undefined) text += ` SKIP ${ctx.param(intParam(o.skip))}`;
  if (o.take !== undefined) text += ` LIMIT ${ctx.param(intParam(o.take))}`;
  const { expr, shape } = compileProjection(ctx, model, "n", args);
  text +=
    ` RETURN ${expr} AS row, fused, best, first, ${id} AS key, parts` +
    ` ORDER BY fused DESC, best DESC, first ASC, key ASC`;
  const decode = (rows: readonly AnyRecord[]) =>
    rows.map((r) => {
      const out: AnyRecord = { ...decodeRow(shape, r.row)!, $score: toNumber(r.fused) };
      if (o.scores) {
        const parts = (r.parts as AnyRecord[])
          .map((p) => ({
            li: decodeCount(p.li),
            score: toNumber(p.score),
            normalized: toNumber(p.norm),
            rank: decodeCount(p.rank),
          }))
          .sort((a, b) => a.li - b.li);
        const scores: Record<string, IndexScore> = {};
        for (const p of parts) {
          scores[branches[p.li]!.index] = {
            score: p.score,
            normalized: p.normalized,
            rank: p.rank,
          };
        }
        out.$scores = scores;
      }
      return out;
    });
  return { text, params: ctx.params, decode };
}

/**
 * Compile a full-text `search` over the union `model`: `null` when nothing can match (a blank
 * query, `take: 0`).
 */
export function compileUnionSearch(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  args: AnyRecord,
): CompiledUnionSearch | null {
  const op = `${model.name}.search`;
  checkKeys(args, SEARCH_KEYS, op, {
    index: "a union searches one index per member: indexes: { <member>: <index> }",
  });
  if (typeof args.query !== "string") {
    throw new CyphraValidationError(`${op}: query must be a string.`);
  }
  const mode = args.mode ?? "lucene";
  if (!isSearchMode(mode)) {
    throw new CyphraValidationError(`${op}: mode must be ${SEARCH_MODES.join(", ")}.`);
  }
  const { minScore, k, skip, scores } = common(args, op);
  const take = args.take === undefined ? undefined : nonNegativeInt(args.take, `${op}: take`);
  const members = resolveMembers(
    ctx,
    model,
    op,
    args.indexes,
    "indexes",
    "@@fulltext index",
    "@@fulltext indexes",
    (m) => (m.fulltextIndexes ?? []).map((i) => i.name),
  );
  const where = compileWhere(ctx, model, "n", args.where);
  const scoreOk = minScore === undefined ? null : `score >= ${ctx.param(minScore)}`;
  // Lucene rejects an empty query: a blank search box simply matches nothing.
  if (args.query.trim() === "" || take === 0) return null;
  const window = take === undefined ? undefined : (skip ?? 0) + take;
  const branches: Branch[] = [];
  for (const { member, name } of members) {
    // An index inherited from an interface covers every implementation: keep this member's nodes.
    const inherited = member.fulltextIndexes!.find((i) => i.name === name)!.inheritedFrom;
    const filters = [inherited ? labelTest("n", member) : null, scoreOk, where]
      .filter((f): f is string => f !== null)
      .map((f) => `(${f})`);
    let call: string | null;
    if (ctx.dialect === "falkordb") {
      // FalkorDB has one full-text index per label, queried by label.
      call = falkordbFulltextCall(
        ctx,
        inherited ? ctx.node(inherited).label : member.label,
        args.query,
        mode,
      );
    } else {
      // Unfiltered: let Lucene collect only the hits the fusion can use.
      call = fulltextCall(ctx, name, args.query, mode, filters.length ? undefined : window);
    }
    if (call !== null) branches.push({ index: name, call, filters });
  }
  if (branches.length === 0) return null;
  return fuse(ctx, model, args, branches, { k, skip, take, window, scores });
}

/** Compile a `findSimilar` over the union `model`. */
export function compileUnionFindSimilar(
  ctx: QueryContext,
  model: ResolvedNodeModel,
  args: AnyRecord,
): CompiledUnionSearch | null {
  const op = `${model.name}.findSimilar`;
  checkKeys(args, SIMILAR_KEYS, op, {
    k: "a union search is paged after fusion: use take (and skip)",
    field: "a union searches one vector field per member: fields: { <member>: <field> }",
    exact: "a union search goes through the members' vector indexes",
  });
  const { minScore, k, skip, scores } = common(args, op);
  if (args.take === undefined) throw new CyphraValidationError(`${op}: take is required.`);
  const take = nonNegativeInt(args.take, `${op}: take`);
  const window = (skip ?? 0) + take;
  const members = resolveMembers(
    ctx,
    model,
    op,
    args.fields,
    "fields",
    "@vectorIndex field",
    "@vectorIndex fields",
    (m) =>
      m.fields
        .filter((f): f is ResolvedScalarField => f.kind === "scalar" && Boolean(f.vectorIndex))
        .map((f) => f.name),
  );
  const resolved = members.map(({ member, name }) => ({
    member,
    field: vectorField(member, name, op),
  }));
  // One parameter for the query vector, checked against every searched field's dimensions.
  let vector: number[] | undefined;
  for (const { member, field } of resolved) {
    vector = encodeVector(
      args.vector,
      field.dimensions ?? 0,
      `${op} vector (${member.name}.${field.name})`,
    );
  }
  const where = compileWhere(ctx, model, "n", args.where);
  const candidates =
    args.candidates === undefined
      ? where
        ? Math.max(10 * window, 100)
        : window
      : nonNegativeInt(args.candidates, `${op}: candidates`);
  if (candidates < window) {
    throw new CyphraValidationError(`${op}: candidates must be at least skip + take (${window}).`);
  }
  if (take === 0) return null;
  const vec = ctx.param(vector!);
  const scoreOk = minScore === undefined ? null : `score >= ${ctx.param(minScore)}`;
  const count = ctx.param(intParam(candidates));
  const branches: Branch[] = resolved.map(({ member, field }) => {
    const filters = [
      ctx.dialect === "memgraph" ? "n IS NOT NULL" : null,
      // An index inherited from an interface covers every implementation: keep this member's.
      field.inheritedFrom ? labelTest("n", member) : null,
      scoreOk,
      where,
    ]
      .filter((f): f is string => f !== null)
      .map((f) => `(${f})`);
    return {
      index: field.vectorIndex!.name,
      call: vectorIndexCall(ctx, member, field, vec, count),
      filters,
    };
  });
  return fuse(ctx, model, args, branches, { k, skip, take, window, scores });
}

/** Run a union `search` through `exec`; rows come back best first, with `$score`. */
export async function unionSearch(
  exec: Executor,
  ctx: QueryContext,
  model: ResolvedNodeModel,
  args: AnyRecord,
): Promise<AnyRecord[]> {
  const c = compileUnionSearch(ctx, model, args);
  return c ? c.decode(await exec(c.text, c.params)) : [];
}

/** Run a union `findSimilar` through `exec`; rows come back best first, with `$score`. */
export async function unionFindSimilar(
  exec: Executor,
  ctx: QueryContext,
  model: ResolvedNodeModel,
  args: AnyRecord,
): Promise<AnyRecord[]> {
  const c = compileUnionFindSimilar(ctx, model, args);
  return c ? c.decode(await exec(c.text, c.params)) : [];
}
