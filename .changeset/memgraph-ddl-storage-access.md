---
"@cyphra/migrator": patch
"@cyphra/cli": patch
---

On Memgraph, `cyphra push`, migrations and `cyphra migrate reset` wait for running transactions instead of failing with "Cannot get unique access to the storage": index and constraint DDL is run again with backoff (up to a minute) while Memgraph cannot get storage access for it. `withMemgraphStorageAccess` and `isMemgraphStorageAccessError` are exported from `@cyphra/migrator`.
