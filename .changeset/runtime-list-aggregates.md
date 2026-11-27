---
"@cyphra/runtime": patch
---

Internal engine entries for `@cyphra/graphql`'s `compat.v7` (not in the client's types, not covered by semver): list aggregates with `@neo4j/graphql` 7's semantics (`$aggregate` in `select` and `where`, `$values` on `aggregate`), `$cypherNodes` filters on the nodes a Cypher expression returns, `$labelTest: false` on Cypher node loads, and `$orderBy` / `$maxScore` on `search`. Neo4j only.
