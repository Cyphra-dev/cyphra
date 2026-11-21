---
"@cyphra/schema": minor
"@cyphra/cli": minor
---

Editor tooling support in `@cyphra/schema`: `parseSchemaSyntax(source, { locations: true })` (and `parseSchema(source, { locations: true })`) records source ranges on the AST (`loc`, `nameLoc`, `typeLoc`, …) and the document's `//` comments; without the option the AST is unchanged. `formatSchema(source)` reformats a schema and keeps its comments (aligned field columns, one blank line between declarations); it checks that the result parses to the same schema before returning it. `SCALAR_TYPE_NAMES` lists the built-in scalar types. `printSchemaDocument` now writes string literals the grammar can read back (a tab or control character was escaped as `\t`, which does not parse) and no longer leaves a trailing space after a relation field without decorators. New `cyphra format` command (`--check` for CI) formats `schema.cyphra` in place.
