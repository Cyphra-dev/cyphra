---
"@cyphra/graphql": minor
"@cyphra/cli": minor
---

`cyphra import graphql` (and `cyphraSchema`) map `Point`, `CartesianPoint`, `Time`, `LocalTime`,
`LocalDateTime` and `Duration` fields to the Cyphra types of the same name instead of reporting them
as not converted, with their string defaults, and `@timestamp` on `Time` becomes `@default(now())`.
