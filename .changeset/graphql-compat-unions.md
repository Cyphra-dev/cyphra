---
"@cyphra/graphql": minor
---

`compat.v7.makeSchema` serves `@neo4j/graphql` v7 unions of `@node` types instead of throwing `UnsupportedTypeDefsError`: the printed SDL is identical to v7 7.6.8 (root union query, `<Union>Where`, member-keyed connection `where` and nested write inputs), and union selections resolve with inline fragments and `__typename`. Relationships to a union support `where` / `limit` / `offset`, connections with edge properties, cursors, `totalCount` and edge `sort`, relationship and connection filters per member, `@authorization` rules of each member, and nested `create` / `connect` / `update` / `disconnect` / `delete` keyed by member. One deliberate difference: a union `connect` / `disconnect` nested in another one applies its `where`, which v7 ignores. `@cypher` fields returning unions still throw.
