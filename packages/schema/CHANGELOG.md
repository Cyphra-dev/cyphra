# @cyphra/schema

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
