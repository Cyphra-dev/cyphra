---
"@cyphra/runtime": minor
"cyphra": minor
---

Full-text and vector search over a union: `db.searchHit.search({ query, indexes })` and
`db.searchHit.findSimilar({ vector, take, fields })` query one `@@fulltext` index / `@vectorIndex`
field per member and merge the hits with reciprocal rank fusion (`$score = Σ 1 / (k + rank)`,
`k = 60`, `rrfK`), since scores of different indexes are not comparable. Each list is min-max
normalised (reported with `scores: true` as `$scores`, keyed by index, and used to break ties) for a
stable order. The union `where` (`$on` per member, `__typename`) and `minScore` filter each list
before ranking; `skip` / `take` page the fused list; `select` / `include` take `$on` per member.
One statement on Neo4j, Memgraph and FalkorDB.
