---
"@cyphra/graphql": minor
"@cyphra/cli": minor
---

`compat.v7.makeSchema` now reports every unsupported construct and invalid usage of the type definitions at once: `UnsupportedTypeDefsError` lists them all and keeps them in `issues` (`code`: `UNSUPPORTED` or `INVALID`, `message`, `location`: type, field, line and column). With a single issue the message is unchanged. `UnsupportedTypeDefsError` now extends `CyphraError`. New `compat.v7.checkTypeDefs(typeDefs, opts)` returns the issues without building the schema (several files can be checked together), and the new `cyphra graphql check <files...>` command prints them (`--json`; exit code 1 when there are issues).
