---
"@cyphra/runtime": minor
"@cyphra/graphql": minor
---

Query logging, OpenTelemetry tracing and missing-index warnings.

- `log: ["query", "warn", "error"]` (or a function) on `createClient` / `new CyphraClient`, and
  `db.$on(level, fn)` / `client.on(level, fn)` listeners. Query events carry the model, operation,
  Cypher text, redacted parameters (type placeholders unless `logParams: true`; secret-looking keys
  always redacted), duration, row count, database and whether the statement ran in a transaction.
  Error events add the Neo4j status code and GQL status.
- `tracer`: pass an OpenTelemetry `Tracer` (`@opentelemetry/api` is an optional peer dependency)
  for one `cyphra.<Model>.<operation>` span per ORM operation and one `CLIENT` span per statement
  with the database semantic conventions; context propagates through `$transaction`.
  `traceQueryText: true` adds `db.query.text` (string literals masked).
- `warnMissingIndexes: true` (development only, off by default): `EXPLAIN` each distinct filtered
  statement once, off the query path, and warn when a property is filtered on top of a label scan
  and has no index.
- `@cyphra/graphql` executors built on a `client` emit the same events and spans
  (`graphql.read` / `graphql.write`).
- `debug: true` is deprecated in favour of `log: ["query"]`.
