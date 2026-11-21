---
"@cyphra/runtime": minor
"@cyphra/migrator": minor
"@cyphra/cli": minor
"cyphra": minor
---

Memgraph support (Memgraph 3.x over Bolt), behind a `dialect` option:

- `dialect: "neo4j" | "memgraph"` on `CyphraClient`, `createOrm` and generated `createClient` (`client.dialect`; default `"neo4j"`, whose Cypher is unchanged), and `"dialect"` in `cyphra.json`. `detectDialect(client)` reads it from the Bolt server agent; CLI commands that connect use it when `cyphra.json` sets none.
- The ORM compiles traversals to variable-length expansions with filter lambdas, shortest paths to `*BFS` / `*ALLSHORTEST`, `findSimilar` to `vector_search.search` (scores on Neo4j's scale) and `search` to `text_search.search_all`. `upsert` retries a commit-time uniqueness conflict on its key, `connect` serializes concurrent connects of one pair, and Memgraph's uniqueness violations become `UniqueConstraintError`s.
- New `UnsupportedFeatureError` (a `CyphraError` with `feature` and `dialect`), thrown before anything runs for what Memgraph lacks: `Time` values, durations with months, relation filters inside a traversal hop's or a shortest path's `where`, relationship uniqueness constraints, and the HTTP transport.
- The migrator writes Memgraph DDL (`CREATE CONSTRAINT ON (n:L) ASSERT …`, `CREATE INDEX ON :L(p)`, `EDGE` / `POINT` / `TEXT` / `VECTOR` indexes) for `push`, `migrate dev` / `diff` (`diffSchemaModels(prev, next, { dialect })`), drops unnamed objects by definition, reads `SHOW … INFO` for `migrate status` drift, introspects with `schema.node_type_properties()` for `pull`, and resets with `USING PERIODIC COMMIT`.

See https://cyphra.dev/memgraph for the feature matrix.
