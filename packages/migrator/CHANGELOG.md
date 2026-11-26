# @cyphra/migrator

## 0.26.0

### Patch Changes

- Updated dependencies [db04150]
  - @cyphra/runtime@0.26.0
  - @cyphra/query@0.26.0
  - @cyphra/schema@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies [1ac6f9d]
- Updated dependencies [942ebc0]
- Updated dependencies [1e0082e]
  - @cyphra/runtime@0.25.0
  - @cyphra/query@0.25.0
  - @cyphra/schema@0.25.0

## 0.24.0

### Patch Changes

- Updated dependencies [ca21801]
  - @cyphra/runtime@0.24.0
  - @cyphra/query@0.24.0
  - @cyphra/schema@0.24.0

## 0.23.0

### Patch Changes

- Updated dependencies [609a44c]
- Updated dependencies [5f36831]
  - @cyphra/runtime@0.23.0
  - @cyphra/query@0.23.0
  - @cyphra/schema@0.23.0

## 0.22.0

### Patch Changes

- Updated dependencies [6f0644f]
  - @cyphra/runtime@0.22.0
  - @cyphra/query@0.22.0
  - @cyphra/schema@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies [5b60cb4]
- Updated dependencies [66bc969]
  - @cyphra/runtime@0.21.0
  - @cyphra/query@0.21.0
  - @cyphra/schema@0.21.0

## 0.20.1

### Patch Changes

- @cyphra/query@0.20.1
- @cyphra/runtime@0.20.1
- @cyphra/schema@0.20.1

## 0.20.0

### Patch Changes

- @cyphra/query@0.20.0
- @cyphra/runtime@0.20.0
- @cyphra/schema@0.20.0

## 0.19.0

### Patch Changes

- @cyphra/query@0.19.0
- @cyphra/runtime@0.19.0
- @cyphra/schema@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [27bfd81]
  - @cyphra/runtime@0.18.0
  - @cyphra/query@0.18.0
  - @cyphra/schema@0.18.0

## 0.17.0

### Minor Changes

