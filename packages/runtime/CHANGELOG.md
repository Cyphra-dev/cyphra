# @cyphra/runtime

## 0.29.0

### Patch Changes

- 7f2f123: Native GraphQL API: subscriptions on Neo4j Change Data Capture (experimental, #250).
  `operations: { subscribe: true }` adds `<model>Changed(where, operations)` (`CREATED`, `UPDATED`,
  `DELETED`, with `id`, `node` and `changedFields`) and, per readable relation,
  `<model><Relation>Connected` / `…Disconnected` (`id`, `relatedId`, `node`, `related`, `_edge`).
  They run on `native.CDCReader` (`makeSchema({ subscriptions })`), one Change Data Capture poller
  per server. Every batch of changes is re-read for each subscription with its `where`, its
  selection and the API's rules, so a subscriber only receives nodes it may read now, on node
  changes and relationship events alike; `DELETED` carries only the key. `@cyphra/runtime` exports
  `decodeScalar` (internal) for it.
  - @cyphra/query@0.29.0
  - @cyphra/schema@0.29.0

## 0.28.0

### Patch Changes

- 55a869b: Internal engine entries for `@cyphra/graphql`'s `compat.v7` (not in the client's types, not covered by semver): list aggregates with `@neo4j/graphql` 7's semantics (`$aggregate` in `select` and `where`, `$values` on `aggregate`), `$cypherNodes` filters on the nodes a Cypher expression returns, `$labelTest: false` on Cypher node loads, and `$orderBy` / `$maxScore` on `search`. Neo4j only.
  - @cyphra/query@0.28.0
  - @cyphra/schema@0.28.0

## 0.27.0

### Patch Changes

- fd05388: Internal engine entries for `@cyphra/graphql`'s `compat.v7` (not in the client's types, not covered by semantic versioning): `$now` on `createMany` / `updateMany` sets `DateTime` / `Date` fields to the database clock in the statement; `CypherDateTimeText` passes a DateTime as text, parsed by `datetime()` in the statement (offset and precision kept); `$edge` filters and sorts on the edge a node was reached through (relation filters, relation loads, `_count`). Neo4j only for the first two.
  - @cyphra/query@0.27.0
  - @cyphra/schema@0.27.0

## 0.26.0

### Minor Changes

