---
"@cyphra/schema": minor
"@cyphra/runtime": minor
"@cyphra/migrator": minor
"@cyphra/cli": minor
"@cyphra/language-server": minor
"@cyphra/graphql": minor
"cyphra": minor
---

Interfaces and multiple labels: `interface Person { … }` and `node Employee implements Person { … }`.

- **Schema**: an interface is an abstract node model whose label every implementation carries (`(:Employee:Person)`). A node inherits the fields, relations, `@@unique` keys and `@@fulltext` indexes of the interfaces it implements, first and in `implements` order. Relations and `relationship { … }` models can target an interface; an empty interface is an extra label. Implementing a non-interface, redeclaring an inherited field, two interfaces declaring the same field, two `@id`s and interfaces implementing interfaces are validation errors. Resolved models gain `abstract`, `implementations`, `interfaces`, `labels` and `inheritedFrom` (all optional: plain schemas resolve and generate as before).
- **Client**: implementations are written and matched with all their labels. `db.person` reads (`findMany`, `count`, `aggregate`, `traverse`, `search`, …) return a union of the implementations discriminated by `__typename`, with each implementation's fields; `select` takes interface fields. Interfaces have no `create` / `createMany` / `upsert`, nested creates into interface targets are rejected, `connect`, updates and deletes work through them, and deletes apply each implementation's `onDelete` rules.
- **Migrations**: constraints and indexes are created once, on the declaring label. A node that starts (stops) implementing an interface gets a step adding (removing) the label on its existing nodes, before the interface's constraints are created.
- **`cyphra pull`**: a label that only ever appears paired with one other label is pulled as an interface with its implementations.
- **Editor**: `interface` / `implements` completion, hover, outline, go-to-definition and diagnostics; syntax highlighting in VS Code.
- **GraphQL import**: `@neo4j/graphql` interfaces (which are not labels) stay unsupported, with a message pointing to Cyphra interfaces.
