---
"@cyphra/schema": minor
"@cyphra/cli": minor
"@cyphra/graphql": minor
"@cyphra/migrator": minor
"@cyphra/better-auth": minor
"@cyphra/language-server": minor
---

`cyphra format --codemod` rewrites `@relationship(type: "T", direction: OUT|IN, onDelete: …)` fields into `@out(T, …)` / `@in(T, …)`, keeping comments; it is idempotent, and a type that is not an identifier keeps `@relationship`. Plain `cyphra format` keeps the syntax you wrote (so `--check` in CI and format-on-save do not change on upgrade) and prints how many fields `--codemod` would rewrite. The same is `formatSchema(source, { codemod: true })`, and the editor offers it as a quick fix ("Rewrite as @out(T)", or every field of the file).

The importers write the new syntax: `cyphra import graphql`, `cyphra pull`, `cyphra import neogma`, `cyphra import prisma` and the Better Auth schema generator emit `@out(TYPE)` / `@in(TYPE)` relation fields (`relationFieldDecorator()` in `@cyphra/schema`), `@relationship(…)` only for a type that is not an identifier. The docs, examples and README use `@out` / `@in`.
