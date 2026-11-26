---
"@cyphra/graphql": minor
"@cyphra/runtime": patch
---

`compat.v7` runs list and connection queries on the shared engine (the typed client's compiler) when it answers exactly like v7: filters, sorting, `limit` / `offset`, v7 offset cursors, nested relationships and connections with edge `properties`, on types without `@authentication` / `@authorization`. Everything else (aggregations, full-text, `@cypher`, rules, unions, interfaces, edge filters and sorts, `single`, mutations, …) stays on the compat compiler, so results do not change. With `client`, the client's `query` events and spans now name the engine operation (`findMany` on `Movie`) for these queries, and a root connection selecting both a page and `totalCount` reads them with two statements in one read transaction. `@cyphra/runtime`: internal `withRawValues(client)` engine entry.
