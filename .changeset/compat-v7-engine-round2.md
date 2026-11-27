---
"@cyphra/graphql": minor
---

`compat.v7` runs more requests on the shared engine, with the same results: types with `@authentication` (checked where v7 checks it), writes whose `@authorization` `validate` rules fail for the request (run in a transaction that raises `Forbidden` once a node is written, and is rolled back), `@timestamp` fields (the database clock in the statement), `@limit` types in mutations, DateTime values (their offset and sub-millisecond precision kept), connection edge filters and edge sorts, and to-one connections. With `client`, the client's `query` events and spans now name the engine operation for these requests too.
