---
"@cyphra/schema": minor
"@cyphra/cli": minor
"@cyphra/language-server": minor
"@cyphra/migrator": minor
---

Relation fields can name their edges with `@out(TYPE)` / `@in(TYPE)`, the type written once as a symbol: `posts Post[] @out(AUTHORED)`, `author User? @in(AUTHORED)`, options in the same call (`@out(AUTHORED, onDelete: Cascade)`). One side is enough. A short-form block `relationship AUTHORED { at DateTime }` types the properties of every `:AUTHORED` edge (its ends come from the fields); without a block the edge has no properties. The `@relationship(type:, direction:)` syntax and the long-form `relationship X { type "T" from A to B … }` block keep working and resolve to the same model and the same generated client; mixing `@out` / `@in` / `@relationship` on one field is an error.

New checks, on both syntaxes: a pair of fields with the same type and the same direction on both sides (`b B @out(T)` on A, `a A @out(T)` on B) is an error, and so is a `relationship` block that no field uses (schemas with such a block need a field or no block now). Nearly identical relationship types (one or two edits apart, or differing only in case) are a warning, from the new `schemaWarnings()`, printed by `cyphra validate` and `cyphra generate`.
