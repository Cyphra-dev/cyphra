---
"@cyphra/graphql": minor
---

`compat.v7` runs every `@cypher` field on the shared engine, with the same results: statements that aggregate (`count()`, `collect()`, …) in projections, sorts and nested filters; statements that name variables the engine would use (`n`, `m0`, …); scalar fields whose statement returns no row or several (the node is dropped or repeated, like v7); `@cypher` fields of relationship properties; and root `Query` / `Mutation` `@cypher` fields (a mutation in one write transaction). Subscriptions read Change Data Capture through the shared CDC reader of the native API, with the same events. What stays on the compat compiler is what only v7 does (interfaces and unions, nested writes, arithmetic and list operators and `field_SET` keys, custom-resolver fields, `context.cypherParams`, `validate` rules that depend on the node), plus a few `@authorization` cases.
