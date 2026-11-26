---
"@cyphra/runtime": minor
---

Nested `update`, `delete` and `upsert` on the relations of an update (`posts: { update: { where, data }, delete: { id }, upsert: { where, create, update } }`; on a to-one relation `update: data`, `delete: true`, `upsert: { create, update }`) and `connectOrCreate` on create and update, each a subquery of the write's single statement: a target that is not linked throws `NotFoundError` and rolls the whole write back, nested deletes apply `onDelete` rules, and validation rules and `@min` / `@max` are checked with their paths. `where` takes `_count` filters on to-many relations (`{ _count: { posts: { gte: 2, where: { published: true } } } }`), compiled to `COUNT {}`. Both are typed and respect engine rules (`read` / `update` / `delete` on the targets, `create` / `after` on what they create, `read` in counts). On FalkorDB, a nested `delete` of a model with `onDelete: Restrict` rules throws `UnsupportedFeatureError`.
