# @cyphra/cli

## 0.13.0

### Minor Changes

- c1b2b85: `cyphra studio`: a local data browser built from `schema.cyphra`. It serves a bundled web UI on
  `127.0.0.1` (`--port`, `--host`, `--no-open`, `--read-only`) to browse node models, interfaces and
  relationship models with counts, filter, sort and page, edit records with typed inputs (writes go
  through the ORM, so validation rules and unique constraints apply), follow relations, preview
  `onDelete` effects before a delete, and run raw Cypher (read transactions unless writes are allowed).
  The API requires a per-session token (moved from the URL to an HttpOnly cookie) and a custom header,
  and refuses foreign `Host` and `Origin` headers.
- ec7fd51: `cyphra import neogma <files|dir>` converts neogma models to `schema.cyphra`: neogma 2 decorator classes (`@Node`, `@PrimaryKey`, `@Property`, `@Relationship`, from `neogma` or `neogma/legacy`) and `ModelFactory` models (neogma 1, revalidator or TypeBox schemas). The files are read with the TypeScript compiler, never run. Labels become nodes (extra labels become interfaces), TypeBox and revalidator types become Cyphra types, validation keywords become rules (`minLength` / `maxLength` to `@length`, `minimum` / `maximum` to `@min` / `@max`, `format: 'email' | 'url' | 'uri'` to `@email` / `@url`, `pattern` to `@regex`, `minItems` / `maxItems` to `@size`), string literal unions become enums, the primary key becomes `@id`, relationship aliases become relation fields and relationship properties become `relationship` models. Hooks, statics, instance methods and custom validators are reported, with `--out`, `--merge`, `--force` and `--print` as for the other importers. `@cyphra/schema` exports `convertNeogmaModels` (pass it the TypeScript compiler API), `printNeogmaImport`, `mergeNeogmaImport` and `formatNeogmaImportReport`.

### Patch Changes

- Updated dependencies [e586ac4]
- Updated dependencies [ec7fd51]
- Updated dependencies [ec7fd51]
  - @cyphra/runtime@0.13.0
  - @cyphra/schema@0.13.0
  - @cyphra/graphql@0.13.0
  - @cyphra/migrator@0.13.0

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
- a577140: Zod generator: `"generators": { "zod": { "omitGenerated": true } }` (or `cyphra generate --zod-omit-generated`) leaves the fields Cyphra generates out of `<Model>CreateInputSchema` and `<Model>UpdateInputSchema`: an `@id` with a `@default`, and `now()`, `cuid()` and `uuid()` defaults. Public APIs no longer need `.omit({ id: true, createdAt: true })`. `isGeneratedField` is exported from `@cyphra/schema`.

### Patch Changes

- Updated dependencies [8c173d3]
- Updated dependencies [a577140]
- Updated dependencies [24588fa]
- Updated dependencies [a577140]
  - @cyphra/runtime@0.12.0
  - @cyphra/schema@0.12.0
  - @cyphra/graphql@0.12.0
  - @cyphra/migrator@0.12.0

## 0.11.0

### Minor Changes

- bdaa06e: Interfaces and multiple labels: `interface Person { … }` and `node Employee implements Person { … }`.

  - **Schema**: an interface is an abstract node model whose label every implementation carries (`(:Employee:Person)`). A node inherits the fields, relations, `@@unique` keys and `@@fulltext` indexes of the interfaces it implements, first and in `implements` order. Relations and `relationship { … }` models can target an interface; an empty interface is an extra label. Implementing a non-interface, redeclaring an inherited field, two interfaces declaring the same field, two `@id`s and interfaces implementing interfaces are validation errors. Resolved models gain `abstract`, `implementations`, `interfaces`, `labels` and `inheritedFrom` (all optional: plain schemas resolve and generate as before).
  - **Client**: implementations are written and matched with all their labels. `db.person` reads (`findMany`, `count`, `aggregate`, `traverse`, `search`, …) return a union of the implementations discriminated by `__typename`, with each implementation's fields; `select` takes interface fields. Interfaces have no `create` / `createMany` / `upsert`, nested creates into interface targets are rejected, `connect`, updates and deletes work through them, and deletes apply each implementation's `onDelete` rules.
  - **Migrations**: constraints and indexes are created once, on the declaring label. A node that starts (stops) implementing an interface gets a step adding (removing) the label on its existing nodes, before the interface's constraints are created.
  - **`cyphra pull`**: a label that only ever appears paired with one other label is pulled as an interface with its implementations.
  - **Editor**: `interface` / `implements` completion, hover, outline, go-to-definition and diagnostics; syntax highlighting in VS Code.
  - **GraphQL import**: `@neo4j/graphql` interfaces (which are not labels) stay unsupported, with a message pointing to Cyphra interfaces.

