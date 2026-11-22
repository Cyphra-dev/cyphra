---
"@cyphra/graphql": minor
"@cyphra/cli": minor
---

`cyphra import graphql` converts `@neo4j/graphql` v7 unions of `@node` types to Cyphra unions (`union Search = Movie | Genre`), and `@relationship` fields to a union to relation fields to it. Members renamed by `@node(labels)` keep their new names and `extend union` is merged. Properties on a relationship to a union are reported and left out (the relation field is converted), and unions of types without `@node` are reported as before.
