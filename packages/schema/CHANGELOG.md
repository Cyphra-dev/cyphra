# @cyphra/schema

## 0.9.0

### Minor Changes

- 05ecf49: Composite uniqueness constraints and indexes: `@@unique([a, b], name?)` and `@@index([a, b], name?)` model attributes.

  - **Schema**: validated (at least two existing scalar, single-value fields, no duplicates, names unique across all indexes and constraints) and resolved into `compoundUniques` / `compoundIndexes` on `ResolvedNodeModel`. Printed and formatted like other model attributes.
  - **Migrations, `cyphra push`, `cyphra schema ddl`**: `CREATE CONSTRAINT … REQUIRE (n.a, n.b) IS UNIQUE` (works on Neo4j Community; node keys are Enterprise-only and not used) and `CREATE RANGE INDEX … ON (n.a, n.b)`; a change of fields or name drops and recreates them. `cyphra pull` maps composite uniqueness constraints, node keys and composite range indexes back to `@@unique` / `@@index`.
  - **Client**: a `@@unique` is a unique key in `findUnique`, `findUniqueOrThrow`, `update`, `delete`, `upsert` (one `MERGE` on all of its fields) and `connect` / `disconnect` / `set`, in the Prisma shape `where: { a_b: { a, b } }` (or the attribute's `name`), fully typed.
  - **Editor**: completion of fields inside `@@unique([…])` / `@@index([…])`, hover documentation and precise diagnostics.

- 42d02bd: Editor tooling support in `@cyphra/schema`: `parseSchemaSyntax(source, { locations: true })` (and `parseSchema(source, { locations: true })`) records source ranges on the AST (`loc`, `nameLoc`, `typeLoc`, …) and the document's `//` comments; without the option the AST is unchanged. `formatSchema(source)` reformats a schema and keeps its comments (aligned field columns, one blank line between declarations); it checks that the result parses to the same schema before returning it. `SCALAR_TYPE_NAMES` lists the built-in scalar types. `printSchemaDocument` now writes string literals the grammar can read back (a tab or control character was escaped as `\t`, which does not parse) and no longer leaves a trailing space after a relation field without decorators. New `cyphra format` command (`--check` for CI) formats `schema.cyphra` in place.
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

## 0.6.0

## 0.5.0

## 0.4.0

### Patch Changes

- e1ad59f: New package `@cyphra/better-auth`: a Better Auth database adapter built on the Cyphra ORM, so auth data (users, sessions, accounts, verifications, plugin models) and your own models live in one typed graph with one schema and one migration system. The Cyphra schema is derived from your Better Auth configuration at runtime; foreign keys are stored as `HAS_*` edges; `npx @better-auth/cli generate` merges the auth models into `schema.cyphra` and keeps your own models and fields. Passes Better Auth's adapter conformance suites (normal, case-insensitive, transactions, joins, uuid, auth flow). Includes `neo4jBetterAuthMigration()` to convert data written by `neo4j-better-auth`.

  `@cyphra/runtime`: string filters accept `mode: "insensitive"` (Prisma-compatible) for case-insensitive `equals`, `not`, `in`, `notIn`, `contains`, `startsWith` and `endsWith`.

  `@cyphra/schema`: `cyphra generate` types a node without relations as `relations: Record<never, never>` instead of `{}`, which failed `@typescript-eslint/no-empty-object-type` in projects that lint the generated client.

## 0.3.0

## 0.2.2

### Patch Changes

- e7419f9: Package metadata: npm pages now link to www.cyphra.dev (instead of the old cyphra-doc.vercel.app) and describe Cyphra as the TypeScript ORM for Neo4j, with matching keywords.

## 0.2.1

## 0.2.0

### Minor Changes

- d836db9: Typed ORM client generated from `.cyphra` schemas.

  - `cyphra generate` now emits model types, a `CyphraTypeMap` and a typed `createClient()` alongside the existing label / relationship constants (`runtimeImport` in `cyphra.json` picks the import, default `"cyphra"`).
  - New ORM runtime: `findMany`, `findFirst`, `findUnique(OrThrow)`, `count`, `create` (nested `create` / `connect`), `createMany`, `update` (number ops, `connect` / `disconnect` / `set`), `updateMany`, `upsert`, `delete`, `deleteMany`, `$transaction`, and `$cypher` for raw queries. `select` / `include` with nested relation `where` / `orderBy` / `skip` / `take`, typed edge properties under `$edge`, and relation filters (`some` / `none` / `every`, `is` / `isNot`). Requires Neo4j 5.6+.
  - Correct value mapping: `Int` is sent as a Neo4j integer (not a float), integers read back as `number` (throwing outside the safe range), `DateTime` / `Date` as JS `Date`.
  - Schema: scalar lists (`String[]`), `Date` type, literal defaults (`@default("x")`, `@default(0)`, `@default(true)`), and `resolveSchema()` producing a JSON `SchemaModel` with cross-reference checks (also run by `cyphra validate`).
  - CLI: fix a duplicated shebang in the built binary.
