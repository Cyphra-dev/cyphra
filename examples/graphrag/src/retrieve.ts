import type { Db } from "./cyphra.gen.js";
import type { Embedder } from "./embeddings.js";
import { entityId, type EntityExtractor } from "./entities.js";

/**
 * Reciprocal rank fusion: merge ranked lists whose scores are not comparable (cosine similarity,
 * BM25) by rank alone. An item at rank r (0-based) in a list gets `1 / (k + r + 1)` from that list;
 * `k = 60` is the value of the original paper and works well without tuning.
 */
export function reciprocalRankFusion(
  lists: readonly (readonly string[])[],
  k = 60,
): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** What each retrieval step loads for a chunk: its text, document, neighbours and entities. */
const chunkSelect = {
  id: true,
  position: true,
  heading: true,
  text: true,
  document: { select: { id: true, title: true, source: true } },
  previous: { select: { id: true, position: true, heading: true, text: true } },
  next: { select: { id: true, position: true, heading: true, text: true } },
  entities: { select: { id: true, name: true } },
} as const;

export interface RetrievedChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  source: string;
  position: number;
  heading: string | null;
  text: string;
  /**
   * `match`: found by vector and/or full-text search. `neighbour`: the chunk before or after a match.
   * `entity`: mentions an entity of a match, or one related to it.
   */
  via: "match" | "neighbour" | "entity";
  /** Which searches found a `match` chunk. */
  matchedBy: ("vector" | "fulltext")[];
  /** Fused rank score for matches, entity score for `entity` chunks, 0 for neighbours. */
  score: number;
  /** Entity names that connect an `entity` chunk to the matches. */
  entities: string[];
}

export interface Retrieval {
  question: string;
  chunks: RetrievedChunk[];
  /** The chunks as a numbered context block, `[1]`, `[2]`…, ready for a prompt. */
  context: string;
}

export interface RetrieveOptions {
  embedder: Embedder;
  /** Also look for entities in the question itself (they count as matches' entities). */
  extractor?: EntityExtractor;
  /** Fused matches kept (default 3). */
  k?: number;
  /** Hits asked from each search before fusion (default 10). */
  candidates?: number;
  /** Add the previous and next chunk of the first `neighboursOf` matches (default 1, 0 = off). */
  neighboursOf?: number;
  /** Entity hops followed over RELATED_TO (default 2, 0 = only the matches' own entities). */
  entityHops?: number;
  /** Chunks added through entities (default 2, 0 = off). */
  entityChunks?: number;
}

/**
 * Hybrid GraphRAG retrieval:
 *
 * 1. `findSimilar` on the question's embedding and full-text `search` on its words, merged with
 *    reciprocal rank fusion. Each hit loads its document, neighbours and entities in the same query.
 * 2. Graph expansion: the chunks right before and after the best matches (same document), and the
 *    chunks of other sections that mention the matches' entities, or entities related to them
 *    within `entityHops` RELATED_TO hops (`traverse`).
 * 3. A numbered context block with a citation for every chunk.
 */
