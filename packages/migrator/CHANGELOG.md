# @cyphra/migrator

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
