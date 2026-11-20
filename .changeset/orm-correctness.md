---
"@cyphra/runtime": minor
"cyphra": minor
---

ORM write correctness fixes and string range filters:

- `upsert` now compiles to a single atomic `MERGE` on the unique key from `where` (`ON CREATE SET` the create data and schema defaults, `ON MATCH SET` the update), then runs nested relation writes of the branch it took in the same transaction. Concurrent upserts of one new key no longer fail with `ConstraintValidationFailed`; with the uniqueness constraint that `@id` / `@unique` generate (`cyphra push` or a migration) they yield exactly one node. The key never gets a generated default, `create` may not set the key to a different value than `where`, and extra `where` conditions are checked on an existing node before it is updated (a mismatch throws `CyphraError` and writes nothing).
- `connect` (in `create`, `update`, `set` and `upsert`) now `MERGE`s the relationship instead of `CREATE`, so connecting an already linked pair keeps one edge. On typed edges, `$edge` plus defaults apply when the edge is created; an existing edge gets only the `$edge` properties passed. Edges duplicated by earlier versions are left in place.
- `DateTime` values (writes, `@default(now())` and filter parameters) are always stored at UTC offset `Z` instead of the process's local offset, so `equals` / `in` match the same instant regardless of the server's `TZ`. Values written by earlier versions with a non-zero offset still read back correctly, but exact-instant comparisons against them do not match; see the docs for a one-off Cypher to normalize them.
- Typed filters: `lt` / `lte` / `gt` / `gte` on `String` fields (lexicographic), e.g. for keyset pagination on an `id` tie-breaker.