export async function retrieve(
  db: Db,
  question: string,
  options: RetrieveOptions,
): Promise<Retrieval> {
  const { embedder, extractor, k = 3, candidates = 10, neighboursOf = 1 } = options;
  const { entityHops = 2, entityChunks = 2 } = options;
  const [vector] = await embedder.embed([question]);

  // 1. Two searches, run in parallel, fused by rank.
  const [similar, keyword] = await Promise.all([
    db.chunk.findSimilar({
      field: "embedding",
      vector: vector!,
      k: candidates,
      select: chunkSelect,
    }),
    db.chunk.search({
      index: "chunkText",
      query: question,
      mode: "terms", // the question is plain text, not Lucene syntax
      take: candidates,
      select: chunkSelect,
    }),
  ]);
  const byId = new Map([...similar, ...keyword].map((c) => [c.id, c]));
  const fused = reciprocalRankFusion([similar.map((c) => c.id), keyword.map((c) => c.id)]);
  const matches = fused.slice(0, k).map(({ id, score }) => ({ hit: byId.get(id)!, score }));

  const result: RetrievedChunk[] = [];
  const included = new Set<string>();
  const add = (chunk: RetrievedChunk) => {
    if (included.has(chunk.id)) return;
    included.add(chunk.id);
    result.push(chunk);
  };

  // 2a. Each match, then the chunks before and after it (already loaded by `select`).
  matches.forEach(({ hit, score }, i) => {
    const matchedBy = [
      ...(similar.some((c) => c.id === hit.id) ? (["vector"] as const) : []),
      ...(keyword.some((c) => c.id === hit.id) ? (["fulltext"] as const) : []),
    ];
    const entities = hit.entities.map((e) => e.name);
    add(toChunk(hit, hit.document!, { via: "match", matchedBy, score, entities }));
    if (i >= neighboursOf) return;
    for (const n of [hit.previous, hit.next]) {
      if (!n || matches.some((m) => m.hit.id === n.id)) continue;
      add(toChunk(n, hit.document!, { via: "neighbour", matchedBy: [], score: 0, entities: [] }));
    }
  });

  // 2b. Entity expansion: the matches' entities (and the question's), then related entities.
  if (entityChunks > 0) {
    const seeds = new Set(matches.flatMap(({ hit }) => hit.entities.map((e) => e.id)));
    if (extractor) {
      for (const e of (await extractor.extract(question)).entities) seeds.add(entityId(e.name));
    }
    const weights = await entityWeights(db, [...seeds], entityHops);
    const mentioning = await db.chunk.findMany({
      where: {
        id: { notIn: [...included] },
        entities: { some: { id: { in: [...weights.keys()] } } },
      },
      select: chunkSelect,
    });
    const ranked = mentioning
      .map((c) => {
        const linked = c.entities.filter((e) => weights.has(e.id));
        const score = linked.reduce((sum, e) => sum + weights.get(e.id)!, 0);
        return { c, linked, score };
      })
      .sort((a, b) => b.score - a.score || a.c.id.localeCompare(b.c.id))
      .slice(0, entityChunks);
    for (const { c, linked, score } of ranked) {
      const entities = linked.map((e) => e.name);
      add(toChunk(c, c.document!, { via: "entity", matchedBy: [], score, entities }));
    }
  }

  return { question, chunks: result, context: formatContext(result) };
}

function toChunk(
  c: { id: string; position: number; heading: string | null; text: string },
  doc: { id: string; title: string; source: string },
  how: Pick<RetrievedChunk, "via" | "matchedBy" | "score" | "entities">,
): RetrievedChunk {
  const { id, position, heading, text } = c;
  return {
    id,
    documentId: doc.id,
    documentTitle: doc.title,
    source: doc.source,
    position,
    heading,
    text,
    ...how,
  };
}

/**
 * Weight of every entity within `hops` RELATED_TO hops of the seeds: 1 for a seed, 1/2 one hop
 * away, 1/3 two hops away. `traverse` with `min: 0` returns the seeds too, and `returnPaths` gives
 * the length of the shortest path to each entity.
 */
export async function entityWeights(
  db: Db,
  seeds: readonly string[],
  hops: number,
): Promise<Map<string, number>> {
  if (seeds.length === 0) return new Map();
  if (hops === 0) return new Map(seeds.map((id) => [id, 1]));
  const reached = await db.entity.traverse({
    from: { id: { in: [...seeds] } },
    via: "related",
    direction: "both", // co-occurrence has no direction
    depth: { min: 0, max: hops },
    select: { id: true },
    returnPaths: true,
  });
  const weights = new Map<string, number>();
  for (const { node, path } of reached) {
    const w = 1 / (1 + path.edges.length);
    weights.set(node.id, Math.max(weights.get(node.id) ?? 0, w));
  }
  return weights;
}

/** `[n] Document › Section (source)` then the text, one block per chunk. */
export function formatContext(chunks: readonly RetrievedChunk[]): string {
  return chunks
    .map((c, i) => {
      const title = c.heading ? `${c.documentTitle} › ${c.heading}` : c.documentTitle;
      return `[${i + 1}] ${title} (${c.source})\n${c.text}`;
    })
    .join("\n\n");
}

/** A provider-agnostic prompt: answer from the context only, and cite it. */
export function buildPrompt(retrieval: Retrieval): string {
  return [
    "Answer the question using only the context below. Cite the passages you use with their",
    'numbers, like [2]. If the context does not contain the answer, say "I don\'t know".',
    "",
    "Context:",
    retrieval.context,
    "",
    `Question: ${retrieval.question}`,
  ].join("\n");
}
