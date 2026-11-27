---
"@cyphra/graphql": minor
"@cyphra/cli": minor
---

Migration tooling from `compat.v7` to the native API (#249). `cyphra graphql migrate-operations`
rewrites v7 operations (`.graphql` files, `gql` / `graphql` templates in TS and JS) into native
ones and reports what it cannot translate, with file, line and column (`--dry-run`, `--check`,
`--json`); a document with a construct that has no native equivalent is left as it is, with a
`# cyphra: not translated: …` comment. `cyphra graphql compare` runs each v7 operation on
`compat.v7` and its translation on the native API (in-process, or against two endpoints), maps the
v7 result to the native shape and reports the differences, known ones (cursors, `connect` as a
MERGE) apart; `--reset` (reset and seed before each run) has the safety check of `cyphra migrate
reset`: a non-local URI is refused unless `--force`, and it asks first unless `--yes`. `cyphra graphql migrate-rules` drafts native `rules` and `authenticated` from
`@authorization` / `@authentication` as TypeScript to review, with a `TODO(cyphra)` comment for
what the native API cannot express. The same functions are exported as `migrate.translateDocument`,
`migrate.compareResults` and `migrate.draftRules` (experimental). The native API docs list every
v7 construct and its native equivalent.
