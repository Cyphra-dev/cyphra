# @cyphra/graphql

## 0.10.0

### Patch Changes

- Updated dependencies [603c4f1]
- Updated dependencies [ff359dc]
- Updated dependencies [13de328]
  - @cyphra/schema@0.10.0
  - @cyphra/runtime@0.10.0

## 0.9.0

### Minor Changes

- b204047: `cyphra import graphql` (and `cyphraSchema`) map `Point`, `CartesianPoint`, `Time`, `LocalTime`,
  `LocalDateTime` and `Duration` fields to the Cyphra types of the same name instead of reporting them
  as not converted, with their string defaults, and `@timestamp` on `Time` becomes `@default(now())`.
- 00e016f: Query logging, OpenTelemetry tracing and missing-index warnings.

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

### Patch Changes

- Updated dependencies [05ecf49]
- Updated dependencies [00e016f]
- Updated dependencies [42d02bd]
- Updated dependencies [b204047]
  - @cyphra/schema@0.9.0
  - @cyphra/runtime@0.9.0

## 0.8.0

### Minor Changes

- e22de55: `cyphra import graphql` (and `cyphraSchema`) map GraphQL enums to Cyphra enums with the same values
  (only the enums a converted field uses; `@default(value: X)` becomes `@default(X)`), and `BigInt` to
  `BigInt` (defaults keep every digit), instead of `String` and "not converted".
- ba56ddc: `cyphra import graphql` (and `convertGraphQLTypeDefs`) now converts `@fulltext(indexes: [{ indexName, queryName, fields }])` to one `@@fulltext([fields], name: indexName)` per index, so `cyphra migrate` creates the full-text indexes the v7 API queries. Field names follow `@alias`; `queryName` is listed as ignored (it names a GraphQL query field, which `compat.v7` still serves); an index on a field that was not converted, or that is not a `String` / `ID` field, is reported and left out. `--merge` adds the indexes an existing node lacks. `@vector` stays reported (v7 type definitions carry neither the dimensions nor the similarity), with a hint to declare a `Vector(N)` field with `@vectorIndex`. Report messages for `@cypher` fields and authorization rules now say that `compat.v7` still serves them.

### Patch Changes

- Updated dependencies [f51239c]
- Updated dependencies [e22de55]
  - @cyphra/runtime@0.8.0
  - @cyphra/schema@0.8.0

## 0.7.0

### Minor Changes

- 6130ac7: `@authentication` and `@authorization`, as in `@neo4j/graphql` v7: rules on types, on fields and for the whole schema (`extend schema @authentication`), `filter` and `validate` rules for every operation (`READ`, `AGGREGATE`, `CREATE`, `UPDATE`, `DELETE`, `CREATE_RELATIONSHIP`, `DELETE_RELATIONSHIP`) with `requireAuthentication` and `when: [BEFORE, AFTER]`, `where: { node, jwt }` with `$jwt.<claim>` and `$context.<path>` values, the `@jwt` type and `@jwtClaim`. Rules are compiled into the Cypher statement of each root field: filters are part of its `WHERE` (nested selections, connections, aggregates and nested writes included) and `validate` checks run inside it, so data the rules do not allow never leaves the database and a write that fails a check is rolled back. No APOC needed. JWTs are verified like v7 with the new `features.authorization` option of `makeSchema` (a secret, a JWKS URL or a function of the context) from the `token` context value; a decoded `jwt` in the context is still trusted as it is. A few v7 behaviours are stricter here; see the docs.
- 6796ef7: `@cypher` fields and `@fulltext` queries, as in `@neo4j/graphql` v7. `@cypher(statement, columnName)` works on fields of node types, on relationship properties and on `Query` / `Mutation` fields, with scalar and node results, arguments (rewritten to parameters like v7, never written into the statement), `this`, `$jwt` and `context.cypherParams`. Scalar `@cypher` fields can be used in `where` and `sort`, fields returning nodes can be filtered with `some` / `all` / `none` / `single`, and returned nodes get the READ rules of their type. Statements run inside the root field's single Cypher statement (as `CALL` subqueries, so aggregating statements work at any depth). `@fulltext(indexes: [{ indexName, queryName, fields }])` generates the v7 full-text query fields (`phrase`, `where` on `score` and `node`, `sort`, `first` / `after`, `totalCount`, `score` on edges) on top of `db.index.fulltext.queryNodes`; like v7, the indexes are not created by the library.

### Patch Changes

- Updated dependencies [fc22aac]
- Updated dependencies [1e3c799]
- Updated dependencies [1e3c799]
- Updated dependencies [fc22aac]
  - @cyphra/runtime@0.7.0
  - @cyphra/schema@0.7.0

## 0.6.0

### Minor Changes

- e02dbb3: Mutations, as in `@neo4j/graphql` v7: `createX`, `updateX` and `deleteX` with their `info` counters and the response selection, nested `create` / `connect` / `disconnect` / `update` / `delete` (nested in each other) with edge properties, every update operator (`set`, `add`, `subtract`, `multiply`, `divide`, `push`, `pop` and the deprecated `field_SET` / `field_INCREMENT` / … forms), `@id`, `@timestamp` and `@default`. Each root field is one Cypher statement in one write transaction; counters are computed in the statement and v7's checks (arithmetic on a missing value, Int overflow, `push` / `pop` on a missing list) roll the mutation back without needing APOC. Like v7, `connect` creates a relationship even when the pair is already connected. Mutations need Neo4j 5.23 or later.

### Patch Changes

- Updated dependencies [4832219]
- Updated dependencies [3f2c13d]
- Updated dependencies [879de50]
  - @cyphra/runtime@0.6.0
  - @cyphra/schema@0.6.0

## 0.5.0

### Minor Changes

- da61e20: Aggregations, as in `@neo4j/graphql` v7: `aggregate { count { nodes edges } node { … } edge { … } }` on root and nested connections (`min` / `max` / `average` / `sum` / `shortest` / `longest` with v7's result types: Int `average` is a Float, BigInt values are strings), compiled into the same single Cypher statement, and aggregation filters in `where` (`actorsConnection: { aggregate: { count, node, edge } }`, the deprecated `actorsAggregate` form and its `field_AVERAGE_LENGTH_GT`-style keys, with `AND` / `OR` / `NOT`). `neo4j-driver` is now a peer dependency (`^5.28.3 || ^6.0.0`), like `@cyphra/runtime`, so your app and the GraphQL API share one driver.
- 04de22e: New package `@cyphra/graphql`: `compat.v7.makeSchema({ typeDefs, driver | client })` serves the API `@neo4j/graphql` v7 generates, so frontends switch without changing their queries. The full v7 schema is generated (printed SDL identical to 7.6.8, deprecated fields included) and the read API works: list and connection queries, filters (scalars, lists, `AND` / `OR` / `NOT`, relationship and connection quantifiers), sorting, offset and cursor pagination, nested relationships and connections with edge properties, one Cypher statement per root field. Aggregations, mutations, authorization and `@cypher` fields return a "Not implemented yet" error for now. The `@neo4j/graphql` type definitions converter used by `cyphra import graphql` moved into this package.

### Patch Changes

- Updated dependencies [a8be483]
- Updated dependencies [e5851e2]
  - @cyphra/runtime@0.5.0
  - @cyphra/schema@0.5.0
