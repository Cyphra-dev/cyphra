---
"@cyphra/graphql": minor
"@cyphra/runtime": patch
---

Native GraphQL API: subscriptions on Neo4j Change Data Capture (experimental, #250).
`operations: { subscribe: true }` adds `<model>Changed(where, operations)` (`CREATED`, `UPDATED`,
`DELETED`, with `id`, `node` and `changedFields`) and, per readable relation,
`<model><Relation>Connected` / `…Disconnected` (`id`, `relatedId`, `node`, `related`, `_edge`).
They run on `native.CDCReader` (`makeSchema({ subscriptions })`), one Change Data Capture poller
per server. Every batch of changes is re-read for each subscription with its `where`, its
selection and the API's rules, so a subscriber only receives nodes it may read now, on node
changes and relationship events alike; `DELETED` carries only the key. `@cyphra/runtime` exports
`decodeScalar` (internal) for it.
