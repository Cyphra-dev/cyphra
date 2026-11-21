/**
 * Must match `Vector(256)` on `Chunk.embedding` in schema.cyphra. If your provider returns another
 * size, change both (and push the schema again: the vector index is created for one dimension).
 */
export const EMBEDDING_DIMENSIONS = 256;

/** Turns texts into vectors. Swap the implementation without touching ingestion or retrieval. */
export interface Embedder {
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

const STOP_WORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have he her his how " +
    "i in into is it its of on or our she so than that the their them then there these they this " +
    "to was we were what when where which who whom why will with would you your"
  ).split(" "),
);

/** Lower-cased word tokens without stop words, with a crude plural strip (`cards` → `card`). */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

/** 32-bit FNV-1a. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A deterministic local embedding: hashed bag of words (the "hashing trick"). Each token adds ±1
 * to one of `dimensions` buckets, term counts are dampened with `log(1 + tf)`, and the vector is
 * L2-normalised, so cosine similarity measures word overlap.
 *
 * It needs no model, no network and no API key, which makes the example and its tests run
 * anywhere. It does not know synonyms ("car" and "automobile" share nothing): use a real model for
 * real data.
 */
export function hashingEmbedder(dimensions = EMBEDDING_DIMENSIONS): Embedder {
  const embedOne = (text: string): number[] => {
    const counts = new Map<string, number>();
    for (const t of tokenize(text)) counts.set(t, (counts.get(t) ?? 0) + 1);
    const vector = new Array<number>(dimensions).fill(0);
    for (const [token, tf] of counts) {
      const h = fnv1a(token);
      const sign = fnv1a(`#${token}`) & 1 ? 1 : -1;
      vector[h % dimensions]! += sign * Math.log1p(tf);
    }
    const norm = Math.hypot(...vector);
    // A zero vector has no cosine similarity; give empty texts a fixed direction instead.
    if (norm === 0) return vector.map((_, i) => (i === 0 ? 1 : 0));
    return vector.map((v) => v / norm);
  };
  return { dimensions, embed: async (texts) => texts.map(embedOne) };
}

export interface OpenAICompatibleEmbedderOptions {
  /** Base URL of an OpenAI-compatible API, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer …` when set (local servers often need none). */
  apiKey?: string;
  model: string;
  /** Asked from the API (`dimensions`) and checked on every vector. */
  dimensions?: number;
  /** Texts per request (default 64). */
  batchSize?: number;
  fetch?: typeof fetch;
}

/**
 * Any API that implements `POST /v1/embeddings` the way OpenAI does: OpenAI, Azure OpenAI, Mistral,
 * Together, vLLM, Ollama, LM Studio and others. `dimensions` is sent so that models that support it
 * (`text-embedding-3-*`) return vectors of the schema's size.
 */
export function openAICompatibleEmbedder(options: OpenAICompatibleEmbedderOptions): Embedder {
  const { baseUrl, apiKey, model, dimensions = EMBEDDING_DIMENSIONS, batchSize = 64 } = options;
  const doFetch = options.fetch ?? fetch;
  const url = `${baseUrl.replace(/\/+$/, "")}/embeddings`;

  return {
    dimensions,
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const input = texts.slice(i, i + batchSize);
        const res = await doFetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ model, input, dimensions }),
        });
        if (!res.ok) {
          throw new Error(`Embeddings request failed: ${res.status} ${await res.text()}`);
        }
        const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
        const vectors = [...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
        for (const v of vectors) {
          if (v.length !== dimensions) {
            throw new Error(
              `Model ${model} returned ${v.length} dimensions, the schema expects ${dimensions}.`,
            );
          }
        }
        out.push(...vectors);
      }
      return out;
    },
  };
}

/**
 * `EMBEDDINGS_URL` set: an OpenAI-compatible API (`EMBEDDINGS_API_KEY`, `EMBEDDINGS_MODEL`, default
 * `text-embedding-3-small`). Otherwise the local hashing embedder.
 */
export function embedderFromEnv(env: NodeJS.ProcessEnv = process.env): Embedder {
  if (!env.EMBEDDINGS_URL) return hashingEmbedder();
  return openAICompatibleEmbedder({
    baseUrl: env.EMBEDDINGS_URL,
    apiKey: env.EMBEDDINGS_API_KEY,
    model: env.EMBEDDINGS_MODEL ?? "text-embedding-3-small",
  });
}
