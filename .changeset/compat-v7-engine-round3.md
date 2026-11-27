---
"@cyphra/graphql": minor
---

`compat.v7` runs more requests on the shared engine, with the same results: connection `aggregate` selections (root and nested), aggregation filters, `@fulltext` queries, and `@cypher` fields of node types (fields returning nodes, list fields, scalar fields whose statement is a lone `RETURN`, `$jwt`, arguments, and filters and sorts on them). `@cypher` statements that aggregate (`count()`, `collect()`, …) still run on the compat compiler outside the `where` of a root query, because Neo4j 5 rejects them inside the expressions the engine projects. With `client`, the client's `query` events and spans now name the engine operation for these requests too.
