---
"@cyphra/graphql": minor
"@cyphra/runtime": patch
---

Native GraphQL API: relation update inputs take nested `update` (`[{ where, data }]` on to-many, the data on to-one), `delete` (unique keys, or `true` on to-one; `onDelete` rules apply), `upsert` (`[{ where, create, update }]` / `{ create, update }`) and `connectOrCreate` (also in create inputs), each served when the target's matching operation is on, all in the root field's one statement and under its rules (`NOT_FOUND`, `RESTRICTED`, `FORBIDDEN`, validation issues with GraphQL argument paths). `<Model>Where` takes `_count` filters on to-many relations (`_count: { posts: { gte: 2, where: { … } } }`), counting only readable nodes; rule `where`s may use them too. In the runtime, a uniqueness violation from a batched nested create now names its model and fields.
