---
"@cyphra/runtime": minor
---

Add vector similarity search to the ORM client.

- `db.chunk.findSimilar({ field, vector, k, where, minScore, select, include })` returns the `k` nodes most similar to `vector`, best first, each with a `$score` (the index's score in `[0, 1]`), through `db.index.vector.queryNodes` (Neo4j 5.15+). It exists only on models with a `Vector(N) @vectorIndex` field, and `field` only accepts those fields; the vector length is checked at runtime.
- With `where`, the search over-fetches `candidates` neighbours (default `max(10 × k, 100)`), filters them in the same statement and widens (×4) until `k` rows match, the index is exhausted, scores fall below `minScore`, or `maxCandidates` is reached. `exact: true` skips the index and ranks the nodes matching `where` with `vector.similarity.*` (Neo4j 5.18+), for selective filters.
- Vector fields are written as float lists with their length checked on `create`, `update`, `upsert` and `createMany`, filter only on `null`, and cannot be sorted. Works in `$transaction`. The new `FindSimilarArgs`, `SimilarResult`, `VectorKeys` and `VectorIndexKeys` types are exported.
