---
"@cyphra/graphql": minor
"@cyphra/cli": minor
---

Native GraphQL API (experimental): opt-in Relay and the printed contract.

- `relay: true` in `defineGraphQL`: a `Node` interface implemented by every model with a `String`,
  `Int` or `BigInt` `@id` (interfaces included), global ids (`base64("<Type>:<id>")`,
  `native.toGlobalId` / `native.fromGlobalId`) and `node(id: ID!)`. The model's own `id` field is
  returned as `rawId`; inputs keep `id`. Off by default.
- `cyphra graphql print [--config <file>] [--export <name>] [--out <file>] [--check]`: the native
  API's sorted SDL from `schema.cyphra` and `graphql.config.ts`, without a database. `--check`
  exits with 1 when the committed file differs, listing breaking and dangerous changes.
