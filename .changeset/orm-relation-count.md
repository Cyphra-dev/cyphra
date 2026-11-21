---
"@cyphra/runtime": minor
---

Add relation counts to the ORM client, with Prisma-compatible shapes typed from your schema.

- `include: { _count: true }` counts every to-many relation; `_count: { select: { posts: true, comments: { where: { approved: true } } } }` counts the listed ones, with an optional filter on the related node (relation filters included). Works under `select` and `include`, inside included relations at any depth, and in the results of `find*`, `create`, `update`, `upsert` and `delete`. The result has a `_count: { posts: number, … }` key typed from exactly what you ask for.
- `orderBy: { posts: { _count: "desc" } }` sorts by the number of related nodes, at the top level and inside included relations.
- Counts compile to `COUNT {}` subqueries in the same statement. As in Prisma, to-one relations cannot be counted.
