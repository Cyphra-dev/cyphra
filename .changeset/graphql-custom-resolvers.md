---
"@cyphra/graphql": minor
---

`compat.v7.makeSchema` accepts `resolvers`, merged like `new Neo4jGraphQL({ typeDefs, resolvers })`:
`Query` / `Mutation` fields without `@cypher` are served by them, object, input and union types
without `@node` are passed through to the schema as written, and `@customResolver(requires)` fields
are left out of the generated Cypher while the `requires` selection is always fetched for the
parent. As in v7, `context.jwt` (from a verified token) and `context.executionContext` are set for
the resolvers. The printed schema matches `@neo4j/graphql` 7.6.8. One deliberate difference:
`@authentication` applies to every root field served by resolvers (v7 7.6.8 applies it to the first
two only).
