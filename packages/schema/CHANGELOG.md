# @cyphra/schema

## 0.29.0

## 0.28.0

## 0.27.0

## 0.26.0

## 0.25.0

## 0.24.0

## 0.23.0

## 0.22.0

## 0.21.0

## 0.20.1

## 0.20.0

## 0.19.0

## 0.18.0

## 0.17.0

### Minor Changes

- 1d0fd3c: Typed edges on relations to a union: a `relationship { … }` model may name a union in `from` / `to` (one edge model for every member, also used by the members' inverse fields). `$edge` goes next to the member key in `connect`, `create` and `set` items (`connect: { Post: { id }, $edge: { rank: 2 } }`), every loaded member comes back with its typed `$edge`, and traversals filter on it with `edgeWhere`. The migrator emits the same relationship property constraints, indexes and backfills as for a node end (they are per relationship type).

  Interfaces as union members: `union Party = Person | Team` with `interface Person` stands for every implementation of `Person`. It is matched by the interface's label, results are the implementations (typed by `__typename`), and writes and `$on` may name the interface (`connect: { Person: { email } }`, `where: { $on: { Person: { … } } }`, `select: { $on: { Person: { … } } }`); a nested `create` names an implementation. A node listed twice (directly and through an interface) is a validation error. The type map gets `members` for unions with an interface member, and the language server completes interface names in a union.

## 0.16.0

### Minor Changes

- 40ae155: Dynamic labels: declare the labels a model may carry with `@@labels([Archived, Featured])`, then add and remove them at runtime (`data: { $labels: ["Archived"] }` on create, `{ add, remove }` or `{ set }` on update / updateMany / upsert), filter on them (`where: { $labels: { has, hasSome, hasEvery, hasNone, isEmpty } }`) and read them (`select: { $labels: true }`). Labels are checked against the schema's list and written as the schema spells them (never taken from a value), on Neo4j, Memgraph and FalkorDB. Migrations note new dynamic labels and offer a commented-out step removing a dropped one; no DDL is created for them.

  `cyphra pull` reads nodes carrying several unrelated shared labels as `node X implements A, B`, recognizes labels found on some nodes of a model only as `@@labels([…])`, and takes `--interface <labels…>` for layouts that are otherwise ambiguous, such as a shared label with a single implementation.

- 6c0a27b: Unions of unrelated models: `union SearchHit = Post | User | Comment` declares a type (no label, nothing to migrate) that relation fields can target (`items SearchHit[] @relationship(…)`). `db.searchHit` reads every member with `findMany`, `findFirst` and `count`, results discriminated by `__typename`; `where` takes `__typename` and `$on: { Post: { … }, User: {} }` (each listed member with its own filter), `select` / `include` take `$on`, `orderBy` takes `__typename`. Writes through a relation to a union name the member (`connect: { Post: { id } }`, `create: { User: { … } }`, `disconnect`, `set`), and `onDelete` rules apply to each member with its own rules. Unions are matched by label predicates, so they run the same on Neo4j, Memgraph and FalkorDB, and traversals can end on one.

  `where: { $on }` also works on interfaces (per-implementation filters). The generated client exports each union as the discriminated union of its members' types, the zod generator emits a `z.discriminatedUnion` read schema (no create or update schema), migrations generate no step for unions, `cyphra studio` lists them in their own section (read-only), and the language server and VS Code grammar know the `union` keyword.

## 0.15.0

## 0.14.0

### Minor Changes

- d18afd9: Interfaces follow-ups (#167):

  - **Interfaces extending interfaces**: `interface Staff extends Person, Contact { … }`. Fields are inherited transitively (once through a diamond), implementations carry every label up the chain (`:Engineer:Staff:Person:Contact`), each interface's delegate returns the implementations below it, and constraints and indexes stay on the declaring label. The resolved model gives interfaces `extends` and transitive `interfaces`, and nodes transitive `interfaces` / `labels`. Migrations backfill (or remove) every gained (or lost) label, `cyphra pull` recognizes chains of labels as `interface … extends …`, and the language server knows `extends` (completion, hover, go-to-definition, diagnostics).
  - **`where: { __typename }`** on interface queries (an implementation name or `{ equals, not, in, notIn }`, typed with the implementation names, compiled to label predicates) and **`orderBy: { __typename }`**.
  - **`$on`** in `select` / `include` of an interface query loads an implementation's own fields and relations on its results only: `include: { $on: { Employee: { team: true } } }`; result types narrow per `__typename`, and computed fields apply inside it.

## 0.13.0

### Minor Changes

- ec7fd51: `cyphra import neogma <files|dir>` converts neogma models to `schema.cyphra`: neogma 2 decorator classes (`@Node`, `@PrimaryKey`, `@Property`, `@Relationship`, from `neogma` or `neogma/legacy`) and `ModelFactory` models (neogma 1, revalidator or TypeBox schemas). The files are read with the TypeScript compiler, never run. Labels become nodes (extra labels become interfaces), TypeBox and revalidator types become Cyphra types, validation keywords become rules (`minLength` / `maxLength` to `@length`, `minimum` / `maximum` to `@min` / `@max`, `format: 'email' | 'url' | 'uri'` to `@email` / `@url`, `pattern` to `@regex`, `minItems` / `maxItems` to `@size`), string literal unions become enums, the primary key becomes `@id`, relationship aliases become relation fields and relationship properties become `relationship` models. Hooks, statics, instance methods and custom validators are reported, with `--out`, `--merge`, `--force` and `--print` as for the other importers. `@cyphra/schema` exports `convertNeogmaModels` (pass it the TypeScript compiler API), `printNeogmaImport`, `mergeNeogmaImport` and `formatNeogmaImportReport`.

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

- bdaa06e: The zod generator gives interfaces no `CreateInputSchema`, since only their implementations can be created.

## 0.10.0

### Minor Changes

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
