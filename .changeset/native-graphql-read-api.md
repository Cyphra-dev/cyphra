---
"@cyphra/graphql": minor
"@cyphra/runtime": minor
---

Native GraphQL API, phase 2 (reads, experimental): `native.makeSchema({ client, config })` serves
a GraphQL API generated from `schema.cyphra` and run by the typed client, next to `compat.v7`
(`import { compat, native } from "@cyphra/graphql"`).

- `defineGraphQL` (also from `@cyphra/graphql/native`): a config typed against the generated
  client's `CyphraTypeMap` (unknown models, fields and operations fail `tsc`) and checked again at
  startup (`NativeSchemaError`). Per-model operation toggles (reads on, writes off by default),
  field toggles (`false`, `{ read, filter, sort, deprecated }`), root field names (`naming`) and
  `limits` (`maxDepth`, `maxTake`, `maxAliases`, `maxComplexity`).
- Root fields `<model>FindUnique`, `<model>FindFirst`, `<model>FindMany` (returning
  `<Model>List { nodes pageInfo totalCount }`, offset and keyset-cursor paging) and
  `<model>Count`; `<Model>Where` filters, `[<Model>OrderBy!]` ordering (one key per element),
  relations with `where` / `orderBy` / `skip` / `take` (aliases become aliased loads), `_edge` for
  edge properties (a union when several relationship models reach a node), `_count`, `_labels`,
  interfaces and unions (fragments become `$on`), and every Cyphra scalar type.
- One client operation, so one Cypher statement, per root field; a page and its `totalCount` run
  in one read transaction. Errors carry `extensions.code` (`BAD_USER_INPUT`, `NOT_FOUND`,
  `RESTRICTED`, `UNIQUE_CONSTRAINT`, `INTERNAL_SERVER_ERROR` masked unless `debug`).
- `native.printSchema(schemaModel, config)`: the sorted SDL, without a client.
- `@cyphra/runtime`: `withReadTransaction(client, fn)` (internal, experimental) runs several
  operations of a client in one read transaction.
