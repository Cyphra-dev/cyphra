# @cyphra/graphql

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
