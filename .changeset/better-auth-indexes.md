---
"@cyphra/better-auth": minor
---

Better Auth's table-level `indexes` (declared by plugins) are now created: a compound index becomes `@@unique([…])` / `@@index([…])` on the node, a one-field index `@unique` / `@index` on the field, in both the `createSchema` output and the runtime schema. An index over a foreign key (an edge in Cyphra) is left out. Merging into an existing `schema.cyphra` keeps your own `@@` attributes.
