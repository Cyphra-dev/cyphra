---
"@cyphra/runtime": patch
---

Internal engine entries for `@cyphra/graphql`'s `compat.v7` (not in the client's types, not covered by semantic versioning): `$now` on `createMany` / `updateMany` sets `DateTime` / `Date` fields to the database clock in the statement; `CypherDateTimeText` passes a DateTime as text, parsed by `datetime()` in the statement (offset and precision kept); `$edge` filters and sorts on the edge a node was reached through (relation filters, relation loads, `_count`). Neo4j only for the first two.
