import type { OrderByInput, WhereInput } from "cyphra";
import type { CyphraTypeMap, Db } from "./cyphra.gen.js";
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
  /**
   * Fused rank score for matches; for `entity` chunks, the number of entities linking them to the
   * matches; 0 for neighbours.
   */
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
  /** Only follow RELATED_TO edges of at least this weight, chunks relating both (default 1). */
  minWeight?: number;
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
 *    within `entityHops` RELATED_TO hops (one `traverse` across models, see {@link expandEntities}).
 * 3. A numbered context block with a citation for every chunk.
 */
export async function retrieve(
  db: Db,
  question: string,
  options: RetrieveOptions,
): Promise<Retrieval> {
  const { embedder, extractor, k = 3, candidates = 10, neighboursOf = 1 } = options;
  const { entityHops = 2, entityChunks = 2, minWeight = 1 } = options;
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
    const expansion = await expandEntities(db, [...seeds], {
      hops: entityHops,
      minWeight,
      exclude: [...included],
      take: entityChunks,
    });
    for (const c of expansion) {
      const entities = c.entities.map((e) => e.name);
      add(
        toChunk(c, c.document!, { via: "entity", matchedBy: [], score: entities.length, entities }),
      );
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

/** Entities within `hops` RELATED_TO hops (either direction) of the seeds, as a filter. */
export function nearEntities(
  seeds: readonly string[],
  hops: number,
): WhereInput<CyphraTypeMap, "Entity"> {
  if (hops === 0) return { id: { in: [...seeds] } };
  const closer = nearEntities(seeds, hops - 1);
  return { OR: [closer, { related: { some: closer } }, { relatedFrom: { some: closer } }] };
}

export interface ExpandOptions {
  /** RELATED_TO hops followed from the seeds (0: only the chunks mentioning a seed). */
  hops: number;
  /** Only follow RELATED_TO edges of at least this weight (default 1: all of them). */
  minWeight?: number;
  /** Chunk ids to leave out (the ones already in the context). */
  exclude?: readonly string[];
  take: number;
}

/**
 * The chunks that mention a seed entity, or an entity related to one within `hops` RELATED_TO
 * hops, in one statement: a `traverse` across models, Entity → (RELATED_TO × 0..hops) → Entity →
 * Chunk. They are ranked by how many seeds they mention, then how many entities one hop away, two
 * hops away… (`orderBy` on relation counts filtered by distance), and each comes with the
 * entities that link it to the seeds. The distance tiers count RELATED_TO edges of any weight.
 */
export async function expandEntities(db: Db, seeds: readonly string[], options: ExpandOptions) {
  const { hops, minWeight = 1, exclude = [], take } = options;
  if (seeds.length === 0 || take === 0) return [];
  const tiers: OrderByInput<CyphraTypeMap, "Chunk"> = [
    ...Array.from({ length: hops + 1 }, (_, d) => ({
      entities: { _count: "desc" as const, where: nearEntities(seeds, d) },
    })),
    { id: "asc" },
  ];
  const args = {
    from: { id: { in: [...seeds] } },
    where: { id: { notIn: [...exclude] } },
    orderBy: tiers,
    take,
    select: {
      ...chunkSelect,
      entities: {
        where: nearEntities(seeds, hops),
        orderBy: { name: "asc" as const },
        select: { id: true, name: true },
      },
    },
  };
  return hops === 0
    ? db.entity.traverse({ ...args, via: [{ rel: "chunks" }] })
    : db.entity.traverse({
        ...args,
        via: [
          {
            rel: "related",
            direction: "both", // co-occurrence has no direction
            depth: { min: 0, max: hops },
            edgeWhere: { weight: { gte: minWeight } },
          },
          { rel: "chunks" },
        ],
      });
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
