---
"@cyphra/runtime": minor
"@cyphra/migrator": minor
"@cyphra/cli": minor
"cyphra": minor
---

FalkorDB support (FalkorDB 4.x over the Redis protocol), as a third dialect:

- `new CyphraClient({ falkordb: { url, graph } })` (also `createOrm` and generated `createClient`) connects with the official `falkordb` client, an optional peer dependency loaded on first use (Neo4j and Memgraph apps never need it). It implies `dialect: "falkordb"` and `client.transport === "falkordb"`; a `client` option shares a connection your app already has.
- The transport rewrites the ORM's Cypher for FalkorDB (`rewriteForFalkorDB`): `EXISTS {}` / `COUNT {}` / `COLLECT {}` become `CALL {}` subqueries, `elementId()` becomes `id()` (with id seeks), map parameters of patterns are expanded, and parameters go in the `CYPHER …` header as literals (integers stay integers, numbers are floats). Neo4j and Memgraph output is unchanged.
- Temporal fields are stored as ISO 8601 text (`DateTime` in UTC with milliseconds, which sorts in time order); vector fields as FalkorDB vectors (`vecf32`). `findSimilar` uses `db.idx.vector.queryNodes` (scores on Neo4j's scale), `search` uses `db.idx.fulltext.queryNodes` (RediSearch syntax), traversals use variable-length paths with checks on the path, and shortest paths use `shortestPath()` / `allShortestPaths()`. Uniqueness violations become `UniqueConstraintError`s with their fields.
- FalkorDB has no multi-statement transactions: each operation is one statement, which FalkorDB runs atomically (checks on its result, such as a missing `connect` target, come after it), write work of one client is serialized, and `$transaction` throws `UnsupportedFeatureError`. Points throw `UnsupportedFeatureError` too.
- The migrator writes FalkorDB DDL (`GRAPH.CONSTRAINT CREATE UNIQUE …`, which the transport runs as the Redis command, `CREATE INDEX FOR (n:L) ON (n.p)`, full-text and vector indexes) for `push`, `migrate dev` / `diff` / `deploy`, reads `db.constraints()` / `db.indexes()` for `migrate status` drift, samples data for `pull`, and resets one graph. The CLI connects with `"dialect": "falkordb"` in `cyphra.json` and `FALKORDB_URL` / `FALKORDB_GRAPH`; the studio works on FalkorDB.

See https://cyphra.dev/falkordb for the feature matrix.