- 1d0fd3c: Typed edges on relations to a union: a `relationship { … }` model may name a union in `from` / `to` (one edge model for every member, also used by the members' inverse fields). `$edge` goes next to the member key in `connect`, `create` and `set` items (`connect: { Post: { id }, $edge: { rank: 2 } }`), every loaded member comes back with its typed `$edge`, and traversals filter on it with `edgeWhere`. The migrator emits the same relationship property constraints, indexes and backfills as for a node end (they are per relationship type).

  Interfaces as union members: `union Party = Person | Team` with `interface Person` stands for every implementation of `Person`. It is matched by the interface's label, results are the implementations (typed by `__typename`), and writes and `$on` may name the interface (`connect: { Person: { email } }`, `where: { $on: { Person: { … } } }`, `select: { $on: { Person: { … } } }`); a nested `create` names an implementation. A node listed twice (directly and through an interface) is a validation error. The type map gets `members` for unions with an interface member, and the language server completes interface names in a union.

### Patch Changes

- 2a57ffd: On Memgraph, `cyphra push`, migrations and `cyphra migrate reset` wait for running transactions instead of failing with "Cannot get unique access to the storage": index and constraint DDL is run again with backoff (up to a minute) while Memgraph cannot get storage access for it. `withMemgraphStorageAccess` and `isMemgraphStorageAccessError` are exported from `@cyphra/migrator`.
- Updated dependencies [1d0fd3c]
  - @cyphra/schema@0.17.0
  - @cyphra/runtime@0.17.0
  - @cyphra/query@0.17.0

## 0.16.0

### Minor Changes

- 40ae155: Dynamic labels: declare the labels a model may carry with `@@labels([Archived, Featured])`, then add and remove them at runtime (`data: { $labels: ["Archived"] }` on create, `{ add, remove }` or `{ set }` on update / updateMany / upsert), filter on them (`where: { $labels: { has, hasSome, hasEvery, hasNone, isEmpty } }`) and read them (`select: { $labels: true }`). Labels are checked against the schema's list and written as the schema spells them (never taken from a value), on Neo4j, Memgraph and FalkorDB. Migrations note new dynamic labels and offer a commented-out step removing a dropped one; no DDL is created for them.

  `cyphra pull` reads nodes carrying several unrelated shared labels as `node X implements A, B`, recognizes labels found on some nodes of a model only as `@@labels([…])`, and takes `--interface <labels…>` for layouts that are otherwise ambiguous, such as a shared label with a single implementation.

- 6c0a27b: Unions of unrelated models: `union SearchHit = Post | User | Comment` declares a type (no label, nothing to migrate) that relation fields can target (`items SearchHit[] @relationship(…)`). `db.searchHit` reads every member with `findMany`, `findFirst` and `count`, results discriminated by `__typename`; `where` takes `__typename` and `$on: { Post: { … }, User: {} }` (each listed member with its own filter), `select` / `include` take `$on`, `orderBy` takes `__typename`. Writes through a relation to a union name the member (`connect: { Post: { id } }`, `create: { User: { … } }`, `disconnect`, `set`), and `onDelete` rules apply to each member with its own rules. Unions are matched by label predicates, so they run the same on Neo4j, Memgraph and FalkorDB, and traversals can end on one.

  `where: { $on }` also works on interfaces (per-implementation filters). The generated client exports each union as the discriminated union of its members' types, the zod generator emits a `z.discriminatedUnion` read schema (no create or update schema), migrations generate no step for unions, `cyphra studio` lists them in their own section (read-only), and the language server and VS Code grammar know the `union` keyword.

### Patch Changes

- Updated dependencies [40ae155]
- Updated dependencies [af005ce]
- Updated dependencies [6c0a27b]
  - @cyphra/schema@0.16.0
  - @cyphra/runtime@0.16.0
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

### Patch Changes

- Updated dependencies [86ed59e]
- Updated dependencies [ca885f5]
  - @cyphra/runtime@0.15.0
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
- Updated dependencies [98b668d]
  - @cyphra/schema@0.14.0
  - @cyphra/runtime@0.14.0
  - @cyphra/query@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [e586ac4]
- Updated dependencies [ec7fd51]
- Updated dependencies [ec7fd51]
  - @cyphra/runtime@0.13.0
  - @cyphra/schema@0.13.0
  - @cyphra/query@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [8c173d3]
- Updated dependencies [a577140]
- Updated dependencies [24588fa]
- Updated dependencies [a577140]
  - @cyphra/runtime@0.12.0
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
  - @cyphra/runtime@0.11.0
  - @cyphra/query@0.11.0

## 0.10.0

### Minor Changes

- 914535d: Schema drift detection: `cyphra migrate status` now compares the database's constraints and indexes with the ones the applied migrations created.

  - **Migrator**: `detectDrift`, `replayMigrations` (runs each applied migration's `up()` against a recording `db` handle that never touches the database and keeps its `CREATE` / `DROP` constraint and index statements), `parseDdlStatement`, `expectedSchemaFromStatements`, `expectedSchemaFromModel`, `readSchemaObjects` (`SHOW CONSTRAINTS` / `SHOW INDEXES`, read-only), `schemaObjectsFromShow`, `compareSchemaObjects` and `describeSchemaObject`. Reports objects that are **extra** (in the database only), **missing** (created by migrations, absent) or **changed** (labels, properties, index or constraint type, vector dimensions / similarity / quantization, full-text analyzer / consistency, or name). `LOOKUP` indexes, constraint-backing indexes and Cyphra's bookkeeping constraint are ignored.
  - **CLI**: `cyphra migrate status` lists migrations (`applied`, `pending`, `modified` by checksum, `missing`), uncaptured schema changes and drift. `--json` prints one JSON document; `--schema` compares with `schema.cyphra` instead of the migrations. Exit codes: `0` in sync, `1` drift or anything pending, `2` when the check could not run. `cyphra migrate dev` warns about drift before generating a migration and suggests `cyphra migrate reset` in development.

- 603c4f1: `onDelete` rules on relations: `@relationship(type: "HAS_SESSION", direction: OUT, onDelete: Cascade | Restrict | SetNull)`.

  - **Schema**: the rule sits on the field of the model whose deletion triggers it (`User.sessions` with `onDelete: Cascade`: deleting a User deletes its sessions). Allowed on to-one and to-many fields, either direction; each side has its own rule. Resolved into `ResolvedRelationField.onDelete` (absent = `SetNull`, the current behaviour). Unknown `@relationship` arguments, bad rule values, duplicated arguments and two fields on the same edges with different rules are validation errors.
  - **Client**: `delete` and `deleteMany` apply the rules in the same transaction: `Cascade` deletes linked nodes recursively (following their own rules, cycle-safe), `Restrict` throws the new `RestrictError` (`model`, `relation`, `target`, `count`) before anything is deleted, `SetNull` removes the edges. Nodes are write-locked before their edges are read, so concurrent links are not missed. Models without rules keep their single `DETACH DELETE` statement.
  - **Migrations**: rule changes need no DDL; `cyphra migrate dev` / `migrate diff` list them as notes (`MigrationPlan.notes`).
  - **Editor**: completion of `onDelete` and its values, hover documentation, precise diagnostics.
  - **Better Auth**: `references.onDelete` is generated into the schema (`cascade` → `Cascade`, `restrict` / `no action` → `Restrict`, `set null` / `set default` → default) and applied by the runtime; the adapter's own cascade code is gone. Re-run `npx @better-auth/cli generate` to add the rules to your `schema.cyphra`.

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
  - @cyphra/runtime@0.10.0
  - @cyphra/query@0.10.0

## 0.9.0

### Minor Changes

- 05ecf49: Composite uniqueness constraints and indexes: `@@unique([a, b], name?)` and `@@index([a, b], name?)` model attributes.

  - **Schema**: validated (at least two existing scalar, single-value fields, no duplicates, names unique across all indexes and constraints) and resolved into `compoundUniques` / `compoundIndexes` on `ResolvedNodeModel`. Printed and formatted like other model attributes.
  - **Migrations, `cyphra push`, `cyphra schema ddl`**: `CREATE CONSTRAINT … REQUIRE (n.a, n.b) IS UNIQUE` (works on Neo4j Community; node keys are Enterprise-only and not used) and `CREATE RANGE INDEX … ON (n.a, n.b)`; a change of fields or name drops and recreates them. `cyphra pull` maps composite uniqueness constraints, node keys and composite range indexes back to `@@unique` / `@@index`.
  - **Client**: a `@@unique` is a unique key in `findUnique`, `findUniqueOrThrow`, `update`, `delete`, `upsert` (one `MERGE` on all of its fields) and `connect` / `disconnect` / `set`, in the Prisma shape `where: { a_b: { a, b } }` (or the attribute's `name`), fully typed.
  - **Editor**: completion of fields inside `@@unique([…])` / `@@index([…])`, hover documentation and precise diagnostics.

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
- Updated dependencies [00e016f]
- Updated dependencies [42d02bd]
- Updated dependencies [b204047]
  - @cyphra/schema@0.9.0
  - @cyphra/runtime@0.9.0
  - @cyphra/query@0.9.0

## 0.8.0

### Minor Changes

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

- Updated dependencies [f51239c]
- Updated dependencies [e22de55]
  - @cyphra/runtime@0.8.0
  - @cyphra/schema@0.8.0
  - @cyphra/query@0.8.0

## 0.7.0

### Minor Changes

- 1e3c799: Add model-level attributes and full-text indexes to `schema.cyphra`.

  - Models accept `@@name([fields], key: value, …)` attributes, parsed into `NodeDeclaration.attributes` / `RelationshipDeclaration.attributes` (absent when a model has none) and printed back after the fields by `printSchemaDocument` (`formatModelAttribute` is exported). `@@fulltext` is the first one.
  - `@@fulltext([title, body], name: "postSearch", analyzer: "english", eventuallyConsistent: false)` declares a full-text index on `String` / `String[]` fields of a node model. `name` defaults to `<Label>_<fields>_fulltext`; `analyzer` must be one of Neo4j 5's built-in analyzers (exported as `FULLTEXT_ANALYZERS`; default `standard-no-stop-words`). Index names must be unique across full-text indexes, vector indexes and the constraints and range indexes the schema implies. Resolved indexes are in `ResolvedNodeModel.fulltextIndexes`, and the generated type map lists their names (`fulltextIndexes`).
  - Migrations, `cyphra push` and `cyphra schema ddl` create the index with `CREATE FULLTEXT INDEX … IF NOT EXISTS FOR (n:Label) ON EACH [...] OPTIONS { indexConfig }`; the diff drops and recreates it when its fields, analyzer, consistency or name change. The new `fulltextIndexStatementsFromSchema` and `fulltextIndexStatement` are exported.
  - `cyphra pull` reads single-label node full-text indexes back into `@@fulltext` attributes.

- fc22aac: Add a `Vector(N)` type and vector indexes to `schema.cyphra`.

  - `embedding Vector(1536)? @vectorIndex(similarity: cosine)` declares an embedding of `N` floats (1 to 4096), stored as `LIST<FLOAT>` and typed `number[]` in the generated client. `@vectorIndex` takes an optional `similarity` (`cosine`, the default, or `euclidean`), `name` (default `<Label>_<field>_vector`) and `quantization` (`vector.quantization.enabled`, Neo4j 5.23+). Vector fields are validated at parse time (dimensions, no other decorator, node models only) and printed back by `printSchemaDocument`.
  - Migrations, `cyphra push` and `cyphra schema ddl` create the index with `CREATE VECTOR INDEX … IF NOT EXISTS … OPTIONS { indexConfig: { vector.dimensions, vector.similarity_function } }` (Neo4j 5.15+). The diff drops and recreates the index when its dimensions, similarity, quantization or name change, and warns that embeddings of the old length must be re-embedded after a dimension change. The new `vectorIndexStatementsFromSchema` and `vectorIndexStatement` are exported.
  - `cyphra pull` reads node vector indexes (`SHOW INDEXES … options`) back into `Vector(N) @vectorIndex(…)` fields.

### Patch Changes

- Updated dependencies [fc22aac]
- Updated dependencies [1e3c799]
- Updated dependencies [1e3c799]
- Updated dependencies [fc22aac]
  - @cyphra/runtime@0.7.0
  - @cyphra/schema@0.7.0
  - @cyphra/query@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [4832219]
- Updated dependencies [3f2c13d]
- Updated dependencies [879de50]
  - @cyphra/runtime@0.6.0
  - @cyphra/query@0.6.0
  - @cyphra/schema@0.6.0

## 0.5.0

### Minor Changes

- a8be483: Support `neo4j-driver` 6 alongside 5.28 (`^5.28.3 || ^6.0.0`).

  - `@cyphra/runtime`, `@cyphra/migrator` and `@cyphra/better-auth` now declare `neo4j-driver` as a peer dependency, so your app and Cyphra share a single driver. `cyphra` and `@cyphra/cli` depend on it directly with the same range, so `npm i cyphra` still works on its own. If you install the `@cyphra/*` subpackages with a package manager that does not install peer dependencies (Yarn), add `neo4j-driver` yourself.
  - `new CyphraClient({ driver })` and `createClient({ driver })` reuse a `Driver` your app already created (5.28+ or 6.x, even from another copy of the package). Cyphra does not close a driver you pass in.

### Patch Changes

- Updated dependencies [a8be483]
- Updated dependencies [e5851e2]
  - @cyphra/runtime@0.5.0
  - @cyphra/query@0.5.0
  - @cyphra/schema@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [e1ad59f]
  - @cyphra/runtime@0.4.0
  - @cyphra/schema@0.4.0
  - @cyphra/query@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [232fbcc]
  - @cyphra/runtime@0.3.0
  - @cyphra/query@0.3.0
  - @cyphra/schema@0.3.0

## 0.2.2

### Patch Changes

- e7419f9: Package metadata: npm pages now link to www.cyphra.dev (instead of the old cyphra-doc.vercel.app) and describe Cyphra as the TypeScript ORM for Neo4j, with matching keywords.
- Updated dependencies [e7419f9]
  - @cyphra/runtime@0.2.2
  - @cyphra/schema@0.2.2
  - @cyphra/query@0.2.2

## 0.2.1

### Patch Changes

- @cyphra/query@0.2.1
- @cyphra/runtime@0.2.1
- @cyphra/schema@0.2.1

## 0.2.0

### Minor Changes

- e82176d: Migrations generated from schema changes, database introspection, and a local dev database.

  - `cyphra migrate dev` diffs the schema against `migrations/schema.snapshot.json` and writes a reviewable migration: constraint and index changes (named like `cyphra push`), backfills for new defaults, guards for newly required fields, and commented-out destructive steps for removed fields and models. Also `--create-only`, `cyphra migrate diff` and `cyphra migrate status` (pending, modified-after-apply, missing files, uncaptured schema changes; non-zero exit).
  - `cyphra pull` introspects a live database (labels, property types, constraints, indexes, sampled relationship endpoints) and writes a `.cyphra` schema.
  - `cyphra dev` runs a local Neo4j 5 in Docker (localhost only, persistent volume) and writes `.env`; the CLI now loads `.env`.
  - Migrator API: `diffSchemaModels`, `renderMigrationSource`, `introspectDatabase`, `schemaFromIntrospection`, `listAppliedMigrations`, and `db.execute(text, params)` in migrations.
  - `cyphra init` no longer overwrites existing files; generated migrations import from `runtimeImport` (default `cyphra`); `cyphra --version` reports the real version.

### Patch Changes

- Updated dependencies [d836db9]
  - @cyphra/schema@0.2.0
  - @cyphra/runtime@0.2.0
  - @cyphra/query@0.2.0
