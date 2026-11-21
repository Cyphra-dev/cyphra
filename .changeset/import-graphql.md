---
"@cyphra/cli": minor
---

Add `cyphra import graphql <typeDefs.graphql...>`: converts `@neo4j/graphql` v7 type definitions to `schema.cyphra` (nodes, scalars, lists, `@id`, `@timestamp`, `@default`, `@unique`, `@relationship` and `@relationshipProperties`) and prints a report of everything it could not convert. `--merge` adds to an existing schema and keeps your models, fields and comments.