- db04150: Internal engine entries for the native GraphQL API's extension points: Cypher expressions in
  `select` (a scalar value, or the nodes the expression returns, filtered by the target's read rules),
  `where` and `orderBy` (`$cypher`, built with `cypherFragment`, every interpolated value bound as a
  parameter), `encodeCypherParam`, and `computedFieldsOf(client, model)` (the computed fields of a
  client and their `needs`). They are experimental and not covered by semantic versioning.

### Patch Changes

- @cyphra/query@0.26.0
- @cyphra/schema@0.26.0

## 0.25.0

### Minor Changes

- 1e0082e: Nested `update`, `delete` and `upsert` on the relations of an update (`posts: { update: { where, data }, delete: { id }, upsert: { where, create, update } }`; on a to-one relation `update: data`, `delete: true`, `upsert: { create, update }`) and `connectOrCreate` on create and update, each a subquery of the write's single statement: a target that is not linked throws `NotFoundError` and rolls the whole write back, nested deletes apply `onDelete` rules, and validation rules and `@min` / `@max` are checked with their paths. `where` takes `_count` filters on to-many relations (`{ _count: { posts: { gte: 2, where: { published: true } } } }`), compiled to `COUNT {}`. Both are typed and respect engine rules (`read` / `update` / `delete` on the targets, `create` / `after` on what they create, `read` in counts). On FalkorDB, a nested `delete` of a model with `onDelete: Restrict` rules throws `UnsupportedFeatureError`.

### Patch Changes

- 1ac6f9d: Engine rules (`withEngineRules`) on paths: `traverse`, `shortestPath` and `allShortestPaths` apply the read rules to every node a path steps through (before, only to the start and reached nodes, so a path could go through a hidden node and return it), and the nodes of returned paths read their fields through the field rules. On Memgraph and FalkorDB, which cannot run a subquery on each node of a path, a read rule with a relation filter on a traversed model now fails the traversal (`UnsupportedFeatureError`) instead of being skipped. Internal: a traversal load (`$traverse` in `select`, Neo4j only), for the native GraphQL API's named traversal fields.
- 942ebc0: Native GraphQL API: relation update inputs take nested `update` (`[{ where, data }]` on to-many, the data on to-one), `delete` (unique keys, or `true` on to-one; `onDelete` rules apply), `upsert` (`[{ where, create, update }]` / `{ create, update }`) and `connectOrCreate` (also in create inputs), each served when the target's matching operation is on, all in the root field's one statement and under its rules (`NOT_FOUND`, `RESTRICTED`, `FORBIDDEN`, validation issues with GraphQL argument paths). `<Model>Where` takes `_count` filters on to-many relations (`_count: { posts: { gte: 2, where: { … } } }`), counting only readable nodes; rule `where`s may use them too. In the runtime, a uniqueness violation from a batched nested create now names its model and fields.
  - @cyphra/query@0.25.0
  - @cyphra/schema@0.25.0

## 0.24.0

### Minor Changes

- ca21801: Engine rules (internal `withEngineRules`, the base of the native GraphQL API's authorization) cover writes and fields: `create` rules (a boolean or a function of the node's data, checked on every node a write creates, nested ones included, before anything runs), `connect` / `disconnect` rules per relation (restricting the targets; a to-one edge a write must replace outside the `disconnect` rule fails the write), `after.create` / `after.update` rules checked in the statement once every write of it ran (rolled back otherwise), and per-field read rules (`fields`): a ruled-out field reads as `null` everywhere a statement reads it, in results, filters, `orderBy`, aggregates and `groupBy` keys. `update` / `delete` targets are now also subject to the `read` rules (a node the request cannot read does not exist for it), a connect target whose inverse relation is to-one to its `update` rules, and a written node the `read` rules hide is returned as `null` (left out of batch `nodes`). New `ForbiddenError` for refused writes. `after` and `disconnect` rules are refused on FalkorDB, which cannot roll a write back.

### Patch Changes

- @cyphra/query@0.24.0
- @cyphra/schema@0.24.0

## 0.23.0

### Patch Changes

- 609a44c: `compat.v7` runs list and connection queries on the shared engine (the typed client's compiler) when it answers exactly like v7: filters, sorting, `limit` / `offset`, v7 offset cursors, nested relationships and connections with edge `properties`, on types without `@authentication` / `@authorization`. Everything else (aggregations, full-text, `@cypher`, rules, unions, interfaces, edge filters and sorts, `single`, mutations, …) stays on the compat compiler, so results do not change. With `client`, the client's `query` events and spans now name the engine operation (`findMany` on `Movie`) for these queries, and a root connection selecting both a page and `totalCount` reads them with two statements in one read transaction. `@cyphra/runtime`: internal `withRawValues(client)` engine entry.
- 5f36831: `compat.v7` runs root mutations on the shared engine when it writes and answers exactly like v7: `create` with attribute inputs (`createMany`, `info.nodesCreated`), `update` with `set` operators (`updateMany`), and `delete` without nested deletes (`deleteMany`, with `relationshipsDeleted`), the response selection read in the same statement. Nested writes (v7's `connect` is a `CREATE`, the engine's a `MERGE`), arithmetic and list operators, deprecated `field_SET` keys, `@timestamp` and `@limit` types, DateTime values and types with rules stay on the compat compiler. `@cyphra/runtime`: internal `deleteMany({ $relationships: true })` engine entry (the number of relationships a delete removed).
  - @cyphra/query@0.23.0
  - @cyphra/schema@0.23.0

## 0.22.0

### Minor Changes

- 6f0644f: `createMany`, `updateMany` and `deleteMany` take `select` and then return the affected nodes as
  `nodes` next to `count`, read in the same statement: the created nodes in `data` order, the nodes as
  updated, the deleted nodes as they were (with every `onDelete` path: plain, one-statement cascades
  and level-by-level cascades). Without `select` they return `{ count }` as before. Computed fields of
  `$extends({ result })` apply to the returned nodes.

### Patch Changes

- @cyphra/query@0.22.0
- @cyphra/schema@0.22.0

## 0.21.0

### Minor Changes

- 5b60cb4: Native GraphQL API, phase 2 (reads, experimental): `native.makeSchema({ client, config })` serves
  a GraphQL API generated from `schema.cyphra` and run by the typed client, next to `compat.v7`
  (`import { compat, native } from "@cyphra/graphql"`).

  - `defineGraphQL` (also from `@cyphra/graphql/native`): a config typed against the generated
    client's `CyphraTypeMap` (unknown models, fields and operations fail `tsc`) and checked again at
    startup (`NativeSchemaError`). Per-model operation toggles (reads on, writes off by default),
    field toggles (`false`, `{ read, filter, sort, deprecated }`), root field names (`naming`) and
    `limits` (`maxDepth`, `maxTake`, `maxAliases`, `maxComplexity`).
  - Root fields `<model>FindUnique`, `<model>FindFirst`, `<model>FindMany` (returning
    `<Model>List { nodes pageInfo totalCount }`, offset and keyset-cursor paging) and
    `<model>Count`; `<Model>Where` filters, `[<Model>OrderBy!]` ordering (one key per element),
    relations with `where` / `orderBy` / `skip` / `take` (aliases become aliased loads), `_edge` for
    edge properties (a union when several relationship models reach a node), `_count`, `_labels`,
    interfaces and unions (fragments become `$on`), and every Cyphra scalar type.
  - One client operation, so one Cypher statement, per root field; a page and its `totalCount` run
    in one read transaction. Errors carry `extensions.code` (`BAD_USER_INPUT`, `NOT_FOUND`,
    `RESTRICTED`, `UNIQUE_CONSTRAINT`, `INTERNAL_SERVER_ERROR` masked unless `debug`).
  - `native.printSchema(schemaModel, config)`: the sorted SDL, without a client.
  - `@cyphra/runtime`: `withReadTransaction(client, fn)` (internal, experimental) runs several
    operations of a client in one read transaction.

- 66bc969: Keyset cursor pagination in `findMany` / `findFirst`: select `$cursor` and pass it back as
  `cursor: { after }` (or `{ before }`) with the same `orderBy`. Cursors are opaque strings holding the
  boundary row's sort keys plus its `@id` (always the last sort key, so ties never repeat or skip a
  row); pages stay stable when nodes are created or deleted before them. Any `orderBy` works (mixed
  directions, nullable fields, a related node's field, relation counts); a cursor made for another
  model or `orderBy` throws a `CyphraValidationError`.

  Groundwork for the native GraphQL API (#77), internal and experimental: `withEngineRules(client,
rules)` returns a client whose statements AND per-model `read` / `update` / `delete` rules into
  every match of the model (roots, nested relation loads, relation filters, `_count`, relation
  `orderBy`, aggregates, search, traversal endpoints, write targets, `connect` targets); rules can be
  added but not removed, and survive `$extends` and `$transaction`. `select` accepts aliased
  relation loads (`{ recent: { $relation: "posts", take: 3 } }`, not in the public types) to load one
  relation several times in one statement.

  `$extends` no longer rebuilds a lookup of every model on each call (cheaper per-request clients on
  large schemas). FalkorDB: a `WITH` whose projection has subquery expressions and whose `WHERE` needs
  none is no longer rewritten into an invalid statement.

### Patch Changes

- @cyphra/query@0.21.0
- @cyphra/schema@0.21.0

## 0.20.1

### Patch Changes

- @cyphra/query@0.20.1
- @cyphra/schema@0.20.1

## 0.20.0

### Patch Changes

- @cyphra/query@0.20.0
- @cyphra/schema@0.20.0

## 0.19.0

### Patch Changes

- @cyphra/query@0.19.0
- @cyphra/schema@0.19.0

## 0.18.0

### Minor Changes

- 27bfd81: Full-text and vector search over a union: `db.searchHit.search({ query, indexes })` and
  `db.searchHit.findSimilar({ vector, take, fields })` query one `@@fulltext` index / `@vectorIndex`
  field per member and merge the hits with reciprocal rank fusion (`$score = Σ 1 / (k + rank)`,
  `k = 60`, `rrfK`), since scores of different indexes are not comparable. Each list is min-max
  normalised (reported with `scores: true` as `$scores`, keyed by index, and used to break ties) for a
  stable order. The union `where` (`$on` per member, `__typename`) and `minScore` filter each list
  before ranking; `skip` / `take` page the fused list; `select` / `include` take `$on` per member.
  One statement on Neo4j, Memgraph and FalkorDB.

### Patch Changes

- @cyphra/query@0.18.0
- @cyphra/schema@0.18.0

## 0.17.0

### Minor Changes

- 1d0fd3c: Typed edges on relations to a union: a `relationship { … }` model may name a union in `from` / `to` (one edge model for every member, also used by the members' inverse fields). `$edge` goes next to the member key in `connect`, `create` and `set` items (`connect: { Post: { id }, $edge: { rank: 2 } }`), every loaded member comes back with its typed `$edge`, and traversals filter on it with `edgeWhere`. The migrator emits the same relationship property constraints, indexes and backfills as for a node end (they are per relationship type).

  Interfaces as union members: `union Party = Person | Team` with `interface Person` stands for every implementation of `Person`. It is matched by the interface's label, results are the implementations (typed by `__typename`), and writes and `$on` may name the interface (`connect: { Person: { email } }`, `where: { $on: { Person: { … } } }`, `select: { $on: { Person: { … } } }`); a nested `create` names an implementation. A node listed twice (directly and through an interface) is a validation error. The type map gets `members` for unions with an interface member, and the language server completes interface names in a union.

### Patch Changes

- Updated dependencies [1d0fd3c]
  - @cyphra/schema@0.17.0
  - @cyphra/query@0.17.0

## 0.16.0

### Minor Changes

- 40ae155: Dynamic labels: declare the labels a model may carry with `@@labels([Archived, Featured])`, then add and remove them at runtime (`data: { $labels: ["Archived"] }` on create, `{ add, remove }` or `{ set }` on update / updateMany / upsert), filter on them (`where: { $labels: { has, hasSome, hasEvery, hasNone, isEmpty } }`) and read them (`select: { $labels: true }`). Labels are checked against the schema's list and written as the schema spells them (never taken from a value), on Neo4j, Memgraph and FalkorDB. Migrations note new dynamic labels and offer a commented-out step removing a dropped one; no DDL is created for them.

  `cyphra pull` reads nodes carrying several unrelated shared labels as `node X implements A, B`, recognizes labels found on some nodes of a model only as `@@labels([…])`, and takes `--interface <labels…>` for layouts that are otherwise ambiguous, such as a shared label with a single implementation.

- 6c0a27b: Unions of unrelated models: `union SearchHit = Post | User | Comment` declares a type (no label, nothing to migrate) that relation fields can target (`items SearchHit[] @relationship(…)`). `db.searchHit` reads every member with `findMany`, `findFirst` and `count`, results discriminated by `__typename`; `where` takes `__typename` and `$on: { Post: { … }, User: {} }` (each listed member with its own filter), `select` / `include` take `$on`, `orderBy` takes `__typename`. Writes through a relation to a union name the member (`connect: { Post: { id } }`, `create: { User: { … } }`, `disconnect`, `set`), and `onDelete` rules apply to each member with its own rules. Unions are matched by label predicates, so they run the same on Neo4j, Memgraph and FalkorDB, and traversals can end on one.

  `where: { $on }` also works on interfaces (per-implementation filters). The generated client exports each union as the discriminated union of its members' types, the zod generator emits a `z.discriminatedUnion` read schema (no create or update schema), migrations generate no step for unions, `cyphra studio` lists them in their own section (read-only), and the language server and VS Code grammar know the `union` keyword.

### Patch Changes

- af005ce: FalkorDB: a string parameter containing a NUL character (`\u0000`), in a value, a nested list or map, a map key or a parameter name, now throws a clear `CyphraValidationError` before the query is sent, instead of FalkorDB's "Failed to parse query parameter". Shortest paths: the typed path is decoded with schema lookups built once per schema, the path no longer carries node labels (or, on FalkorDB, node properties) it does not need, and `DateTime` values are converted to `Date` from their fields instead of `neo4j-driver`'s text round trip (about 6x faster to decode a row of datetimes).
- Updated dependencies [40ae155]
- Updated dependencies [6c0a27b]
  - @cyphra/schema@0.16.0
  - @cyphra/query@0.16.0

## 0.15.0

### Minor Changes

- 86ed59e: FalkorDB support (FalkorDB 4.x over the Redis protocol), as a third dialect:

  - `new CyphraClient({ falkordb: { url, graph } })` (also `createOrm` and generated `createClient`) connects with the official `falkordb` client, an optional peer dependency loaded on first use (Neo4j and Memgraph apps never need it). It implies `dialect: "falkordb"` and `client.transport === "falkordb"`; a `client` option shares a connection your app already has.
  - The transport rewrites the ORM's Cypher for FalkorDB (`rewriteForFalkorDB`): `EXISTS {}` / `COUNT {}` / `COLLECT {}` become `CALL {}` subqueries, `elementId()` becomes `id()` (with id seeks), map parameters of patterns are expanded, and parameters go in the `CYPHER …` header as literals (integers stay integers, numbers are floats). Neo4j and Memgraph output is unchanged.
  - Temporal fields are stored as ISO 8601 text (`DateTime` in UTC with milliseconds, which sorts in time order); vector fields as FalkorDB vectors (`vecf32`). `findSimilar` uses `db.idx.vector.queryNodes` (scores on Neo4j's scale), `search` uses `db.idx.fulltext.queryNodes` (RediSearch syntax), traversals use variable-length paths with checks on the path, and shortest paths use `shortestPath()` / `allShortestPaths()`. Uniqueness violations become `UniqueConstraintError`s with their fields.
  - FalkorDB has no multi-statement transactions: each operation is one statement, which FalkorDB runs atomically (checks on its result, such as a missing `connect` target, come after it), write work of one client is serialized, and `$transaction` throws `UnsupportedFeatureError`. Points throw `UnsupportedFeatureError` too.
  - The migrator writes FalkorDB DDL (`GRAPH.CONSTRAINT CREATE UNIQUE …`, which the transport runs as the Redis command, `CREATE INDEX FOR (n:L) ON (n.p)`, full-text and vector indexes) for `push`, `migrate dev` / `diff` / `deploy`, reads `db.constraints()` / `db.indexes()` for `migrate status` drift, samples data for `pull`, and resets one graph. The CLI connects with `"dialect": "falkordb"` in `cyphra.json` and `FALKORDB_URL` / `FALKORDB_GRAPH`; the studio works on FalkorDB.

  See https://cyphra.dev/falkordb for the feature matrix.

- ca885f5: Fewer round trips for writes, and one request per operation over HTTP:

  - `create` and `update` are one statement: the write, every nested relation write and the projection of the result (`select` / `include` / `_count`, computed-field `needs`). Nested `create`s are batched per relation (`FOREACH` over the children, in the order given); `connect`, `disconnect` and `set` are subqueries of the same statement, with the same locks and `MERGE`s as before. A nested create of a user with 5 posts goes from 12 statements to 1, `create` from 2 to 1, `update` from 3 to 1.
  - `upsert` with nested writes runs them and reads the result back in one second statement (was one per nested write, plus a read).
  - `delete` without `onDelete` rules is one statement: lock, read the row, `DETACH DELETE` (was 3). With `onDelete` rules whose cascades form a tree (no cycle, no interface), the lock, every cascade level, the `Restrict` checks and the delete (skipped when a check fails) are one statement too (a user → posts → comments cascade goes from 6 to 1); otherwise each cascade level is one statement and the checks share the delete's. A node deleted by a concurrent operation while the delete waited for its lock is now reported as not found.
  - HTTP transport: an operation that is one statement and writes nothing when it fails (reads, `create` without a nested `connect`, `update` without relation writes, `upsert` without nested writes, `delete`, `createMany` / `updateMany` / `deleteMany`, `$cypher`) is sent as one auto-commit Query API request (reads with `accessMode: "READ"`), retried on transient errors, instead of opening and committing an explicit transaction. Others, and everything inside `$transaction`, still use explicit transactions. New `CyphraClient.withSingleStatement()` and `HttpSession.runRetried()`.
  - `shortestPath` / `allShortestPaths` no longer read every path node's properties twice.
  - Each statement still emits a `query` event and a span, so operations now emit fewer of them. The `Runner` used by `ModelEngine` takes an optional `{ autoCommit }`.

  Benchmarks re-run: see https://cyphra.dev/benchmarks.

### Patch Changes

- @cyphra/query@0.15.0
- @cyphra/schema@0.15.0

## 0.14.0

### Minor Changes

- d18afd9: Interfaces follow-ups (#167):

  - **Interfaces extending interfaces**: `interface Staff extends Person, Contact { … }`. Fields are inherited transitively (once through a diamond), implementations carry every label up the chain (`:Engineer:Staff:Person:Contact`), each interface's delegate returns the implementations below it, and constraints and indexes stay on the declaring label. The resolved model gives interfaces `extends` and transitive `interfaces`, and nodes transitive `interfaces` / `labels`. Migrations backfill (or remove) every gained (or lost) label, `cyphra pull` recognizes chains of labels as `interface … extends …`, and the language server knows `extends` (completion, hover, go-to-definition, diagnostics).
  - **`where: { __typename }`** on interface queries (an implementation name or `{ equals, not, in, notIn }`, typed with the implementation names, compiled to label predicates) and **`orderBy: { __typename }`**.
  - **`$on`** in `select` / `include` of an interface query loads an implementation's own fields and relations on its results only: `include: { $on: { Employee: { team: true } } }`; result types narrow per `__typename`, and computed fields apply inside it.

- 98b668d: Memgraph support (Memgraph 3.x over Bolt), behind a `dialect` option:

  - `dialect: "neo4j" | "memgraph"` on `CyphraClient`, `createOrm` and generated `createClient` (`client.dialect`; default `"neo4j"`, whose Cypher is unchanged), and `"dialect"` in `cyphra.json`. `detectDialect(client)` reads it from the Bolt server agent; CLI commands that connect use it when `cyphra.json` sets none.
  - The ORM compiles traversals to variable-length expansions with filter lambdas, shortest paths to `*BFS` / `*ALLSHORTEST`, `findSimilar` to `vector_search.search` (scores on Neo4j's scale) and `search` to `text_search.search_all`. `upsert` retries a commit-time uniqueness conflict on its key, `connect` serializes concurrent connects of one pair, and Memgraph's uniqueness violations become `UniqueConstraintError`s.
  - New `UnsupportedFeatureError` (a `CyphraError` with `feature` and `dialect`), thrown before anything runs for what Memgraph lacks: `Time` values, durations with months, relation filters inside a traversal hop's or a shortest path's `where`, relationship uniqueness constraints, and the HTTP transport.
  - The migrator writes Memgraph DDL (`CREATE CONSTRAINT ON (n:L) ASSERT …`, `CREATE INDEX ON :L(p)`, `EDGE` / `POINT` / `TEXT` / `VECTOR` indexes) for `push`, `migrate dev` / `diff` (`diffSchemaModels(prev, next, { dialect })`), drops unnamed objects by definition, reads `SHOW … INFO` for `migrate status` drift, introspects with `schema.node_type_properties()` for `pull`, and resets with `USING PERIODIC COMMIT`.

  See https://cyphra.dev/memgraph for the feature matrix.

### Patch Changes

- Updated dependencies [d18afd9]
  - @cyphra/schema@0.14.0
  - @cyphra/query@0.14.0

## 0.13.0

### Minor Changes

- e586ac4: Graph query follow-ups:

  - Multi-hop traversals across models: `traverse({ via: [{ rel: "entities" }, { rel: "related", depth: { max: 2 } }, { rel: "chunks" }] })` follows a list of hops, each along relation(s) of the model the previous hop reached, in one statement. Each hop takes its own `direction`, `depth` (self-relations only), `where` (on every node it steps to) and `edgeWhere`. Results, `where`, `orderBy` and `select` / `include` are typed by the last hop's model; `returnPaths` paths hold every model and edge met along the way (`HopPath`). The relation-name form of `via` is unchanged.
  - Ordering by a filtered relation count: `orderBy: { posts: { _count: "desc", where: { published: true } } }`, at the top level, in nested relations and in traversals.
  - `$edge` number updates on `connect` and `set`: `$edge: { weight: { increment: 1 } }` (and `decrement`, `multiply`) is applied in the `MERGE` statement, to the current value of an existing edge or to the default of a new one; `@min` / `@max` on the edge property are checked on the result and a broken rule rolls the write back.
  - `set` on a to-many relation now keeps the edges to the nodes it lists (updating them with their `$edge`) instead of deleting and recreating them, so their other properties (and defaults such as `@default(now())`) are kept.

### Patch Changes

- ec7fd51: `UniqueConstraintError` no longer reads "Unique constraint failed: undefined" when the server reports a uniqueness GQL status without a message: it says "Unique constraint failed (GQL status 22N79): a node or relationship with the same value already exists."
- Updated dependencies [ec7fd51]
  - @cyphra/schema@0.13.0
  - @cyphra/query@0.13.0

## 0.12.0

### Minor Changes

- 8c173d3: Client extensions: `db.$extends({ query, result, model, client })` returns a new, fully typed client with query hooks around operations (per model, `$allOperations`, `$allModels`; they can change arguments and results), computed fields (`needs` + `compute`, added to result types, selectable, applied on nested relations, interfaces, traversals, paths and vector / full-text search), custom model methods (`this` is the extended delegate; `getExtensionContext`) and client members. Extensions compose, and `$transaction` on an extended client hands an extended transaction client.
- 24588fa: Add `UniqueConstraintError` (a `CyphraError`): a write that duplicates an `@id`, `@unique`, `@@unique` or relationship `@unique` value now throws it instead of Neo4j's raw `Neo.ClientError.Schema.ConstraintValidationFailed` error, on Bolt (neo4j-driver 5 and 6) and on the HTTP transport. It has `model` (the model that declares the constraint, an interface for a constraint declared on one), `fields`, `constraint` (the name `cyphra push` / migrations give it), `code`, `gqlStatus` and the original error as `cause`; its message never contains the duplicate value. Every ORM write maps it (`create`, `createMany`, `update`, `updateMany`, `upsert`, nested `create`, `$edge` data, `$cypher`, inside and around `$transaction`); the statement's `error` event still carries the Neo4j code, and `db.$client` / `@cyphra/graphql` errors are unchanged. `parseUniqueViolation` reads the label and properties from Neo4j's message.

### Patch Changes

- Updated dependencies [a577140]
- Updated dependencies [a577140]
  - @cyphra/schema@0.12.0
  - @cyphra/query@0.12.0

## 0.11.0

### Minor Changes

- bdaa06e: Interfaces and multiple labels: `interface Person { … }` and `node Employee implements Person { … }`.

  - **Schema**: an interface is an abstract node model whose label every implementation carries (`(:Employee:Person)`). A node inherits the fields, relations, `@@unique` keys and `@@fulltext` indexes of the interfaces it implements, first and in `implements` order. Relations and `relationship { … }` models can target an interface; an empty interface is an extra label. Implementing a non-interface, redeclaring an inherited field, two interfaces declaring the same field, two `@id`s and interfaces implementing interfaces are validation errors. Resolved models gain `abstract`, `implementations`, `interfaces`, `labels` and `inheritedFrom` (all optional: plain schemas resolve and generate as before).
  - **Client**: implementations are written and matched with all their labels. `db.person` reads (`findMany`, `count`, `aggregate`, `traverse`, `search`, …) return a union of the implementations discriminated by `__typename`, with each implementation's fields; `select` takes interface fields. Interfaces have no `create` / `createMany` / `upsert`, nested creates into interface targets are rejected, `connect`, updates and deletes work through them, and deletes apply each implementation's `onDelete` rules.
  - **Migrations**: constraints and indexes are created once, on the declaring label. A node that starts (stops) implementing an interface gets a step adding (removing) the label on its existing nodes, before the interface's constraints are created.
  - **`cyphra pull`**: a label that only ever appears paired with one other label is pulled as an interface with its implementations.
  - **Editor**: `interface` / `implements` completion, hover, outline, go-to-definition and diagnostics; syntax highlighting in VS Code.
  - **GraphQL import**: `@neo4j/graphql` interfaces (which are not labels) stay unsupported, with a message pointing to Cyphra interfaces.

### Patch Changes

- Updated dependencies [bdaa06e]
- Updated dependencies [9974b20]
- Updated dependencies [bdaa06e]
  - @cyphra/schema@0.11.0
  - @cyphra/query@0.11.0

## 0.10.0

### Minor Changes

- 603c4f1: `onDelete` rules on relations: `@relationship(type: "HAS_SESSION", direction: OUT, onDelete: Cascade | Restrict | SetNull)`.

  - **Schema**: the rule sits on the field of the model whose deletion triggers it (`User.sessions` with `onDelete: Cascade`: deleting a User deletes its sessions). Allowed on to-one and to-many fields, either direction; each side has its own rule. Resolved into `ResolvedRelationField.onDelete` (absent = `SetNull`, the current behaviour). Unknown `@relationship` arguments, bad rule values, duplicated arguments and two fields on the same edges with different rules are validation errors.
  - **Client**: `delete` and `deleteMany` apply the rules in the same transaction: `Cascade` deletes linked nodes recursively (following their own rules, cycle-safe), `Restrict` throws the new `RestrictError` (`model`, `relation`, `target`, `count`) before anything is deleted, `SetNull` removes the edges. Nodes are write-locked before their edges are read, so concurrent links are not missed. Models without rules keep their single `DETACH DELETE` statement.
  - **Migrations**: rule changes need no DDL; `cyphra migrate dev` / `migrate diff` list them as notes (`MigrationPlan.notes`).
  - **Editor**: completion of `onDelete` and its values, hover documentation, precise diagnostics.
  - **Better Auth**: `references.onDelete` is generated into the schema (`cascade` → `Cascade`, `restrict` / `no action` → `Restrict`, `set null` / `set default` → default) and applied by the runtime; the adapter's own cascade code is gone. Re-run `npx @better-auth/cli generate` to add the rules to your `schema.cyphra`.

- ff359dc: HTTP transport for edge runtimes (#104). `createClient` / `new CyphraClient` connect over the Neo4j
  Query API (Neo4j 5.19+, Aura) with `fetch` when the URI is `https://` / `http://`, or with
  `transport: "http"` (a `neo4j+s://host` URI maps to `https://host`). The whole typed client works
  over it: CRUD, nested writes, upsert, aggregates, traversals, vector and full-text search,
  `$cypher` and `$transaction` (explicit Query API transactions, cluster affinity header echoed,
  transient errors retried), with the same logging, tracing and missing-index warnings. Options:
  `token` (Bearer), `fetch`, `headers`, `maxRetryTimeMs`, `maxConcurrency` (default 4: keeps a
  client from exhausting the server's HTTP worker threads with lock waits). Errors are `Neo4jHttpError` with the Neo4j
  `code` and HTTP `status`.

  `@cyphra/runtime` and `cyphra` ship an edge build without `neo4j-driver` or Node.js built-ins,
  selected by the `workerd`, `edge-light` and `worker` export conditions (`@cyphra/runtime/edge` to
  import it explicitly), so a generated client runs on Vercel Edge and Cloudflare Workers unchanged.
  The ORM now builds parameters with its own `CypherInteger`, `CypherDateTime`, … classes (exported),
  which `neo4j-driver` 5 and 6 send exactly like their own values. `@cyphra/schema` no longer imports
  `node:buffer`, and loads `node:fs/promises` only when `parseSchemaFile` is called.

- 13de328: Validation rules in `schema.cyphra`: `@length(min, max)`, `@size(min, max)`, `@min(value)`, `@max(value)`, `@email`, `@url`, `@regex(pattern, flags)` and `@nonEmpty` on scalar fields of nodes and relationship models.

  - **Schema**: rules are checked against the field type (`@length`, `@email`, `@url`, `@regex` on `String`; `@size` on lists; `@min` / `@max` on `Int`, `Float`, `BigInt`, `DateTime`, `Date`; `@nonEmpty` on `String` and lists), with typed arguments, `min` ≤ `max`, regexes that compile and defaults that satisfy them. Arguments may be positional (`@length(3, 20)`) or named (`@length(max: 280)`). Resolved into `ResolvedScalarField.rules` (`ValidationRule[]`), printed by `cyphra format`, and documented on generated fields (`/** Validation: \`@length(3, 20)\`. */`). `checkRules`and`formatRule` are exported for other generators.
  - **Client**: every write (`create`, `createMany`, `update`, `updateMany`, `upsert`, nested `create`, `$edge` of `create` / `connect` / `set`) is checked before any statement is sent. `CyphraValidationError` gets `issues: { path, model, field, rule, message }[]` listing every broken rule, with the path into the operation's arguments (`["data", "posts", "create", 1, "title"]`). `increment` / `decrement` / `multiply` on `@min` / `@max` fields are checked against the resulting value inside the update statement: out of range, nothing is updated.
  - **CLI**: `cyphra validate --verbose` lists the rules of every field.
  - **Migrations**: rule changes need no DDL; `cyphra migrate dev` lists them as notes.
  - **Editor**: completion of the rules that fit the field type, hover documentation, argument diagnostics.

### Patch Changes

- Updated dependencies [603c4f1]
- Updated dependencies [ff359dc]
- Updated dependencies [13de328]
  - @cyphra/schema@0.10.0
  - @cyphra/query@0.10.0

## 0.9.0

### Minor Changes

- 05ecf49: Composite uniqueness constraints and indexes: `@@unique([a, b], name?)` and `@@index([a, b], name?)` model attributes.

  - **Schema**: validated (at least two existing scalar, single-value fields, no duplicates, names unique across all indexes and constraints) and resolved into `compoundUniques` / `compoundIndexes` on `ResolvedNodeModel`. Printed and formatted like other model attributes.
  - **Migrations, `cyphra push`, `cyphra schema ddl`**: `CREATE CONSTRAINT … REQUIRE (n.a, n.b) IS UNIQUE` (works on Neo4j Community; node keys are Enterprise-only and not used) and `CREATE RANGE INDEX … ON (n.a, n.b)`; a change of fields or name drops and recreates them. `cyphra pull` maps composite uniqueness constraints, node keys and composite range indexes back to `@@unique` / `@@index`.
  - **Client**: a `@@unique` is a unique key in `findUnique`, `findUniqueOrThrow`, `update`, `delete`, `upsert` (one `MERGE` on all of its fields) and `connect` / `disconnect` / `set`, in the Prisma shape `where: { a_b: { a, b } }` (or the attribute's `name`), fully typed.
  - **Editor**: completion of fields inside `@@unique([…])` / `@@index([…])`, hover documentation and precise diagnostics.

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

- b204047: Schema: spatial `Point` / `CartesianPoint` and the temporal `LocalDateTime`, `LocalTime`, `Time` and
  `Duration` types, end to end.

  - **`Point`** (WGS-84, `{ longitude, latitude, height? }`) and **`CartesianPoint`** (`{ x, y, z? }`)
    are stored as Neo4j points (2D or 3D) and exported as JS types. They filter on equality,
    `distance: { from, lt, lte, gt, gte }` (`point.distance`, meters for WGS-84) and
    `withinBBox: { lowerLeft, upperRight }` (`point.withinBBox`), and sort by distance:
    `orderBy: { location: { distanceFrom: here } }`. `@index` on a point field creates a
    `POINT` index (migrations, `cyphra push`, `cyphra schema ddl`).
  - **`LocalDateTime`**, **`LocalTime`**, **`Time`** and **`Duration`** are ISO 8601 strings in JS
    (`"2024-05-01T10:30:00"`, `"10:30:00"`, `"10:30:00+02:00"`, `"PT1H30M"`), typed with exported
    template literal types and returned in the `Temporal` API's format, from either `neo4j-driver`
    major. Neo4j stores, compares and sorts them as temporal values. The first three filter with
    `lt` / `gt`, sort and take `_min` / `_max`; durations have no total order, so they compare for
    equality only. `@default(now())` works on `LocalDateTime`, `LocalTime` and `Time` (UTC wall
    clock), and all four take an ISO text default (`@default("PT45M")`).
  - `cyphra pull` keeps these types (a point property becomes `Point` or `CartesianPoint` from the
    CRS of its sampled values; a `LocalDateTime` property is no longer pulled as `DateTime`) and maps
    point indexes to `@index`. Migrations backfill temporal defaults with Cypher temporal values.
  - A node named like one of these types (`node Point { … }`) still works as a relation target.
  - The language server and VS Code extension highlight, complete and document the new types.

### Patch Changes

- Updated dependencies [05ecf49]
- Updated dependencies [42d02bd]
- Updated dependencies [b204047]
  - @cyphra/schema@0.9.0
  - @cyphra/query@0.9.0

## 0.8.0

### Minor Changes

- f51239c: `orderBy` on a to-one relation sorts by a scalar of the related node: `orderBy: { author: { name: "asc" } }` (nodes without the relation sort as `null`). Works in `findMany`, nested `include` and `traverse`, and is typed in the generated client.
- e22de55: Schema: `enum Role { ADMIN USER }` declarations, and the `Json` and `BigInt` scalar types.

  - **Enums** are used as field types (`role Role @default(USER)`, `Role?`, `Role[]`, also on
    relationship properties) and stored as strings. `cyphra generate` emits a const object and a
    union type per enum (`Role.ADMIN`, `type Role = "ADMIN" | "USER"`). Every write (nested creates,
    `createMany`, `upsert`, `$edge` included) rejects a value outside the enum, and filters
    (`equals`, `not`, `in`, `notIn`, list operators) are typed to it. Migrations warn when a value is
    removed from an enum, with a query that finds the nodes still holding it.
  - **`Json`** fields take and return any `JsonValue` (exported type), stored as the value's JSON text.
    They filter on `null`, `{ equals }` and `{ not }` only, and take a JSON-text default
    (`@default("{}")`).
  - **`BigInt`** fields are Neo4j 64-bit integers read and written as JS `bigint`, exact over the whole
    range (-2^63 to 2^63-1), with either `neo4j-driver` major. They filter (`lt`, `gt`, `in`, …), sort,
    take `{ increment: 1n }` updates and `@default(0)` literals (every digit kept), and aggregate:
    `_sum`, `_min` and `_max` are `bigint`, `_avg` a `number`.

  `createMany` now rejects its promise on invalid data instead of throwing synchronously.

### Patch Changes

- Updated dependencies [e22de55]
  - @cyphra/schema@0.8.0
  - @cyphra/query@0.8.0

## 0.7.0

### Minor Changes

- fc22aac: Add vector similarity search to the ORM client.

  - `db.chunk.findSimilar({ field, vector, k, where, minScore, select, include })` returns the `k` nodes most similar to `vector`, best first, each with a `$score` (the index's score in `[0, 1]`), through `db.index.vector.queryNodes` (Neo4j 5.15+). It exists only on models with a `Vector(N) @vectorIndex` field, and `field` only accepts those fields; the vector length is checked at runtime.
  - With `where`, the search over-fetches `candidates` neighbours (default `max(10 × k, 100)`), filters them in the same statement and widens (×4) until `k` rows match, the index is exhausted, scores fall below `minScore`, or `maxCandidates` is reached. `exact: true` skips the index and ranks the nodes matching `where` with `vector.similarity.*` (Neo4j 5.18+), for selective filters.
  - Vector fields are written as float lists with their length checked on `create`, `update`, `upsert` and `createMany`, filter only on `null`, and cannot be sorted. Works in `$transaction`. The new `FindSimilarArgs`, `SimilarResult`, `VectorKeys` and `VectorIndexKeys` types are exported.

- 1e3c799: Add full-text search to the ORM client.

  - `db.post.search({ index, query, mode, where, minScore, skip, take, select, include })` queries a `@@fulltext` index through `db.index.fulltext.queryNodes` and returns the matching nodes, most relevant first, each with a `$score` (Lucene's relevance score). It exists only on models with a `@@fulltext` attribute, and `index` only accepts that model's index names.
  - `query` is Lucene query syntax by default (`mode: "lucene"`); `mode: "terms"` and `mode: "phrase"` escape it to search plain words or a phrase. The new `escapeLucene(text)` helper escapes user input for queries you build yourself. A blank query returns `[]`.
  - `where` and `minScore` filter the hits in the same statement, before `skip` / `take`; full-text queries return every match, so a filtered search never comes back short. Works in `$transaction`, where the index sees the transaction's own writes. The new `SearchArgs`, `SearchMode`, `SearchResult` and `FulltextIndexNames` types are exported.

### Patch Changes

- Updated dependencies [1e3c799]
- Updated dependencies [fc22aac]
  - @cyphra/schema@0.7.0
  - @cyphra/query@0.7.0

## 0.6.0

### Minor Changes

- 4832219: Add relation counts to the ORM client, with Prisma-compatible shapes typed from your schema.

  - `include: { _count: true }` counts every to-many relation; `_count: { select: { posts: true, comments: { where: { approved: true } } } }` counts the listed ones, with an optional filter on the related node (relation filters included). Works under `select` and `include`, inside included relations at any depth, and in the results of `find*`, `create`, `update`, `upsert` and `delete`. The result has a `_count: { posts: number, … }` key typed from exactly what you ask for.
  - `orderBy: { posts: { _count: "desc" } }` sorts by the number of related nodes, at the top level and inside included relations.
  - Counts compile to `COUNT {}` subqueries in the same statement. As in Prisma, to-one relations cannot be counted.

- 3f2c13d: Add shortest-path queries to the ORM client.

  - `db.user.shortestPath({ from, to, via, maxDepth, direction, where, edgeWhere, select, include })` returns one shortest path between the nodes matching `from` and `to` along self-relations, or `null`; `db.user.allShortestPaths({ …, take })` returns every path of the minimal length. Both compile to one statement with a GQL shortest-path selector (`SHORTEST 1` / `ALL SHORTEST`), so they need Neo4j 5.21 or later.
  - `maxDepth` is required and capped by the client option `maxTraversalDepth` (default 10). `where` (intermediate nodes) and `edgeWhere` (every edge) are applied before the shortest path is picked. When `from` / `to` match several nodes, the overall shortest paths over every pair are returned; a node matching both gives a zero-hop path.
  - Results are typed paths (`{ nodes, edges }`): nodes are shaped by `select` / `include`, edge properties are typed from the `relationship { … }` model. The new `ShortestPathArgs` and `ShortestPathResult` types are exported.

- 879de50: Add variable-length traversals and typed path results to the ORM client.

  - `db.user.traverse({ from, via, depth: { min?, max }, where, edgeWhere, distinct, direction, select, include, orderBy, skip, take })` follows one or more self-relations (e.g. `following`) for `min..max` hops and returns the reached nodes, in one statement compiled to a quantified path pattern (Neo4j 5.9+). `depth.max` is required and capped by the new client option `maxTraversalDepth` (default 10). Each reached node is returned once by default; paths that loop back to their start node are skipped.
  - `edgeWhere` filters every edge of the path on the properties of its `relationship { … }` model, typed from the schema.
  - `returnPaths: true` returns `{ node, path }`, where `path` is `{ nodes, edges }`: the path's nodes (scalar fields) and its edges (`type`, `direction`, typed `properties`). The exported `Path`, `PathEdge` and `ModelPath` types describe them. Paths are decoded from plain maps, so they work with `neo4j-driver` 5 and 6.

### Patch Changes

- @cyphra/query@0.6.0
- @cyphra/schema@0.6.0

## 0.5.0

### Minor Changes

- a8be483: Support `neo4j-driver` 6 alongside 5.28 (`^5.28.3 || ^6.0.0`).

  - `@cyphra/runtime`, `@cyphra/migrator` and `@cyphra/better-auth` now declare `neo4j-driver` as a peer dependency, so your app and Cyphra share a single driver. `cyphra` and `@cyphra/cli` depend on it directly with the same range, so `npm i cyphra` still works on its own. If you install the `@cyphra/*` subpackages with a package manager that does not install peer dependencies (Yarn), add `neo4j-driver` yourself.
  - `new CyphraClient({ driver })` and `createClient({ driver })` reuse a `Driver` your app already created (5.28+ or 6.x, even from another copy of the package). Cyphra does not close a driver you pass in.

- e5851e2: Add `aggregate` and `groupBy` to the ORM client, with Prisma-compatible shapes typed from your schema.

  - `db.post.aggregate({ where, _count, _sum, _avg, _min, _max })` returns exactly the aggregates you ask for. `_sum` / `_avg` take `Int` and `Float` fields, `_min` / `_max` also `String`, `DateTime` and `Date`. Nulls are ignored; on an empty match counts are `0` and the other aggregates `null`.
  - `db.post.groupBy({ by: ["published"], having, orderBy, skip, take, … })` groups the matching nodes, with `having` and `orderBy` on aggregates (`{ views: { _avg: { gt: 10 } } }`, `{ _count: { id: "desc" } }`) and on the `by` fields. Fields of a to-one relation can be grouped on with `by: ["author.name"]` and come back as `{ author: { name } }`.
  - Each call compiles to one parameterised Cypher statement and works inside `$transaction`.

### Patch Changes

- @cyphra/query@0.5.0
- @cyphra/schema@0.5.0

## 0.4.0

### Minor Changes

- e1ad59f: New package `@cyphra/better-auth`: a Better Auth database adapter built on the Cyphra ORM, so auth data (users, sessions, accounts, verifications, plugin models) and your own models live in one typed graph with one schema and one migration system. The Cyphra schema is derived from your Better Auth configuration at runtime; foreign keys are stored as `HAS_*` edges; `npx @better-auth/cli generate` merges the auth models into `schema.cyphra` and keeps your own models and fields. Passes Better Auth's adapter conformance suites (normal, case-insensitive, transactions, joins, uuid, auth flow). Includes `neo4jBetterAuthMigration()` to convert data written by `neo4j-better-auth`.

  `@cyphra/runtime`: string filters accept `mode: "insensitive"` (Prisma-compatible) for case-insensitive `equals`, `not`, `in`, `notIn`, `contains`, `startsWith` and `endsWith`.

  `@cyphra/schema`: `cyphra generate` types a node without relations as `relations: Record<never, never>` instead of `{}`, which failed `@typescript-eslint/no-empty-object-type` in projects that lint the generated client.

### Patch Changes

- Updated dependencies [e1ad59f]
  - @cyphra/schema@0.4.0
  - @cyphra/query@0.4.0

## 0.3.0

### Minor Changes

- 232fbcc: ORM write correctness fixes and string range filters:

  - `upsert` now compiles to a single atomic `MERGE` on the unique key from `where` (`ON CREATE SET` the create data and schema defaults, `ON MATCH SET` the update), then runs nested relation writes of the branch it took in the same transaction. Concurrent upserts of one new key no longer fail with `ConstraintValidationFailed`; with the uniqueness constraint that `@id` / `@unique` generate (`cyphra push` or a migration) they yield exactly one node. The key never gets a generated default, `create` may not set the key to a different value than `where`, and extra `where` conditions are checked on an existing node before it is updated (a mismatch throws `CyphraError` and writes nothing).
  - `connect` (in `create`, `update`, `set` and `upsert`) now `MERGE`s the relationship instead of `CREATE`, so connecting an already linked pair keeps one edge. On typed edges, `$edge` plus defaults apply when the edge is created; an existing edge gets only the `$edge` properties passed. A to-one `connect` (e.g. `post.update({ author: { connect } })`) now deletes the previous edge in the same statement as the `MERGE`, with the node locked, so concurrent author changes leave one edge. Likewise, when the target's side of the relation is declared to-one (e.g. `user.posts` → `connect` on a post, with `Post.author User?`), the target's previous edge of that type is deleted in the same statement (the target is locked first, so concurrent connects leave one edge); many-to-many relations are unaffected. Edges duplicated by earlier versions are left in place.
  - `DateTime` values (writes, `@default(now())` and filter parameters) are always stored at UTC offset `Z` instead of the process's local offset, so `equals` / `in` match the same instant regardless of the server's `TZ`. Values written by earlier versions with a non-zero offset still read back correctly, but exact-instant comparisons against them do not match; see the docs for a one-off Cypher to normalize them.
  - Typed filters: `lt` / `lte` / `gt` / `gte` on `String` fields (lexicographic), e.g. for keyset pagination on an `id` tie-breaker.

### Patch Changes

- @cyphra/query@0.3.0
- @cyphra/schema@0.3.0

## 0.2.2

### Patch Changes

- e7419f9: Package metadata: npm pages now link to www.cyphra.dev (instead of the old cyphra-doc.vercel.app) and describe Cyphra as the TypeScript ORM for Neo4j, with matching keywords.
- Updated dependencies [e7419f9]
  - @cyphra/schema@0.2.2
  - @cyphra/query@0.2.2

## 0.2.1

### Patch Changes

- @cyphra/query@0.2.1
- @cyphra/schema@0.2.1

## 0.2.0

### Minor Changes

- d836db9: Typed ORM client generated from `.cyphra` schemas.

  - `cyphra generate` now emits model types, a `CyphraTypeMap` and a typed `createClient()` alongside the existing label / relationship constants (`runtimeImport` in `cyphra.json` picks the import, default `"cyphra"`).
  - New ORM runtime: `findMany`, `findFirst`, `findUnique(OrThrow)`, `count`, `create` (nested `create` / `connect`), `createMany`, `update` (number ops, `connect` / `disconnect` / `set`), `updateMany`, `upsert`, `delete`, `deleteMany`, `$transaction`, and `$cypher` for raw queries. `select` / `include` with nested relation `where` / `orderBy` / `skip` / `take`, typed edge properties under `$edge`, and relation filters (`some` / `none` / `every`, `is` / `isNot`). Requires Neo4j 5.6+.
  - Correct value mapping: `Int` is sent as a Neo4j integer (not a float), integers read back as `number` (throwing outside the safe range), `DateTime` / `Date` as JS `Date`.
  - Schema: scalar lists (`String[]`), `Date` type, literal defaults (`@default("x")`, `@default(0)`, `@default(true)`), and `resolveSchema()` producing a JSON `SchemaModel` with cross-reference checks (also run by `cyphra validate`).
  - CLI: fix a duplicated shebang in the built binary.

### Patch Changes

- Updated dependencies [d836db9]
  - @cyphra/schema@0.2.0
  - @cyphra/query@0.2.0
