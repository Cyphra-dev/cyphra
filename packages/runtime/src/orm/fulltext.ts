/**
 * `search`: full-text search on a node model through one of its `@@fulltext` indexes.
 *
 * One read-only statement: `db.index.fulltext.queryNodes(index, query)` returns every node of the
 * index matching the Lucene query, with its relevance score; `where` and `minScore` filter those
 * hits in the same statement, then the rows are ranked by score (best first) and `skip` / `take`
 * page through them. Unlike a vector search there is no top-k cut-off before the filter, so a
 * filtered search never comes back short.
 *
 * Scores are Lucene's (BM25): positive, unbounded, and only comparable within one query.
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
  and,
  labelExpr,
} from "./compile.js";
import { CyphraValidationError } from "./errors.js";

type AnyRecord = Record<string, unknown>;
type Executor = (text: string, params: AnyRecord) => Promise<AnyRecord[]>;

const ARG_KEYS = new Set([
  "index",
  "query",
  "mode",
  "where",
  "minScore",
  "skip",
  "take",
  "select",
  "include",
]);

const MODES = ["lucene", "terms", "phrase"] as const;

/** Memgraph: most hits `text_search.search_all` collects before `where` / `minScore` filter them. */
export const MEMGRAPH_TEXT_SEARCH_LIMIT = 100_000;

