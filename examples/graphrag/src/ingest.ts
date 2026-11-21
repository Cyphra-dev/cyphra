import { chunkMarkdown, type ChunkOptions } from "./chunk.js";
import type { Db } from "./cyphra.gen.js";
import type { Embedder } from "./embeddings.js";
import { entityId, type EntityExtractor } from "./entities.js";

export interface SourceDocument {
  id: string;
  title: string;
  /** Where the document comes from (path, URL): returned with every citation. */
  source: string;
  markdown: string;
}

export interface IngestOptions extends ChunkOptions {
  embedder: Embedder;
  extractor: EntityExtractor;
}

export interface IngestStats {
  documents: number;
  chunks: number;
  entities: number;
}

/**
 * Chunk, embed and extract each document, then write it in one transaction:
 * `(Document)-[:HAS_CHUNK]->(Chunk)`, `(Chunk)-[:NEXT]->(Chunk)` in reading order,
 * `(Chunk)-[:MENTIONS]->(Entity)` and `(Entity)-[:RELATED_TO]->(Entity)`.
 *
 * Re-ingesting a document replaces its chunks. Entities are shared between documents and kept.
 */
export async function ingest(
  db: Db,
  documents: readonly SourceDocument[],
  { embedder, extractor, maxChars }: IngestOptions,
): Promise<IngestStats> {
  const stats: IngestStats = { documents: 0, chunks: 0, entities: 0 };
  const seenEntities = new Set<string>();

  for (const doc of documents) {
    // The slow, external work (embedding, extraction) happens before the write transaction.
    const chunks = chunkMarkdown(doc.markdown, { maxChars });
    const vectors = await embedder.embed(
      // The heading gives a short chunk the context of its section.
      chunks.map((c) => (c.heading ? `${c.heading}\n${c.text}` : c.text)),
    );
    const extractions = await Promise.all(chunks.map((c) => extractor.extract(c.text)));
    const chunkId = (position: number) => `${doc.id}#${position}`;

    await db.$transaction(async (tx) => {
      await tx.chunk.deleteMany({ where: { document: { is: { id: doc.id } } } });
      await tx.document.deleteMany({ where: { id: doc.id } });

      const entities = new Map(
        extractions.flatMap((x) => x.entities).map((e) => [entityId(e.name), e]),
      );
      for (const [id, e] of entities) {
        await tx.entity.upsert({
          where: { id },
          create: { id, name: e.name, type: e.type },
          update: {},
        });
        seenEntities.add(id);
      }

      await tx.document.create({
        data: {
          id: doc.id,
          title: doc.title,
          source: doc.source,
          chunks: {
            create: chunks.map((c, i) => ({
              id: chunkId(c.position),
              position: c.position,
              heading: c.heading,
              text: c.text,
              embedding: vectors[i]!,
              entities: {
                connect: extractions[i]!.entities.map((e) => ({ id: entityId(e.name) })),
              },
            })),
          },
        },
      });

      for (const c of chunks.slice(1)) {
        await tx.chunk.update({
          where: { id: chunkId(c.position - 1) },
          data: { next: { connect: { id: chunkId(c.position) } } },
        });
      }

      // `connect` MERGEs the edge, so a pair mentioned together many times keeps one edge.
      for (const r of extractions.flatMap((x) => x.relations)) {
        const [from, to] = [entityId(r.from), entityId(r.to)].sort();
        if (from === to || !entities.has(from!) || !entities.has(to!)) continue;
        await tx.entity.update({
          where: { id: from! },
          data: { related: { connect: { id: to! } } },
        });
      }
    });

    stats.documents++;
    stats.chunks += chunks.length;
  }
  stats.entities = seenEntities.size;
  return stats;
}
