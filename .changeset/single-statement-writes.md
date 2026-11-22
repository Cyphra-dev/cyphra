---
"@cyphra/runtime": minor
---

Fewer round trips for writes, and one request per operation over HTTP:

- `create` and `update` are one statement: the write, every nested relation write and the projection of the result (`select` / `include` / `_count`, computed-field `needs`). Nested `create`s are batched per relation (`FOREACH` over the children, in the order given); `connect`, `disconnect` and `set` are subqueries of the same statement, with the same locks and `MERGE`s as before. A nested create of a user with 5 posts goes from 12 statements to 1, `create` from 2 to 1, `update` from 3 to 1.
- `upsert` with nested writes runs them and reads the result back in one second statement (was one per nested write, plus a read).
- `delete` without `onDelete` rules is one statement: lock, read the row, `DETACH DELETE` (was 3). With `onDelete` rules whose cascades form a tree (no cycle, no interface), the lock, every cascade level, the `Restrict` checks and the delete (skipped when a check fails) are one statement too (a user → posts → comments cascade goes from 6 to 1); otherwise each cascade level is one statement and the checks share the delete's. A node deleted by a concurrent operation while the delete waited for its lock is now reported as not found.
- HTTP transport: an operation that is one statement and writes nothing when it fails (reads, `create` without a nested `connect`, `update` without relation writes, `upsert` without nested writes, `delete`, `createMany` / `updateMany` / `deleteMany`, `$cypher`) is sent as one auto-commit Query API request (reads with `accessMode: "READ"`), retried on transient errors, instead of opening and committing an explicit transaction. Others, and everything inside `$transaction`, still use explicit transactions. New `CyphraClient.withSingleStatement()` and `HttpSession.runRetried()`.
- `shortestPath` / `allShortestPaths` no longer read every path node's properties twice.
- Each statement still emits a `query` event and a span, so operations now emit fewer of them. The `Runner` used by `ModelEngine` takes an optional `{ autoCommit }`.

Benchmarks re-run: see https://cyphra.dev/benchmarks.
