import { describe, expect, it } from "vitest";
import { chunkMarkdown, markdownTitle } from "./chunk.js";
import { hashingEmbedder, openAICompatibleEmbedder, tokenize } from "./embeddings.js";
import { dictionaryExtractor, entityId, llmExtractor } from "./entities.js";
import { formatContext, reciprocalRankFusion, type RetrievedChunk } from "./retrieve.js";
import { loadSampleDocuments, sampleDictionary } from "./sample.js";

describe("chunkMarkdown", () => {
  const md = [
    "# Title",
    "Intro paragraph.",
    "## First",
    "One.",
    "Two.",
    "## Second",
    "Three, which is\nwrapped.",
  ].join("\n\n");

  it("merges paragraphs per section and never crosses a heading", () => {
    expect(markdownTitle(md)).toBe("Title");
    expect(chunkMarkdown(md)).toEqual([
      { position: 0, heading: null, text: "Intro paragraph." },
      { position: 1, heading: "First", text: "One.\n\nTwo." },
      { position: 2, heading: "Second", text: "Three, which is wrapped." },
    ]);
  });

  it("splits paragraphs at maxChars, between sentences", () => {
    const chunks = chunkMarkdown("Aaaa aaaa. Bbbb bbbb. Cccc cccc.\n\nDddd.", { maxChars: 22 });
    expect(chunks.map((c) => c.text)).toEqual(["Aaaa aaaa. Bbbb bbbb.", "Cccc cccc.\n\nDddd."]);
  });

  it("chunks the sample documents by section", async () => {
    const docs = await loadSampleDocuments();
    expect(docs.map((d) => d.id)).toEqual([
      "ada-lovelace",
      "analytical-engine",
      "jacquard-loom",
      "tabulating-machine",
    ]);
    for (const d of docs) expect(chunkMarkdown(d.markdown)).toHaveLength(3);
  });
});

describe("hashingEmbedder", () => {
  const cosine = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);

  it("is deterministic, normalised and of the schema's size", async () => {
    const e = hashingEmbedder();
    const [a, b] = await e.embed(["Punched cards", "Punched cards"]);
    expect(a).toHaveLength(256);
    expect(a).toEqual(b);
    expect(cosine(a!, a!)).toBeCloseTo(1, 10);
    const [empty] = await e.embed(["the of and"]);
    expect(cosine(empty!, empty!)).toBeCloseTo(1, 10);
  });

  it("puts texts that share words closer together", async () => {
    const [q, near, far] = await hashingEmbedder().embed([
      "punched card census",
      "the census used a punched card",
      "silk weaving in Lyon",
    ]);
    expect(cosine(q!, near!)).toBeGreaterThan(cosine(q!, far!));
    expect(tokenize("The Cards of Babbage's engines")).toEqual(["card", "babbage", "engine"]);
  });
});

describe("openAICompatibleEmbedder", () => {
  it("batches requests, sends the key and dimensions, and checks the size", async () => {
    const calls: { url: string; auth: string | undefined; body: { input: string[] } }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[]; dimensions: number };
      calls.push({ url, auth: (init.headers as Record<string, string>).authorization, body });
      const data = body.input
        .map((t, index) => ({ index, embedding: new Array(body.dimensions).fill(t.length) }))
        .reverse();
      return new Response(JSON.stringify({ data }));
    }) as typeof fetch;
    const e = openAICompatibleEmbedder({
      baseUrl: "https://llm.test/v1/",
      apiKey: "test-key",
      model: "m",
      dimensions: 2,
      batchSize: 2,
      fetch: fakeFetch,
    });
    expect(await e.embed(["a", "bb", "ccc"])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(calls.map((c) => c.body.input)).toEqual([["a", "bb"], ["ccc"]]);
    expect(calls[0]!.url).toBe("https://llm.test/v1/embeddings");
    expect(calls[0]!.auth).toBe("Bearer test-key");

    await expect(
      openAICompatibleEmbedder({
        baseUrl: "x",
        model: "m",
        dimensions: 3,
        fetch: (async () =>
          new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }))) as typeof fetch,
      }).embed(["a"]),
    ).rejects.toThrow(/returned 1 dimensions, the schema expects 3/);
  });
});

describe("entity extraction", () => {
  const extractor = dictionaryExtractor(sampleDictionary);

  it("finds names and aliases, longest first, and relates co-mentioned entities", async () => {
    const { entities, relations } = await extractor.extract(
      "Babbage took the idea from the Jacquard loom; thousands of Jacquard looms ran in Lyon.",
    );
    expect(entities).toEqual([
      { name: "Charles Babbage", type: "person" },
      { name: "Jacquard loom", type: "machine" },
      { name: "Lyon", type: "place" },
    ]);
    expect(relations).toEqual([
      { from: "Charles Babbage", to: "Jacquard loom" },
      { from: "Charles Babbage", to: "Lyon" },
      { from: "Jacquard loom", to: "Lyon" },
    ]);
    // "Henry Prevost Babbage" is not also read as "Babbage".
    expect((await extractor.extract("Henry Prevost Babbage")).entities.map((e) => e.name)).toEqual([
      "Henry Prevost Babbage",
    ]);
    expect(entityId("Computing-Tabulating-Recording Company")).toBe(
      "computing-tabulating-recording-company",
    );
  });

  it("parses an LLM's JSON answer and drops relations to unknown entities", async () => {
    const llm = llmExtractor(async (prompt) => {
      expect(prompt).toContain("Ada met Charles.");
      return [
        "Here you go:",
        "```json",
        '{"entities":[{"name":"Ada","type":"person"},{"name":"Charles","type":"person"}],',
        '"relations":[{"from":"Ada","to":"Charles"},{"from":"Ada","to":"Nobody"}]}',
        "```",
      ].join("\n");
    });
    expect(await llm.extract("Ada met Charles.")).toEqual({
      entities: [
        { name: "Ada", type: "person" },
        { name: "Charles", type: "person" },
      ],
      relations: [{ from: "Ada", to: "Charles" }],
    });
  });
});

describe("reciprocalRankFusion", () => {
  it("ranks items found by both lists first", () => {
    const fused = reciprocalRankFusion([
      ["a", "b", "c"],
      ["c", "d", "a"],
    ]);
    expect(fused.map((f) => f.id)).toEqual(["a", "c", "b", "d"]);
    expect(fused[0]!.score).toBeCloseTo(1 / 61 + 1 / 63, 12);
  });
});

describe("formatContext", () => {
  it("numbers each chunk and cites its document, section and source", () => {
    const chunk = (id: string, heading: string | null): RetrievedChunk => ({
      id,
      documentId: "d",
      documentTitle: "Doc",
      source: "docs/d.md",
      position: 0,
      heading,
      text: `text ${id}`,
      via: "match",
      matchedBy: ["vector"],
      score: 1,
      entities: [],
    });
    expect(formatContext([chunk("a", "Part"), chunk("b", null)])).toBe(
      "[1] Doc › Part (docs/d.md)\ntext a\n\n[2] Doc (docs/d.md)\ntext b",
    );
  });
});