- 9974b20: Zod schema generator: validate API input against the schema with [zod](https://zod.dev) (zod 4 and zod 3).

  - **CLI**: with `"generators": { "zod": { "output": "./src/cyphra.zod.ts", "coerce": false, "import": "zod" } }` in `cyphra.json` (or `"zod": true`), `cyphra generate` also writes zod schemas; `--watch` and `cyphra dev --watch` regenerate them too. `cyphra generate --zod [output]` and `--zod-coerce` turn it on for one run or override the config.
  - **Schemas**: for each node model `User`: `UserSchema` (the properties the client returns), `UserCreateInputSchema` (fields with a default, optional fields and lists may be left out) and `UserUpdateInputSchema` (every field optional); the same for each relationship model's edge properties; `RoleSchema` (`z.enum`) per enum. Relation fields are left out. What they parse type-checks as the client's `data`.
  - **Checks**: the validation rules with the runtime's semantics and messages (`@length` in code points, `@url` http(s) only, `@nonEmpty` on trimmed strings, inclusive `@min` / `@max`, `Date` bounds on the UTC day, `@regex` flags), and the types: integer `Int`, 64-bit `BigInt`, `Date`s, temporal ISO 8601 text checked as the runtime parses it, `Point` / `CartesianPoint` objects, `Vector(N)` length, JSON values. `coerce` reads ISO 8601 strings as `Date`s and decimal strings as `bigint`s.
  - **API**: `renderZodSource(doc, { coerce, zodImport })` and `renderZodFromModel(model, options)` in `@cyphra/schema`.

### Patch Changes

- Updated dependencies [bdaa06e]
- Updated dependencies [9974b20]
- Updated dependencies [bdaa06e]
  - @cyphra/schema@0.11.0
  - @cyphra/runtime@0.11.0
  - @cyphra/migrator@0.11.0
  - @cyphra/graphql@0.11.0

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

- Updated dependencies [914535d]
- Updated dependencies [603c4f1]
- Updated dependencies [ff359dc]
- Updated dependencies [13de328]
  - @cyphra/migrator@0.10.0
  - @cyphra/schema@0.10.0
  - @cyphra/runtime@0.10.0
  - @cyphra/graphql@0.10.0

## 0.9.0

### Minor Changes

- 4ea8191: New `cyphra db seed` command: runs the `"seed"` shell command from `cyphra.json` (for example `"tsx seed.ts"`) from the project root, with the CLI's environment and `node_modules/.bin` on `PATH`, and exits with its exit code. New `cyphra migrate reset`: drops every constraint and index (keeping the default LOOKUP indexes), deletes all data in batches (including migration records), reapplies every migration and runs the seed (`--skip-seed` to skip). It asks for confirmation (`--yes` / `-y` to skip, refused in a non-interactive shell without it) and refuses databases that do not look local (encrypted `+s` / `+ssc` schemes, Aura hosts, dotted host names, non-loopback IPs) unless `--force` is passed. New `cyphra generate --watch` (and `cyphra dev --watch`): regenerates the client when the schema file changes, debounced, printing schema errors without exiting; it watches the schema's directory so editors that save by renaming are picked up.
- b204047: `cyphra import graphql` (and `cyphraSchema`) map `Point`, `CartesianPoint`, `Time`, `LocalTime`,
  `LocalDateTime` and `Duration` fields to the Cyphra types of the same name instead of reporting them
  as not converted, with their string defaults, and `@timestamp` on `Time` becomes `@default(now())`.
- 42d02bd: Editor tooling support in `@cyphra/schema`: `parseSchemaSyntax(source, { locations: true })` (and `parseSchema(source, { locations: true })`) records source ranges on the AST (`loc`, `nameLoc`, `typeLoc`, …) and the document's `//` comments; without the option the AST is unchanged. `formatSchema(source)` reformats a schema and keeps its comments (aligned field columns, one blank line between declarations); it checks that the result parses to the same schema before returning it. `SCALAR_TYPE_NAMES` lists the built-in scalar types. `printSchemaDocument` now writes string literals the grammar can read back (a tab or control character was escaped as `\t`, which does not parse) and no longer leaves a trailing space after a relation field without decorators. New `cyphra format` command (`--check` for CI) formats `schema.cyphra` in place.

### Patch Changes

- Updated dependencies [05ecf49]
- Updated dependencies [b204047]
- Updated dependencies [00e016f]
- Updated dependencies [42d02bd]
- Updated dependencies [b204047]
  - @cyphra/schema@0.9.0
  - @cyphra/migrator@0.9.0
  - @cyphra/runtime@0.9.0
  - @cyphra/graphql@0.9.0

## 0.8.0

### Minor Changes

- e22de55: `cyphra import graphql` (and `cyphraSchema`) map GraphQL enums to Cyphra enums with the same values
  (only the enums a converted field uses; `@default(value: X)` becomes `@default(X)`), and `BigInt` to
  `BigInt` (defaults keep every digit), instead of `String` and "not converted".
- ba56ddc: `cyphra import graphql` (and `convertGraphQLTypeDefs`) now converts `@fulltext(indexes: [{ indexName, queryName, fields }])` to one `@@fulltext([fields], name: indexName)` per index, so `cyphra migrate` creates the full-text indexes the v7 API queries. Field names follow `@alias`; `queryName` is listed as ignored (it names a GraphQL query field, which `compat.v7` still serves); an index on a field that was not converted, or that is not a `String` / `ID` field, is reported and left out. `--merge` adds the indexes an existing node lacks. `@vector` stays reported (v7 type definitions carry neither the dimensions nor the similarity), with a hint to declare a `Vector(N)` field with `@vectorIndex`. Report messages for `@cypher` fields and authorization rules now say that `compat.v7` still serves them.

### Patch Changes

- Updated dependencies [e22de55]
- Updated dependencies [ba56ddc]
- Updated dependencies [f51239c]
- Updated dependencies [e22de55]
  - @cyphra/graphql@0.8.0
  - @cyphra/runtime@0.8.0
  - @cyphra/schema@0.8.0
  - @cyphra/migrator@0.8.0

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

- Updated dependencies [6130ac7]
- Updated dependencies [6796ef7]
- Updated dependencies [fc22aac]
- Updated dependencies [1e3c799]
- Updated dependencies [1e3c799]
- Updated dependencies [fc22aac]
  - @cyphra/graphql@0.7.0
  - @cyphra/runtime@0.7.0
  - @cyphra/schema@0.7.0
  - @cyphra/migrator@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [e02dbb3]
- Updated dependencies [4832219]
- Updated dependencies [3f2c13d]
- Updated dependencies [879de50]
  - @cyphra/graphql@0.6.0
  - @cyphra/runtime@0.6.0
  - @cyphra/migrator@0.6.0
  - @cyphra/schema@0.6.0

## 0.5.0

### Minor Changes

- e96ca16: Add `cyphra import graphql <typeDefs.graphql...>`: converts `@neo4j/graphql` v7 type definitions to `schema.cyphra` (nodes, scalars, lists, `@id`, `@timestamp`, `@default`, `@unique`, `@relationship` and `@relationshipProperties`) and prints a report of everything it could not convert. `--merge` adds to an existing schema and keeps your models, fields and comments.
- a8be483: Support `neo4j-driver` 6 alongside 5.28 (`^5.28.3 || ^6.0.0`).

  - `@cyphra/runtime`, `@cyphra/migrator` and `@cyphra/better-auth` now declare `neo4j-driver` as a peer dependency, so your app and Cyphra share a single driver. `cyphra` and `@cyphra/cli` depend on it directly with the same range, so `npm i cyphra` still works on its own. If you install the `@cyphra/*` subpackages with a package manager that does not install peer dependencies (Yarn), add `neo4j-driver` yourself.
  - `new CyphraClient({ driver })` and `createClient({ driver })` reuse a `Driver` your app already created (5.28+ or 6.x, even from another copy of the package). Cyphra does not close a driver you pass in.

### Patch Changes

- Updated dependencies [da61e20]
- Updated dependencies [04de22e]
- Updated dependencies [a8be483]
- Updated dependencies [e5851e2]
  - @cyphra/graphql@0.5.0
  - @cyphra/runtime@0.5.0
  - @cyphra/migrator@0.5.0
  - @cyphra/schema@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [e1ad59f]
  - @cyphra/runtime@0.4.0
  - @cyphra/schema@0.4.0
  - @cyphra/migrator@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [232fbcc]
  - @cyphra/runtime@0.3.0
  - @cyphra/migrator@0.3.0
  - @cyphra/schema@0.3.0

## 0.2.2

### Patch Changes

- e7419f9: Package metadata: npm pages now link to www.cyphra.dev (instead of the old cyphra-doc.vercel.app) and describe Cyphra as the TypeScript ORM for Neo4j, with matching keywords.
- Updated dependencies [e7419f9]
  - @cyphra/runtime@0.2.2
  - @cyphra/schema@0.2.2
  - @cyphra/migrator@0.2.2

## 0.2.1

### Patch Changes

- 55ffec9: Read the database user from `NEO4J_USERNAME`, the name Neo4j Aura and the Vercel integration use. `NEO4J_USER` still works. `cyphra dev` and `cyphra init` now write `NEO4J_USERNAME`.
  - @cyphra/migrator@0.2.1
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
