---
"@cyphra/graphql": patch
---

`compat.v7` honours `context.sessionConfig` per request, like `@neo4j/graphql` 7: its `database`, `impersonatedUser` and `auth` are spread over the session options of every generated statement (`sessionConfig.database` wins over the `database` passed to `makeSchema`). With a `CyphraClient`, a request that sets `sessionConfig` now fails with an error instead of silently running on the client's database. New compat fixture `session-config` (#251).
