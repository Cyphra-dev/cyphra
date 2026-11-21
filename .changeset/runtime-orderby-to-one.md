---
"@cyphra/runtime": minor
---

`orderBy` on a to-one relation sorts by a scalar of the related node: `orderBy: { author: { name: "asc" } }` (nodes without the relation sort as `null`). Works in `findMany`, nested `include` and `traverse`, and is typed in the generated client.
