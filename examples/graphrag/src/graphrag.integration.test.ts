import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type Db } from "./cyphra.gen.js";
import { hashingEmbedder } from "./embeddings.js";
import { dictionaryExtractor } from "./entities.js";
import { ingest } from "./ingest.js";
import { entityWeights, retrieve } from "./retrieve.js";
import { loadSampleDocuments, sampleDictionary } from "./sample.js";
import { applySchema } from "./setup.js";

const { NEO4J_TEST_URI, NEO4J_TEST_USER, NEO4J_TEST_PASSWORD } = process.env;
const hasNeo = Boolean(NEO4J_TEST_URI && NEO4J_TEST_USER && NEO4J_TEST_PASSWORD);

describe.skipIf(!hasNeo)("GraphRAG example (Neo4j)", () => {
  let db: Db;
  const embedder = hashingEmbedder();
  const extractor = dictionaryExtractor(sampleDictionary);
  const wipe = () => db.$cypher`MATCH (n) WHERE n:Document OR n:Chunk OR n:Entity DETACH DELETE n`;
  const graphSize = async () => {
    const [row] = await db.$cypher<{ chunks: number; entities: number; related: number }>`
      RETURN COUNT { (:Chunk) } AS chunks, COUNT { (:Entity) } AS entities,
             COUNT { (:Entity)-[:RELATED_TO]->(:Entity) } AS related`;
    return row!;
  };

  beforeAll(async () => {
    db = createClient({
      uri: NEO4J_TEST_URI!,
      user: NEO4J_TEST_USER!,
      password: NEO4J_TEST_PASSWORD!,
    });
    await applySchema(db);
    await wipe();
    const stats = await ingest(db, await loadSampleDocuments(), { embedder, extractor });
    expect(stats).toEqual({ documents: 4, chunks: 12, entities: 20 });
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  it("stores chunks in reading order, with their entities", async () => {
    const doc = await db.document.findUniqueOrThrow({
      where: { id: "ada-lovelace" },
      select: {
        title: true,
        chunks: {
          orderBy: { position: "asc" },
          select: {
            id: true,
            next: { select: { id: true } },
            entities: { select: { name: true } },
          },
        },
      },
    });
    expect(doc.title).toBe("Ada Lovelace");
    expect(doc.chunks.map((c) => [c.id, c.next?.id ?? null])).toEqual([
      ["ada-lovelace#0", "ada-lovelace#1"],
      ["ada-lovelace#1", "ada-lovelace#2"],
      ["ada-lovelace#2", null],
    ]);
    expect(doc.chunks[2]!.entities.map((e) => e.name).sort()).toEqual([
      "Analytical Engine",
      "Bernoulli numbers",
      "Note G",
    ]);
  });

  it("finds the chunk that answers the question first, with its neighbour and citations", async () => {
    const r = await retrieve(db, "Who wrote the first computer program?", { embedder });
    expect(r.chunks[0]).toMatchObject({
      id: "ada-lovelace#2",
      via: "match",
      matchedBy: ["vector", "fulltext"],
    });
    expect(r.chunks[1]).toMatchObject({ id: "ada-lovelace#1", via: "neighbour" });
    expect(r.context).toMatch(
      /^\[1\] Ada Lovelace › Note G and the Bernoulli numbers \(docs\/ada-lovelace\.md\)\nThe last of her notes, Note G,/,
    );
    expect(r.context).toContain("\n\n[2] Ada Lovelace › The translation and its notes");
  });

  it.each([
    ["How was the 1890 census counted?", "tabulating-machine#0"],
    ["Which company did Hollerith found?", "tabulating-machine#1"],
    ["What did the Jacquard loom weave?", "jacquard-loom#2"],
    ["What did Menabrea publish?", "ada-lovelace#1"],
  ])("%s → %s", async (question, expected) => {
    const r = await retrieve(db, question, { embedder });
    expect(r.chunks[0]!.id).toBe(expected);
  });

  it("follows RELATED_TO for up to two hops, weighting entities by distance", async () => {
    expect(await entityWeights(db, ["luigi-menabrea"], 0)).toEqual(
      new Map([["luigi-menabrea", 1]]),
    );
    const oneHop = await entityWeights(db, ["luigi-menabrea"], 1);
    expect([...oneHop].sort()).toEqual([
      ["ada-lovelace", 0.5],
      ["analytical-engine", 0.5],
      ["luigi-menabrea", 1],
    ]);
    const twoHops = await entityWeights(db, ["luigi-menabrea"], 2);
    expect(twoHops.get("charles-babbage")).toBeCloseTo(1 / 3);
    expect(twoHops.get("herman-hollerith")).toBeUndefined(); // three hops away
  });

  it("adds chunks of other documents through shared and related entities", async () => {
    const question = "What did Menabrea publish?";
    const direct = await retrieve(db, question, { embedder, k: 1, neighboursOf: 0, entityHops: 0 });
    expect(direct.chunks.map((c) => [c.id, c.via])).toEqual([
      ["ada-lovelace#1", "match"],
      ["ada-lovelace#0", "entity"],
      ["ada-lovelace#2", "entity"],
    ]);

    // One hop further, Charles Babbage (related to Ada Lovelace and the Analytical Engine) brings
    // in the Analytical Engine document.
    const related = await retrieve(db, question, {
      embedder,
      k: 1,
      neighboursOf: 0,
      entityHops: 1,
    });
    const fromOtherDoc = related.chunks.find((c) => c.documentId === "analytical-engine");
    expect(fromOtherDoc).toMatchObject({ id: "analytical-engine#1", via: "entity" });
    expect(fromOtherDoc!.entities).toEqual(
      expect.arrayContaining(["Analytical Engine", "Charles Babbage"]),
    );
  });

  it("re-ingests a document without duplicating chunks or edges", async () => {
    const before = await graphSize();
    const docs = await loadSampleDocuments();
    await ingest(
      db,
      docs.filter((d) => d.id === "jacquard-loom"),
      { embedder, extractor },
    );
    expect(await graphSize()).toEqual(before);
    expect(before).toEqual({ chunks: 12, entities: 20, related: 43 });
  });
});
