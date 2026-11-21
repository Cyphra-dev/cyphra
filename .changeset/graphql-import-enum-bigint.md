---
"@cyphra/graphql": minor
"@cyphra/cli": minor
---

`cyphra import graphql` (and `cyphraSchema`) map GraphQL enums to Cyphra enums with the same values
(only the enums a converted field uses; `@default(value: X)` becomes `@default(X)`), and `BigInt` to
`BigInt` (defaults keep every digit), instead of `String` and "not converted".
