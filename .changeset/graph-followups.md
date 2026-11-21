---
"@cyphra/runtime": minor
---

Graph query follow-ups:

- Multi-hop traversals across models: `traverse({ via: [{ rel: "entities" }, { rel: "related", depth: { max: 2 } }, { rel: "chunks" }] })` follows a list of hops, each along relation(s) of the model the previous hop reached, in one statement. Each hop takes its own `direction`, `depth` (self-relations only), `where` (on every node it steps to) and `edgeWhere`. Results, `where`, `orderBy` and `select` / `include` are typed by the last hop's model; `returnPaths` paths hold every model and edge met along the way (`HopPath`). The relation-name form of `via` is unchanged.
- Ordering by a filtered relation count: `orderBy: { posts: { _count: "desc", where: { published: true } } }`, at the top level, in nested relations and in traversals.
- `$edge` number updates on `connect` and `set`: `$edge: { weight: { increment: 1 } }` (and `decrement`, `multiply`) is applied in the `MERGE` statement, to the current value of an existing edge or to the default of a new one; `@min` / `@max` on the edge property are checked on the result and a broken rule rolls the write back.
- `set` on a to-many relation now keeps the edges to the nodes it lists (updating them with their `$edge`) instead of deleting and recreating them, so their other properties (and defaults such as `@default(now())`) are kept.
