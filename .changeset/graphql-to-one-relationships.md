---
"@cyphra/graphql": minor
---

`compat.v7.makeSchema` supports to-one (non-list) relationships such as
`lab: Lab @relationship(…)`, with the API `@neo4j/graphql` 7.6.8 generates for them: the field and
its connection without arguments, `lab: { … }` / `lab: null` and `labConnection` filters (also in
`@authorization` rules), nested `create` in create inputs and nested `delete` in `deleteX`. Like v7,
a non-nullable to-one relationship (`Lab!`) is rejected, and a create input naming two members of a
to-one union fails.
