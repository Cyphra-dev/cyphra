---
"@cyphra/graphql": minor
"@cyphra/runtime": patch
---

`compat.v7` runs root mutations on the shared engine when it writes and answers exactly like v7: `create` with attribute inputs (`createMany`, `info.nodesCreated`), `update` with `set` operators (`updateMany`), and `delete` without nested deletes (`deleteMany`, with `relationshipsDeleted`), the response selection read in the same statement. Nested writes (v7's `connect` is a `CREATE`, the engine's a `MERGE`), arithmetic and list operators, deprecated `field_SET` keys, `@timestamp` and `@limit` types, DateTime values and types with rules stay on the compat compiler. `@cyphra/runtime`: internal `deleteMany({ $relationships: true })` engine entry (the number of relationships a delete removed).
