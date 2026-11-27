# @cyphra/graphql

## 0.28.0

### Minor Changes

- 39bf5f8: `compat.v7` runs more requests on the shared engine, with the same results: connection `aggregate` selections (root and nested), aggregation filters, `@fulltext` queries, and `@cypher` fields of node types (fields returning nodes, list fields, scalar fields whose statement is a lone `RETURN`, `$jwt`, arguments, and filters and sorts on them). `@cypher` statements that aggregate (`count()`, `collect()`, …) still run on the compat compiler outside the `where` of a root query, because Neo4j 5 rejects them inside the expressions the engine projects. With `client`, the client's `query` events and spans now name the engine operation for these requests too.

### Patch Changes

- Updated dependencies [55a869b]
  - @cyphra/runtime@0.28.0
  - @cyphra/schema@0.28.0

## 0.27.0

### Minor Changes

- e378ea2: `compat.v7` runs more requests on the shared engine, with the same results: types with `@authentication` (checked where v7 checks it), writes whose `@authorization` `validate` rules fail for the request (run in a transaction that raises `Forbidden` once a node is written, and is rolled back), `@timestamp` fields (the database clock in the statement), `@limit` types in mutations, DateTime values (their offset and sub-millisecond precision kept), connection edge filters and edge sorts, and to-one connections. With `client`, the client's `query` events and spans now name the engine operation for these requests too.
- 6b0ba27: Migration tooling from `compat.v7` to the native API (#249). `cyphra graphql migrate-operations`
  rewrites v7 operations (`.graphql` files, `gql` / `graphql` templates in TS and JS) into native
  ones and reports what it cannot translate, with file, line and column (`--dry-run`, `--check`,
  `--json`); a document with a construct that has no native equivalent is left as it is, with a
  `# cyphra: not translated: …` comment. `cyphra graphql compare` runs each v7 operation on
  `compat.v7` and its translation on the native API (in-process, or against two endpoints), maps the
  v7 result to the native shape and reports the differences, known ones (cursors, `connect` as a
  MERGE) apart; `--reset` (reset and seed before each run) has the safety check of `cyphra migrate
reset`: a non-local URI is refused unless `--force`, and it asks first unless `--yes`. `cyphra graphql migrate-rules` drafts native `rules` and `authenticated` from
  `@authorization` / `@authentication` as TypeScript to review, with a `TODO(cyphra)` comment for
  what the native API cannot express. The same functions are exported as `migrate.translateDocument`,
  `migrate.compareResults` and `migrate.draftRules` (experimental). The native API docs list every
  v7 construct and its native equivalent.

### Patch Changes

- Updated dependencies [fd05388]
  - @cyphra/runtime@0.27.0
  - @cyphra/schema@0.27.0

## 0.26.0

### Minor Changes

- 751c55e: `compat.v7` runs more requests on the shared engine, with the same results: `single` relationship filters, and reads and root mutations of types with `@authorization`. The rules are applied where v7 applies them (root nodes, nested relationships and connections, update and delete targets); requests whose `validate` rules may fail, or whose rules the engine cannot evaluate exactly like v7, stay on the compat compiler, as do types with `@authentication`. With `client`, the client's `query` events and spans now name the engine operation (`findMany`, `updateMany`, …) for these requests too.
- 8b74583: Native API extension points (#247): `computed` exposes the client's computed fields
  (`$extends({ result })`, their `needs` loaded when selected); `cypherFields` adds Cypher-backed
  fields (the native `@cypher`, built with `native.cypher`), compiled into the parent's statement
  with arguments and context values bound as parameters, returning scalars (filterable and sortable)
  or nodes (filtered by the target's read rules); `extend` merges SDL and resolvers into the
  generated schema (non-node result types, custom root fields, fields added to generated types),
  with `ctx.cyphra` (the request's client, rules applied) and `ctx.cyphra.selection(info)` (the
  selection as the client's `select`, so a custom resolver loads generated types in one statement).
  Rules do not apply inside the Cypher of a Cypher-backed field.

### Patch Changes

- 3b850b3: `compat.v7` runs `single` relationship filters (`actors: { single: … }`, `actors_SINGLE`, `actorsConnection: { single: … }`) on the shared engine, as a `_count` of the matching related nodes equal to 1, with the same results.
- Updated dependencies [db04150]
  - @cyphra/runtime@0.26.0
  - @cyphra/schema@0.26.0

## 0.25.0

### Minor Changes

- b2dbf64: Native API aggregates and search (#246): `<model>Aggregate` (`_count` / `_sum` / `_avg` / `_min` / `_max` typed per field, `where`, and `orderBy` / `skip` / `take` for a window) and `<model>GroupBy` (`by: { fields, <toOneRelation> }`, `having` on keys and aggregates, `orderBy` by key or aggregate, only the selected aggregates computed); `<model>Search` on `@@fulltext` indexes (`index`, `query`, `mode`, `where`, `minScore`, `skip`, `take`) and `<model>FindSimilar` on `@vectorIndex` fields (`field`, `vector`, `k`, `where`, `minScore`), with `_score` on the hits; `<union>Search` / `<union>FindSimilar` over the members' indexes (reciprocal rank fusion, `indexes` / `fields`, `_on` filters, `rrfK`), with `_scores: [IndexScore!]`. `aggregate`, `groupBy` and `search` are read operations (on by default); `findSimilar` is in the new `traverse` operation group, off by default. Read rules hide nodes from counts, groups and hits, row-dependent field rules from aggregated values, and a field a context-only rule denies cannot be aggregated or grouped on (`FORBIDDEN`). `_score` / `_scores` outside a search, and a group field not listed in `by`, are `BAD_USER_INPUT`. Every model now prints its aggregate and groupBy types: regenerate a committed contract with `cyphra graphql print`.
- 942ebc0: Native GraphQL API: relation update inputs take nested `update` (`[{ where, data }]` on to-many, the data on to-one), `delete` (unique keys, or `true` on to-one; `onDelete` rules apply), `upsert` (`[{ where, create, update }]` / `{ create, update }`) and `connectOrCreate` (also in create inputs), each served when the target's matching operation is on, all in the root field's one statement and under its rules (`NOT_FOUND`, `RESTRICTED`, `FORBIDDEN`, validation issues with GraphQL argument paths). `<Model>Where` takes `_count` filters on to-many relations (`_count: { posts: { gte: 2, where: { … } } }`), counting only readable nodes; rule `where`s may use them too. In the runtime, a uniqueness violation from a batched nested create now names its model and fields.
- 1ac6f9d: Native API traversals (#246): `<model>Traverse` (`from`, `via`, `direction`, `depth`, `where`, `distinct`, `orderBy`, `skip`, `take`), `<model>TraversePaths` (`{ node, path { nodes, edges { type direction _edge } } }`) and `<model>ShortestPath` (`from`, `to`, `via`, `maxDepth`, `where`) on models with relations back to themselves, in the `traverse` operation group (off by default); named traversal fields across models from `config.traversals` (`{ Chunk: { context: { via: [{ rel }, …], args } } }` → `Chunk.context(…): [Chunk!]!`), compiled into the parent's statement and checked at startup; `limits.maxTraversalDepth`. A traversal never steps through a node the read rules hide, and path nodes follow the field rules.

### Patch Changes

- Updated dependencies [1ac6f9d]
- Updated dependencies [942ebc0]
- Updated dependencies [1e0082e]
  - @cyphra/runtime@0.25.0
  - @cyphra/schema@0.25.0

## 0.24.0

### Minor Changes

- c287e0d: Native API auth (#245): `models.<M>.rules` (`read`, `create`, `update`, `delete`, `connect` / `disconnect` per relation, `after.create` / `after.update`), functions of the request's context typed against the generated client and compiled into every statement that reaches the model (relation loads and filters, `_count`, `totalCount`, mutation results, write targets); `authenticated` per model or operation group (`UNAUTHENTICATED`, and for a whole group the model is hidden or not writable for anonymous requests wherever it is reached); field rules, context-only (`read: ({ ctx }) => boolean`: `null` with `FORBIDDEN` where selected, `FORBIDDEN` where filtered or sorted on) or row-dependent (`read: { where }`: `null` on the rows outside it, in results, filters and ordering), with ruled fields generated nullable; `native.jwtContext({ key, user })` (the `compat.v7` verifier) and `native.context(schema, build)` setting `ctx.cyphra`, the request's client with the rules applied (`$unsafe` without). Outside an `update` / `delete` / `connect` rule a node is `NOT_FOUND`; `false` and failing `create` / `after` rules are `FORBIDDEN` (rolled back). `makeSchema` checks rule keys and relations, and calls each `where` rule with an empty context to check the fields it names.

### Patch Changes

- Updated dependencies [ca21801]
  - @cyphra/runtime@0.24.0
  - @cyphra/schema@0.24.0

## 0.23.0

### Minor Changes

- 609a44c: `compat.v7` runs list and connection queries on the shared engine (the typed client's compiler) when it answers exactly like v7: filters, sorting, `limit` / `offset`, v7 offset cursors, nested relationships and connections with edge `properties`, on types without `@authentication` / `@authorization`. Everything else (aggregations, full-text, `@cypher`, rules, unions, interfaces, edge filters and sorts, `single`, mutations, …) stays on the compat compiler, so results do not change. With `client`, the client's `query` events and spans now name the engine operation (`findMany` on `Movie`) for these queries, and a root connection selecting both a page and `totalCount` reads them with two statements in one read transaction. `@cyphra/runtime`: internal `withRawValues(client)` engine entry.
- 5f36831: `compat.v7` runs root mutations on the shared engine when it writes and answers exactly like v7: `create` with attribute inputs (`createMany`, `info.nodesCreated`), `update` with `set` operators (`updateMany`), and `delete` without nested deletes (`deleteMany`, with `relationshipsDeleted`), the response selection read in the same statement. Nested writes (v7's `connect` is a `CREATE`, the engine's a `MERGE`), arithmetic and list operators, deprecated `field_SET` keys, `@timestamp` and `@limit` types, DateTime values and types with rules stay on the compat compiler. `@cyphra/runtime`: internal `deleteMany({ $relationships: true })` engine entry (the number of relationships a delete removed).

### Patch Changes

- Updated dependencies [609a44c]
- Updated dependencies [5f36831]
  - @cyphra/runtime@0.23.0
  - @cyphra/schema@0.23.0

## 0.22.0

### Minor Changes

- 7704cb2: Native GraphQL API: writes (#243). `defineGraphQL` turns them on per model, by group
  (`operations: { create, update, delete }`, `true` or a list; still off by default), and serves
  `<model>Create`, `CreateMany`, `Update`, `UpdateMany`, `Upsert`, `Delete` and `DeleteMany` as
  `Mutation` root fields, each one client operation compiled to one statement. Mutations return
  records (the deleted one for `delete`); batch mutations return `<Model>Batch { count nodes }`,
  loading `nodes` only when selected.

  - Nested `create` / `connect` / `disconnect` / `set`, with inputs per relation side
    (`UserCreateWithoutPostsInput`, `PostCreateManyWithoutAuthorRelation`, `UserConnectFollows`).
    `connect` is a `MERGE`: connecting a linked pair keeps one edge and updates its `_edge`. A model
    whose `create` is off has no nested create either.
  - Scalar updates take plain values (`null` removes the property) and numeric operators in `_ops`
    (also on `_edge` of `connect` / `set`); a value and an operator on one field is `BAD_USER_INPUT`.
  - Field toggles `create` / `update` remove fields from the write inputs (`{ read: false, create:
true }` is a write-only field); `makeSchema` refuses a creatable model with a required field that
    cannot be set.
  - Validation issues (`extensions.issues`) carry GraphQL argument paths
    (`["data", "posts", "create", 1, "title"]`, `["data", "_ops", "loginCount"]`); unique constraint
    violations are `UNIQUE_CONSTRAINT`, missing targets `NOT_FOUND`.
  - `mutationTransaction: "request"` runs every root field of a mutation operation in one write
    transaction (default: one per root field).

### Patch Changes

- Updated dependencies [6f0644f]
  - @cyphra/runtime@0.22.0
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

- 6933517: Native GraphQL API (experimental): opt-in Relay and the printed contract.

  - `relay: true` in `defineGraphQL`: a `Node` interface implemented by every model with a `String`,
    `Int` or `BigInt` `@id` (interfaces included), global ids (`base64("<Type>:<id>")`,
    `native.toGlobalId` / `native.fromGlobalId`) and `node(id: ID!)`. The model's own `id` field is
    returned as `rawId`; inputs keep `id`. Off by default.
  - `cyphra graphql print [--config <file>] [--export <name>] [--out <file>] [--check]`: the native
    API's sorted SDL from `schema.cyphra` and `graphql.config.ts`, without a database. `--check`
    exits with 1 when the committed file differs, listing breaking and dangerous changes.

### Patch Changes

- Updated dependencies [5b60cb4]
- Updated dependencies [66bc969]
  - @cyphra/runtime@0.21.0
  - @cyphra/schema@0.21.0

## 0.20.1

### Patch Changes

- 368b85f: `compat.v7` honours `context.sessionConfig` per request, like `@neo4j/graphql` 7: its `database`, `impersonatedUser` and `auth` are spread over the session options of every generated statement (`sessionConfig.database` wins over the `database` passed to `makeSchema`). With a `CyphraClient`, a request that sets `sessionConfig` now fails with an error instead of silently running on the client's database. New compat fixture `session-config` (#251).
- 7c766e5: `cyphra import graphql`: a shared label or GraphQL interface whose implementations declare the same id differently (`id: ID! @id` on one, a plain `id: ID!` on another) is now converted to an interface instead of `@@labels` (which also dropped every relationship to the interface, and made `--id-fields Interface.id` fail with "the label is not an interface"). The interface declares the id `@id`, with `@default(uuid())` when one implementation generated its ids, and the report explains the decision (#252).
  - @cyphra/runtime@0.20.1
  - @cyphra/schema@0.20.1

## 0.20.0

### Minor Changes

- c102054: `compat.v7.makeSchema` now reports every unsupported construct and invalid usage of the type definitions at once: `UnsupportedTypeDefsError` lists them all and keeps them in `issues` (`code`: `UNSUPPORTED` or `INVALID`, `message`, `location`: type, field, line and column). With a single issue the message is unchanged. `UnsupportedTypeDefsError` now extends `CyphraError`. New `compat.v7.checkTypeDefs(typeDefs, opts)` returns the issues without building the schema (several files can be checked together), and the new `cyphra graphql check <files...>` command prints them (`--json`; exit code 1 when there are issues).
- 2edf304: `compat.v7.makeSchema` serves interfaces with `@neo4j/graphql` 7 semantics: the exact v7 schema
  (interface types, `${Interface}Implementation` and the `typename` filter, implementation-keyed
  create inputs, the interface's connection types on `@declareRelationship` fields, edge inputs keyed
  by properties type), root `learningActivities` / `learningActivitiesConnection` queries with sorting,
  pagination and `aggregate`, relationships to interfaces, filters through them, nested `create`,
  `connect`, `update`, `disconnect` and `delete`, and each implementation's `@authorization`. Like v7,
  interfaces add no label: a node belongs to the interface when it has the labels of one
  implementation. `@query`, `@plural`, `@limit` and the field configuration directives work on
  interfaces. Queries v7 7.6.8 fails on (interface aggregates with `@authorization` rules,
  `count { edges }` on interface connections, `typename` in nested filters) are served.
- c719966: `cyphra import graphql` maps shared `@node` labels and constrained ids:

  - A label after the first in `@node(labels: ["Lab", "LearningActivity"])` becomes a Cyphra
    `interface LearningActivity` that the types carrying it implement, with the fields they declare
    the same way. When their common fields do not line up, it becomes `@@labels([LearningActivity])`
    instead. A GraphQL `interface` becomes a Cyphra interface (relationships to it included) when its
    implementations carry its label, or with `--add-interface-labels` (the report gives the Cypher that
    adds the label to existing nodes).
  - `--url [uri]` reads the database's uniqueness constraints (read-only) and marks the fields they
    cover: an `ID` field becomes `@id`, another field `@unique`, a constraint over several properties
    `@@unique([…])`. `--id-fields Type.field,…` marks fields `@id` without a database. No default is
    added.
  - Every decision is listed in the report. `convertGraphQLTypeDefs` takes the same options
    (`constraints`, `idFields`, `addInterfaceLabels`).

### Patch Changes

- 0cc28d2: `compat.v7.makeSchema` returns its schema in `@neo4j/graphql` 7's order, so `printSchema` output is
  byte-identical to v7's: root types first, then scalars, enums, unions, interfaces, object types and
  input types (each sorted by name, like v7), and every field, argument, input field and enum value
  where v7 puts it (`moviesConnection(first, after, where, sort)` before
  `movies(where, limit, offset, sort)`, `OR` / `AND` / `NOT` after the attribute filters, …). A
  printed contract committed by a v7 application does not change when it switches.
  - @cyphra/runtime@0.20.0
  - @cyphra/schema@0.20.0

## 0.19.0

### Minor Changes

- 88c9fc4: `compat.v7.makeSchema` supports the v7 schema configuration directives with v7's exact schema and behaviour: `@mutation(operations)`, `@query(read, connection, aggregate)` (type, union and `extend schema` level), `@selectable`, `@settable`, `@filterable`, `@sortable` (fields, relationships and relationship properties, including their effect on nested inputs) and `@limit(default, max)` on every read of the type. Directives and arguments it does not implement are now always rejected with `UnsupportedTypeDefsError` instead of ignored: `@coalesce`, `@unique`, unknown directives on relationship fields, enums and enum values, and extra directives on `@jwt` / `@relationshipProperties` types. A root field hidden by `@query` / `@mutation` can be redefined in `Query` / `Mutation` and served by the application's resolvers (it never gets the generated resolver), and `@selectable` hides fields returning types without `@node`; combining `@customResolver` with a configuration directive is rejected like v7. Deliberate differences from v7: `limit: 0` / `first: 0` no longer bypass `@limit(max)`, and `@selectable(onRead: false)` on a to-one relationship (an invalid schema in v7) is rejected.
- 53ad657: `compat.v7.makeSchema` accepts `resolvers`, merged like `new Neo4jGraphQL({ typeDefs, resolvers })`:
  `Query` / `Mutation` fields without `@cypher` are served by them, object, input and union types
  without `@node` are passed through to the schema as written, and `@customResolver(requires)` fields
  are left out of the generated Cypher while the `requires` selection is always fetched for the
  parent. As in v7, `context.jwt` (from a verified token) and `context.executionContext` are set for
  the resolvers. The printed schema matches `@neo4j/graphql` 7.6.8. One deliberate difference:
  `@authentication` applies to every root field served by resolvers (v7 7.6.8 applies it to the first
  two only).
- dbee2a3: `compat.v7.makeSchema` supports to-one (non-list) relationships such as
  `lab: Lab @relationship(…)`, with the API `@neo4j/graphql` 7.6.8 generates for them: the field and
  its connection without arguments, `lab: { … }` / `lab: null` and `labConnection` filters (also in
  `@authorization` rules), nested `create` in create inputs and nested `delete` in `deleteX`. Like v7,
  a non-nullable to-one relationship (`Lab!`) is rejected, and a create input naming two members of a
  to-one union fails.

### Patch Changes

- @cyphra/runtime@0.19.0
- @cyphra/schema@0.19.0

## 0.18.0

### Minor Changes

- f6baa35: GraphQL subscriptions on Neo4j Change Data Capture, as in `@neo4j/graphql` v7: `@subscription`
  types get `<type>Created`, `<type>Updated` and `<type>Deleted` fields with a `where` argument,
  `@subscriptionsAuthorization` filters events and `@authentication(operations: [SUBSCRIBE])` checks
  subscribers. Enable them with `features.subscriptions` (`true`, options such as `pollTime` and
  `onlyGraphQLEvents`, or a `CDCSubscriptionsEngine`, also exported as
  `compat.v7.Neo4jGraphQLSubscriptionsCDCEngine`). They need Neo4j Enterprise or Aura with CDC
  enabled; on other databases subscribing fails with a clear error.

### Patch Changes

- Updated dependencies [27bfd81]
  - @cyphra/runtime@0.18.0
  - @cyphra/schema@0.18.0

## 0.17.0

### Minor Changes

- 8769c04: `compat.v7.makeSchema` serves `@neo4j/graphql` v7 unions of `@node` types instead of throwing `UnsupportedTypeDefsError`: the printed SDL is identical to v7 7.6.8 (root union query, `<Union>Where`, member-keyed connection `where` and nested write inputs), and union selections resolve with inline fragments and `__typename`. Relationships to a union support `where` / `limit` / `offset`, connections with edge properties, cursors, `totalCount` and edge `sort`, relationship and connection filters per member, `@authorization` rules of each member, and nested `create` / `connect` / `update` / `disconnect` / `delete` keyed by member. One deliberate difference: a union `connect` / `disconnect` nested in another one applies its `where`, which v7 ignores. `@cypher` fields returning unions still throw.
- e44f0ae: `cyphra import graphql` converts `@neo4j/graphql` v7 unions of `@node` types to Cyphra unions (`union Search = Movie | Genre`), and `@relationship` fields to a union to relation fields to it. Members renamed by `@node(labels)` keep their new names and `extend union` is merged. Properties on a relationship to a union are reported and left out (the relation field is converted), and unions of types without `@node` are reported as before.

### Patch Changes

- 2a57ffd: `cyphra import graphql` converts `properties` on a `@relationship` to a union: they become a `relationship` model with the union at that end, shared by the members' inverse fields with the same properties type (no longer reported as not converted).
- Updated dependencies [1d0fd3c]
  - @cyphra/schema@0.17.0
  - @cyphra/runtime@0.17.0

## 0.16.0

### Minor Changes

- 6c0a27b: Unions of unrelated models: `union SearchHit = Post | User | Comment` declares a type (no label, nothing to migrate) that relation fields can target (`items SearchHit[] @relationship(…)`). `db.searchHit` reads every member with `findMany`, `findFirst` and `count`, results discriminated by `__typename`; `where` takes `__typename` and `$on: { Post: { … }, User: {} }` (each listed member with its own filter), `select` / `include` take `$on`, `orderBy` takes `__typename`. Writes through a relation to a union name the member (`connect: { Post: { id } }`, `create: { User: { … } }`, `disconnect`, `set`), and `onDelete` rules apply to each member with its own rules. Unions are matched by label predicates, so they run the same on Neo4j, Memgraph and FalkorDB, and traversals can end on one.

  `where: { $on }` also works on interfaces (per-implementation filters). The generated client exports each union as the discriminated union of its members' types, the zod generator emits a `z.discriminatedUnion` read schema (no create or update schema), migrations generate no step for unions, `cyphra studio` lists them in their own section (read-only), and the language server and VS Code grammar know the `union` keyword.

### Patch Changes

- Updated dependencies [40ae155]
- Updated dependencies [af005ce]
- Updated dependencies [6c0a27b]
  - @cyphra/schema@0.16.0
  - @cyphra/runtime@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [86ed59e]
- Updated dependencies [ca885f5]
  - @cyphra/runtime@0.15.0
  - @cyphra/schema@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [d18afd9]
- Updated dependencies [98b668d]
  - @cyphra/schema@0.14.0
  - @cyphra/runtime@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [e586ac4]
- Updated dependencies [ec7fd51]
- Updated dependencies [ec7fd51]
  - @cyphra/runtime@0.13.0
  - @cyphra/schema@0.13.0

## 0.12.0

### Minor Changes

- a577140: `cyphra import prisma <schema.prisma>` converts a Prisma schema to `schema.cyphra`: models become
  nodes, foreign keys become edges (the key scalar is dropped, `onDelete` moves to the referenced
  model's field), implicit many-to-many relations become one edge type and explicit join models
  become `relationship` models with their extra columns as edge properties. Enums, `@id`, defaults,
  `@unique`, `@@unique`, `@@index`, `@@fulltext` and `@db.VarChar(n)` (as `@length`) convert; what does
  not (`Bytes`, `autoincrement()`, `@updatedAt`, `Decimal`, `@map`, constraints over foreign keys, …)
  is listed in a report. Same options as `cyphra import graphql`: `--out`, `--merge`, `--force`,
  `--print`. The converter is `convertPrismaSchema` in `@cyphra/schema` (no Prisma dependency), and
  the printing, merging and report formatting shared by both importers moved there too
  (`printImportResult`, `mergeImportResult`, `formatImportIssues`). See the new guide
  [Migrate from Prisma](https://www.cyphra.dev/guides/migrate-from-prisma).

### Patch Changes

- Updated dependencies [8c173d3]
- Updated dependencies [a577140]
- Updated dependencies [24588fa]
- Updated dependencies [a577140]
  - @cyphra/runtime@0.12.0
  - @cyphra/schema@0.12.0

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
  - @cyphra/runtime@0.11.0

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
