---
"@cyphra/cli": minor
"@cyphra/schema": minor
"@cyphra/graphql": minor
---

`cyphra import prisma <schema.prisma>` converts a Prisma schema to `schema.cyphra`: models become
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
