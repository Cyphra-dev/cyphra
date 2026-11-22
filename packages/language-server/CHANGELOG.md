# @cyphra/language-server

## 0.17.0

### Minor Changes

- 1d0fd3c: Typed edges on relations to a union: a `relationship { … }` model may name a union in `from` / `to` (one edge model for every member, also used by the members' inverse fields). `$edge` goes next to the member key in `connect`, `create` and `set` items (`connect: { Post: { id }, $edge: { rank: 2 } }`), every loaded member comes back with its typed `$edge`, and traversals filter on it with `edgeWhere`. The migrator emits the same relationship property constraints, indexes and backfills as for a node end (they are per relationship type).

  Interfaces as union members: `union Party = Person | Team` with `interface Person` stands for every implementation of `Person`. It is matched by the interface's label, results are the implementations (typed by `__typename`), and writes and `$on` may name the interface (`connect: { Person: { email } }`, `where: { $on: { Person: { … } } }`, `select: { $on: { Person: { … } } }`); a nested `create` names an implementation. A node listed twice (directly and through an interface) is a validation error. The type map gets `members` for unions with an interface member, and the language server completes interface names in a union.

### Patch Changes

- Updated dependencies [1d0fd3c]
  - @cyphra/schema@0.17.0

## 0.16.0

### Minor Changes

- 40ae155: Dynamic labels: declare the labels a model may carry with `@@labels([Archived, Featured])`, then add and remove them at runtime (`data: { $labels: ["Archived"] }` on create, `{ add, remove }` or `{ set }` on update / updateMany / upsert), filter on them (`where: { $labels: { has, hasSome, hasEvery, hasNone, isEmpty } }`) and read them (`select: { $labels: true }`). Labels are checked against the schema's list and written as the schema spells them (never taken from a value), on Neo4j, Memgraph and FalkorDB. Migrations note new dynamic labels and offer a commented-out step removing a dropped one; no DDL is created for them.

  `cyphra pull` reads nodes carrying several unrelated shared labels as `node X implements A, B`, recognizes labels found on some nodes of a model only as `@@labels([…])`, and takes `--interface <labels…>` for layouts that are otherwise ambiguous, such as a shared label with a single implementation.

- 6c0a27b: Unions of unrelated models: `union SearchHit = Post | User | Comment` declares a type (no label, nothing to migrate) that relation fields can target (`items SearchHit[] @relationship(…)`). `db.searchHit` reads every member with `findMany`, `findFirst` and `count`, results discriminated by `__typename`; `where` takes `__typename` and `$on: { Post: { … }, User: {} }` (each listed member with its own filter), `select` / `include` take `$on`, `orderBy` takes `__typename`. Writes through a relation to a union name the member (`connect: { Post: { id } }`, `create: { User: { … } }`, `disconnect`, `set`), and `onDelete` rules apply to each member with its own rules. Unions are matched by label predicates, so they run the same on Neo4j, Memgraph and FalkorDB, and traversals can end on one.

  `where: { $on }` also works on interfaces (per-implementation filters). The generated client exports each union as the discriminated union of its members' types, the zod generator emits a `z.discriminatedUnion` read schema (no create or update schema), migrations generate no step for unions, `cyphra studio` lists them in their own section (read-only), and the language server and VS Code grammar know the `union` keyword.

### Patch Changes

- Updated dependencies [40ae155]
- Updated dependencies [6c0a27b]
  - @cyphra/schema@0.16.0

## 0.15.0

### Patch Changes

- @cyphra/schema@0.15.0

## 0.14.0

### Minor Changes

- d18afd9: Interfaces follow-ups (#167):

  - **Interfaces extending interfaces**: `interface Staff extends Person, Contact { … }`. Fields are inherited transitively (once through a diamond), implementations carry every label up the chain (`:Engineer:Staff:Person:Contact`), each interface's delegate returns the implementations below it, and constraints and indexes stay on the declaring label. The resolved model gives interfaces `extends` and transitive `interfaces`, and nodes transitive `interfaces` / `labels`. Migrations backfill (or remove) every gained (or lost) label, `cyphra pull` recognizes chains of labels as `interface … extends …`, and the language server knows `extends` (completion, hover, go-to-definition, diagnostics).
  - **`where: { __typename }`** on interface queries (an implementation name or `{ equals, not, in, notIn }`, typed with the implementation names, compiled to label predicates) and **`orderBy: { __typename }`**.
  - **`$on`** in `select` / `include` of an interface query loads an implementation's own fields and relations on its results only: `include: { $on: { Employee: { team: true } } }`; result types narrow per `__typename`, and computed fields apply inside it.

### Patch Changes

- Updated dependencies [d18afd9]
  - @cyphra/schema@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [ec7fd51]
  - @cyphra/schema@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [a577140]
- Updated dependencies [a577140]
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

- Updated dependencies [603c4f1]
- Updated dependencies [ff359dc]
- Updated dependencies [13de328]
  - @cyphra/schema@0.10.0

## 0.9.0

### Minor Changes

- 05ecf49: Composite uniqueness constraints and indexes: `@@unique([a, b], name?)` and `@@index([a, b], name?)` model attributes.

  - **Schema**: validated (at least two existing scalar, single-value fields, no duplicates, names unique across all indexes and constraints) and resolved into `compoundUniques` / `compoundIndexes` on `ResolvedNodeModel`. Printed and formatted like other model attributes.
  - **Migrations, `cyphra push`, `cyphra schema ddl`**: `CREATE CONSTRAINT … REQUIRE (n.a, n.b) IS UNIQUE` (works on Neo4j Community; node keys are Enterprise-only and not used) and `CREATE RANGE INDEX … ON (n.a, n.b)`; a change of fields or name drops and recreates them. `cyphra pull` maps composite uniqueness constraints, node keys and composite range indexes back to `@@unique` / `@@index`.
  - **Client**: a `@@unique` is a unique key in `findUnique`, `findUniqueOrThrow`, `update`, `delete`, `upsert` (one `MERGE` on all of its fields) and `connect` / `disconnect` / `set`, in the Prisma shape `where: { a_b: { a, b } }` (or the attribute's `name`), fully typed.
  - **Editor**: completion of fields inside `@@unique([…])` / `@@index([…])`, hover documentation and precise diagnostics.

- 42d02bd: New package `@cyphra/language-server`: a language server for `.cyphra` schema files, used by the Cyphra VS Code extension and usable from Neovim, Zed, Helix or any LSP client (`cyphra-language-server --stdio`). Diagnostics match `cyphra validate` and underline the field, type, decorator or argument at fault; completion of keywords, built-in types, models and enums, decorators and their arguments, `@default(…)` values and `@@fulltext([…])` fields; hover docs and relation target summaries; go to definition, find references and rename for models and enums; document outline; formatting that keeps comments.
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
