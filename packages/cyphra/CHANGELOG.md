# cyphra

## 0.12.0

### Patch Changes

- Updated dependencies [8c173d3]
- Updated dependencies [a577140]
- Updated dependencies [24588fa]
- Updated dependencies [a577140]
  - @cyphra/runtime@0.12.0
  - @cyphra/schema@0.12.0
  - @cyphra/migrator@0.12.0
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
  - @cyphra/migrator@0.11.0
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

- Updated dependencies [914535d]
- Updated dependencies [603c4f1]
- Updated dependencies [ff359dc]
- Updated dependencies [13de328]
  - @cyphra/migrator@0.10.0
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
  - @cyphra/migrator@0.9.0
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
  - @cyphra/migrator@0.8.0
  - @cyphra/query@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [fc22aac]
- Updated dependencies [1e3c799]
- Updated dependencies [1e3c799]
- Updated dependencies [fc22aac]
  - @cyphra/runtime@0.7.0
  - @cyphra/schema@0.7.0
  - @cyphra/migrator@0.7.0
  - @cyphra/query@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [4832219]
- Updated dependencies [3f2c13d]
- Updated dependencies [879de50]
  - @cyphra/runtime@0.6.0
  - @cyphra/migrator@0.6.0
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
  - @cyphra/migrator@0.5.0
  - @cyphra/query@0.5.0
  - @cyphra/schema@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [e1ad59f]
  - @cyphra/runtime@0.4.0
  - @cyphra/schema@0.4.0
  - @cyphra/migrator@0.4.0
  - @cyphra/query@0.4.0

## 0.3.0

### Minor Changes

- 232fbcc: ORM write correctness fixes and string range filters:

  - `upsert` now compiles to a single atomic `MERGE` on the unique key from `where` (`ON CREATE SET` the create data and schema defaults, `ON MATCH SET` the update), then runs nested relation writes of the branch it took in the same transaction. Concurrent upserts of one new key no longer fail with `ConstraintValidationFailed`; with the uniqueness constraint that `@id` / `@unique` generate (`cyphra push` or a migration) they yield exactly one node. The key never gets a generated default, `create` may not set the key to a different value than `where`, and extra `where` conditions are checked on an existing node before it is updated (a mismatch throws `CyphraError` and writes nothing).
  - `connect` (in `create`, `update`, `set` and `upsert`) now `MERGE`s the relationship instead of `CREATE`, so connecting an already linked pair keeps one edge. On typed edges, `$edge` plus defaults apply when the edge is created; an existing edge gets only the `$edge` properties passed. A to-one `connect` (e.g. `post.update({ author: { connect } })`) now deletes the previous edge in the same statement as the `MERGE`, with the node locked, so concurrent author changes leave one edge. Likewise, when the target's side of the relation is declared to-one (e.g. `user.posts` → `connect` on a post, with `Post.author User?`), the target's previous edge of that type is deleted in the same statement (the target is locked first, so concurrent connects leave one edge); many-to-many relations are unaffected. Edges duplicated by earlier versions are left in place.
  - `DateTime` values (writes, `@default(now())` and filter parameters) are always stored at UTC offset `Z` instead of the process's local offset, so `equals` / `in` match the same instant regardless of the server's `TZ`. Values written by earlier versions with a non-zero offset still read back correctly, but exact-instant comparisons against them do not match; see the docs for a one-off Cypher to normalize them.
  - Typed filters: `lt` / `lte` / `gt` / `gte` on `String` fields (lexicographic), e.g. for keyset pagination on an `id` tie-breaker.

### Patch Changes

- Updated dependencies [232fbcc]
  - @cyphra/runtime@0.3.0
  - @cyphra/migrator@0.3.0
  - @cyphra/query@0.3.0
  - @cyphra/schema@0.3.0

## 0.2.2

### Patch Changes

- e7419f9: Package metadata: npm pages now link to www.cyphra.dev (instead of the old cyphra-doc.vercel.app) and describe Cyphra as the TypeScript ORM for Neo4j, with matching keywords.
- Updated dependencies [e7419f9]
  - @cyphra/runtime@0.2.2
  - @cyphra/schema@0.2.2
  - @cyphra/migrator@0.2.2
  - @cyphra/query@0.2.2

## 0.2.1

### Patch Changes

- @cyphra/migrator@0.2.1
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

- d836db9: Typed ORM client generated from `.cyphra` schemas.

  - `cyphra generate` now emits model types, a `CyphraTypeMap` and a typed `createClient()` alongside the existing label / relationship constants (`runtimeImport` in `cyphra.json` picks the import, default `"cyphra"`).
  - New ORM runtime: `findMany`, `findFirst`, `findUnique(OrThrow)`, `count`, `create` (nested `create` / `connect`), `createMany`, `update` (number ops, `connect` / `disconnect` / `set`), `updateMany`, `upsert`, `delete`, `deleteMany`, `$transaction`, and `$cypher` for raw queries. `select` / `include` with nested relation `where` / `orderBy` / `skip` / `take`, typed edge properties under `$edge`, and relation filters (`some` / `none` / `every`, `is` / `isNot`). Requires Neo4j 5.6+.
  - Correct value mapping: `Int` is sent as a Neo4j integer (not a float), integers read back as `number` (throwing outside the safe range), `DateTime` / `Date` as JS `Date`.
  - Schema: scalar lists (`String[]`), `Date` type, literal defaults (`@default("x")`, `@default(0)`, `@default(true)`), and `resolveSchema()` producing a JSON `SchemaModel` with cross-reference checks (also run by `cyphra validate`).
  - CLI: fix a duplicated shebang in the built binary.

### Patch Changes

- Updated dependencies [e82176d]
- Updated dependencies [d836db9]
  - @cyphra/migrator@0.2.0
  - @cyphra/schema@0.2.0
  - @cyphra/runtime@0.2.0
  - @cyphra/query@0.2.0
