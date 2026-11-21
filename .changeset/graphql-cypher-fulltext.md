---
"@cyphra/graphql": minor
---

`@cypher` fields and `@fulltext` queries, as in `@neo4j/graphql` v7. `@cypher(statement, columnName)` works on fields of node types, on relationship properties and on `Query` / `Mutation` fields, with scalar and node results, arguments (rewritten to parameters like v7, never written into the statement), `this`, `$jwt` and `context.cypherParams`. Scalar `@cypher` fields can be used in `where` and `sort`, fields returning nodes can be filtered with `some` / `all` / `none` / `single`, and returned nodes get the READ rules of their type. Statements run inside the root field's single Cypher statement (as `CALL` subqueries, so aggregating statements work at any depth). `@fulltext(indexes: [{ indexName, queryName, fields }])` generates the v7 full-text query fields (`phrase`, `where` on `score` and `node`, `sort`, `first` / `after`, `totalCount`, `score` on edges) on top of `db.index.fulltext.queryNodes`; like v7, the indexes are not created by the library.
