---
"@cyphra/runtime": minor
---

Add `aggregate` and `groupBy` to the ORM client, with Prisma-compatible shapes typed from your schema.

- `db.post.aggregate({ where, _count, _sum, _avg, _min, _max })` returns exactly the aggregates you ask for. `_sum` / `_avg` take `Int` and `Float` fields, `_min` / `_max` also `String`, `DateTime` and `Date`. Nulls are ignored; on an empty match counts are `0` and the other aggregates `null`.
- `db.post.groupBy({ by: ["published"], having, orderBy, skip, take, … })` groups the matching nodes, with `having` and `orderBy` on aggregates (`{ views: { _avg: { gt: 10 } } }`, `{ _count: { id: "desc" } }`) and on the `by` fields. Fields of a to-one relation can be grouped on with `by: ["author.name"]` and come back as `{ author: { name } }`.
- Each call compiles to one parameterised Cypher statement and works inside `$transaction`.