/** Characters with a meaning in Lucene's classic query syntax. */
const LUCENE_SPECIAL = /[+\-&|!(){}[\]^"~*?:\\/]/g;
/** Upper-case boolean operators, which Lucene reads as operators between terms. */
const LUCENE_OPERATORS = /\b(AND|OR|NOT)\b/g;

/**
 * Escape `text` for Lucene's query syntax (what `db.index.fulltext.queryNodes` parses): every
 * special character (`+ - && || ! ( ) { } [ ] ^ " ~ * ? : \ /`) and the `AND` / `OR` / `NOT`
 * operators are backslash-escaped, so user input is searched as plain words.
 *
 * @example
 * ```ts
 * escapeLucene('C++ (beta) AND "x"'); // 'C\\+\\+ \\(beta\\) \\AND \\"x\\"'
 * await db.post.search({ index: "postSearch", query: `title:${escapeLucene(input)}~` });
 * ```
 */
export function escapeLucene(text: string): string {
  return text.replace(LUCENE_SPECIAL, "\\$&").replace(LUCENE_OPERATORS, "\\$1");
}

/** The Lucene query for `query` in `mode`. */
function luceneQuery(query: string, mode: (typeof MODES)[number]): string {
  if (mode === "terms") return escapeLucene(query);
  if (mode === "phrase") return `"${escapeLucene(query)}"`;
  return query;
}

/**
 * Run a `search` on `model` through `exec` (a read transaction, or the current `$transaction`).
 * Rows come back best first, each with its `$score`.
 */
export async function search(
  exec: Executor,
  ctxFactory: () => QueryContext,
  model: ResolvedNodeModel,
  args: AnyRecord,
): Promise<AnyRecord[]> {
  const op = `${model.name}.search`;
  for (const key of Object.keys(args)) {
    if (!ARG_KEYS.has(key)) throw new CyphraValidationError(`${op}: unknown argument "${key}".`);
  }
  const indexes = model.fulltextIndexes ?? [];
  const names = indexes.map((i) => i.name);
  if (typeof args.index !== "string") {
    throw new CyphraValidationError(
      `${op}: index is required (${names.join(", ") || `${model.name} has no @@fulltext index`}).`,
    );
  }
  if (!names.includes(args.index)) {
    throw new CyphraValidationError(
      `${op}: ${JSON.stringify(args.index)} is not a full-text index of ${model.name} (${names.join(", ") || "declare one with @@fulltext"}).`,
    );
  }
  if (typeof args.query !== "string") {
    throw new CyphraValidationError(`${op}: query must be a string.`);
  }
  const mode = args.mode ?? "lucene";
  if (!(MODES as readonly unknown[]).includes(mode)) {
    throw new CyphraValidationError(`${op}: mode must be ${MODES.join(", ")}.`);
  }
  const minScore = args.minScore;
  if (minScore !== undefined && (typeof minScore !== "number" || !Number.isFinite(minScore))) {
    throw new CyphraValidationError(`${op}: minScore must be a finite number.`);
  }
  const skip = args.skip === undefined ? undefined : nonNegativeInt(args.skip, `${op}: skip`);
  const take = args.take === undefined ? undefined : nonNegativeInt(args.take, `${op}: take`);
  const ctx = ctxFactory();
  // An index inherited from an interface covers every implementation: keep this model's nodes.
  const inherited = indexes.find((i) => i.name === args.index)?.inheritedFrom;
  const where = and([
    inherited ? `n:${labelExpr(model)}` : null,
    compileWhere(ctx, model, "n", args.where),
  ]);
  const { expr, shape } = compileProjection(ctx, model, "n", args);
  // Lucene rejects an empty query: a blank search box simply matches nothing.
  if (args.query.trim() === "" || take === 0) return [];

  if (ctx.dialect === "falkordb") {
    return falkordbSearch(exec, ctx, model, inherited, args.query, mode, {
      where,
      minScore,
      skip,
      take,
      expr,
      shape,
    });
  }
  const name = ctx.param(args.index);
  const query = ctx.param(luceneQuery(args.query, mode as (typeof MODES)[number]));
  const filters = [
    ...(minScore === undefined ? [] : [`score >= ${ctx.param(minScore)}`]),
    ...(where ? [`(${where})`] : []),
  ];
  // Unfiltered and paged: let Lucene collect only the top `skip + take` hits.
  const top = filters.length === 0 && take !== undefined ? (skip ?? 0) + take : undefined;
  let text: string;
  if (ctx.dialect === "memgraph") {
    // Memgraph's text index (Tantivy) searches every indexed property and collects the top hits
    // only (1000 by default, hence an explicit, high limit). It can also return nodes deleted since
    // its last garbage collection: each hit is matched again by id.
    const limit = ctx.param(intParam(MEMGRAPH_TEXT_SEARCH_LIMIT));
    text =
      `CALL text_search.search_all(${name}, ${query}, {limit: ${limit}}) YIELD node AS hit, score ` +
      `MATCH (node) WHERE id(node) = id(hit)`;
  } else {
    const options = top === undefined ? "" : `, {limit: ${ctx.param(intParam(top))}}`;
    text = `CALL db.index.fulltext.queryNodes(${name}, ${query}${options}) YIELD node, score`;
  }
  text += " WITH node AS n, score";
  if (filters.length) text += ` WHERE ${filters.join(" AND ")}`;
  text += " WITH n, score ORDER BY score DESC";
  if (skip !== undefined) text += ` SKIP ${ctx.param(intParam(skip))}`;
  if (take !== undefined) text += ` LIMIT ${ctx.param(intParam(take))}`;
  text += ` RETURN ${expr} AS row, score ORDER BY score DESC`;
  const rows = (await exec(text, ctx.params)) as { row: unknown; score: unknown }[];
  return rows.map((r) => ({
    ...decodeRow(shape, r.row)!,
    $score: typeof r.score === "number" ? r.score : Number(r.score),
  }));
}

/**
 * FalkorDB: `db.idx.fulltext.queryNodes(label, query)`. FalkorDB has one full-text index per label
 * (RediSearch), covering every property indexed for full-text on it; queries use RediSearch's
 * syntax: `terms` searches any of the words (`w1 | w2`), `phrase` the exact phrase, `lucene` passes
 * the query through as RediSearch syntax (`graph*`, `-draft`, `%grpah%`, `@title:graph`).
 */
async function falkordbSearch(
  exec: Executor,
  ctx: QueryContext,
  model: ResolvedNodeModel,
  inheritedFrom: string | undefined,
  input: string,
  mode: unknown,
  parts: {
    where: string | null;
    minScore: unknown;
    skip: number | undefined;
    take: number | undefined;
    expr: string;
    shape: ReturnType<typeof compileProjection>["shape"];
  },
): Promise<AnyRecord[]> {
  const words = input.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  const text =
    mode === "terms" ? words.join(" | ") : mode === "phrase" ? `"${words.join(" ")}"` : input;
  if (!text || (mode !== "lucene" && words.length === 0)) return [];
  const { where, minScore, skip, take, expr, shape } = parts;
  const label = ctx.param(inheritedFrom ? ctx.node(inheritedFrom).label : model.label);
  let cypher = `CALL db.idx.fulltext.queryNodes(${label}, ${ctx.param(text)}) YIELD node, score`;
  cypher += " WITH node AS n, score";
  const filters = [
    ...(minScore === undefined ? [] : [`score >= ${ctx.param(minScore)}`]),
    ...(where ? [`(${where})`] : []),
  ];
  if (filters.length) cypher += ` WHERE ${filters.join(" AND ")}`;
  cypher += " WITH n, score ORDER BY score DESC";
  if (skip !== undefined) cypher += ` SKIP ${ctx.param(intParam(skip))}`;
  if (take !== undefined) cypher += ` LIMIT ${ctx.param(intParam(take))}`;
  cypher += ` RETURN ${expr} AS row, score ORDER BY score DESC`;
  const rows = (await exec(cypher, ctx.params)) as { row: unknown; score: unknown }[];
  return rows.map((r) => ({
    ...decodeRow(shape, r.row)!,
    $score: typeof r.score === "number" ? r.score : Number(r.score),
  }));
}
