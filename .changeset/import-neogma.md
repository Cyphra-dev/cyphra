---
"@cyphra/schema": minor
"@cyphra/cli": minor
---

`cyphra import neogma <files|dir>` converts neogma models to `schema.cyphra`: neogma 2 decorator classes (`@Node`, `@PrimaryKey`, `@Property`, `@Relationship`, from `neogma` or `neogma/legacy`) and `ModelFactory` models (neogma 1, revalidator or TypeBox schemas). The files are read with the TypeScript compiler, never run. Labels become nodes (extra labels become interfaces), TypeBox and revalidator types become Cyphra types, validation keywords become rules (`minLength` / `maxLength` to `@length`, `minimum` / `maximum` to `@min` / `@max`, `format: 'email' | 'url' | 'uri'` to `@email` / `@url`, `pattern` to `@regex`, `minItems` / `maxItems` to `@size`), string literal unions become enums, the primary key becomes `@id`, relationship aliases become relation fields and relationship properties become `relationship` models. Hooks, statics, instance methods and custom validators are reported, with `--out`, `--merge`, `--force` and `--print` as for the other importers. `@cyphra/schema` exports `convertNeogmaModels` (pass it the TypeScript compiler API), `printNeogmaImport`, `mergeNeogmaImport` and `formatNeogmaImportReport`.
