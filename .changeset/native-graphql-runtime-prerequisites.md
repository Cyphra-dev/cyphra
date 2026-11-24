---
"@cyphra/runtime": minor
"cyphra": minor
---

Keyset cursor pagination in `findMany` / `findFirst`: select `$cursor` and pass it back as
`cursor: { after }` (or `{ before }`) with the same `orderBy`. Cursors are opaque strings holding the
boundary row's sort keys plus its `@id` (always the last sort key, so ties never repeat or skip a
row); pages stay stable when nodes are created or deleted before them. Any `orderBy` works (mixed
directions, nullable fields, a related node's field, relation counts); a cursor made for another
model or `orderBy` throws a `CyphraValidationError`.

Groundwork for the native GraphQL API (#77), internal and experimental: `withEngineRules(client,
rules)` returns a client whose statements AND per-model `read` / `update` / `delete` rules into
every match of the model (roots, nested relation loads, relation filters, `_count`, relation
`orderBy`, aggregates, search, traversal endpoints, write targets, `connect` targets); rules can be
added but not removed, and survive `$extends` and `$transaction`. `select` accepts aliased
relation loads (`{ recent: { $relation: "posts", take: 3 } }`, not in the public types) to load one
relation several times in one statement.

`$extends` no longer rebuilds a lookup of every model on each call (cheaper per-request clients on
large schemas). FalkorDB: a `WITH` whose projection has subquery expressions and whose `WHERE` needs
none is no longer rewritten into an invalid statement.
