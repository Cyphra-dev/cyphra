---
"@cyphra/graphql": minor
---

Native API extension points (#247): `computed` exposes the client's computed fields
(`$extends({ result })`, their `needs` loaded when selected); `cypherFields` adds Cypher-backed
fields (the native `@cypher`, built with `native.cypher`), compiled into the parent's statement
with arguments and context values bound as parameters, returning scalars (filterable and sortable)
or nodes (filtered by the target's read rules); `extend` merges SDL and resolvers into the
generated schema (non-node result types, custom root fields, fields added to generated types),
with `ctx.cyphra` (the request's client, rules applied) and `ctx.cyphra.selection(info)` (the
selection as the client's `select`, so a custom resolver loads generated types in one statement).
Rules do not apply inside the Cypher of a Cypher-backed field.
