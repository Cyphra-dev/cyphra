# Cyphra example: GraphRAG

Retrieval for a question-answering app, on Neo4j, with the typed client. The guide that walks
through it is at [cyphra.dev/guides/graphrag](https://cyphra.dev/guides/graphrag).

- `schema.cyphra`: `(Document)-[:HAS_CHUNK]->(Chunk)`, `(Chunk)-[:NEXT]->(Chunk)`,
  `(Chunk)-[:MENTIONS]->(Entity)`, `(Entity)-[:RELATED_TO]->(Entity)`. `Chunk.embedding` is a
  `Vector(256)` with a vector index; `Chunk.heading` and `Chunk.text` have a full-text index.
- `src/ingest.ts`: chunks Markdown by paragraph (`src/chunk.ts`), embeds each chunk, extracts its
  entities and writes the graph, one transaction per document.
- `src/retrieve.ts`: `findSimilar` and full-text `search`, merged with reciprocal rank fusion, then
  graph expansion (the chunks around each match, and chunks that mention the same or related
  entities, through `traverse`), returned as a context block with numbered citations.
- `docs/`: four short articles on early computing (written for this example) to ingest.

No API key is needed. By default embeddings come from a deterministic hashed bag of words
(`src/embeddings.ts`) and entities from a dictionary (`src/entities.ts`, `src/sample.ts`). Both are
interfaces: plug in a real model with the environment variables below.

## Run

```bash
# from the repository root, once
pnpm install && pnpm -r --filter './packages/*' run build && pnpm install --offline

# a local Neo4j 5 (5.15 or later)
docker run -d --name neo4j -p 7687:7687 -e NEO4J_AUTH=neo4j/password neo4j:5

export NEO4J_URI=bolt://localhost:7687 NEO4J_USERNAME=neo4j NEO4J_PASSWORD=password
pnpm example:graphrag                                     # two sample questions
pnpm example:graphrag "Who invented the tabulating machine?"
```

It creates the indexes, ingests `docs/` and prints, for each question, which chunks were retrieved
and why, then the context block.

## Real models

| Variable             | Effect                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `EMBEDDINGS_URL`     | Base URL of an OpenAI-compatible `/embeddings` API, e.g. `https://api.openai.com/v1`.    |
| `EMBEDDINGS_API_KEY` | Bearer token for it (optional for local servers).                                        |
| `EMBEDDINGS_MODEL`   | Model name (default `text-embedding-3-small`, asked for 256 dimensions).                 |
| `LLM_URL`            | Base URL of an OpenAI-compatible `/chat/completions` API: prints an answer per question. |
| `LLM_API_KEY`        | Bearer token for it.                                                                     |
| `LLM_MODEL`          | Model name (default `gpt-4o-mini`).                                                      |
| `LLM_EXTRACT=1`      | Extract entities with the chat model instead of the dictionary (one call per chunk).     |

A model that cannot return 256 dimensions needs `Vector(N)` changed in `schema.cyphra` and
`EMBEDDING_DIMENSIONS` in `src/embeddings.ts`. Drop the `chunkEmbedding` index first: a vector
index has one size.

## Test

```bash
pnpm --filter cyphra-example-graphrag test   # unit tests; the Neo4j test is skipped
NEO4J_TEST_URI=bolt://localhost:7687 NEO4J_TEST_USER=neo4j NEO4J_TEST_PASSWORD=password \
  pnpm --filter cyphra-example-graphrag test # also ingests docs/ and checks retrieval
```

The Neo4j test deletes every `Document`, `Chunk` and `Entity` node of the database it runs on.
