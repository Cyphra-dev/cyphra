---
"@cyphra/runtime": minor
---

Internal engine entries for the native GraphQL API's extension points: Cypher expressions in
`select` (a scalar value, or the nodes the expression returns, filtered by the target's read rules),
`where` and `orderBy` (`$cypher`, built with `cypherFragment`, every interpolated value bound as a
parameter), `encodeCypherParam`, and `computedFieldsOf(client, model)` (the computed fields of a
client and their `needs`). They are experimental and not covered by semantic versioning.
