---
"@cyphra/graphql": minor
"@cyphra/cli": minor
---

`cyphra import graphql` maps shared `@node` labels and constrained ids:

- A label after the first in `@node(labels: ["Lab", "LearningActivity"])` becomes a Cyphra
  `interface LearningActivity` that the types carrying it implement, with the fields they declare
  the same way. When their common fields do not line up, it becomes `@@labels([LearningActivity])`
  instead. A GraphQL `interface` becomes a Cyphra interface (relationships to it included) when its
  implementations carry its label, or with `--add-interface-labels` (the report gives the Cypher that
  adds the label to existing nodes).
- `--url [uri]` reads the database's uniqueness constraints (read-only) and marks the fields they
  cover: an `ID` field becomes `@id`, another field `@unique`, a constraint over several properties
  `@@unique([…])`. `--id-fields Type.field,…` marks fields `@id` without a database. No default is
  added.
- Every decision is listed in the report. `convertGraphQLTypeDefs` takes the same options
  (`constraints`, `idFields`, `addInterfaceLabels`).
