---
"@cyphra/runtime": minor
"cyphra": minor
---

`createMany`, `updateMany` and `deleteMany` take `select` and then return the affected nodes as
`nodes` next to `count`, read in the same statement: the created nodes in `data` order, the nodes as
updated, the deleted nodes as they were (with every `onDelete` path: plain, one-statement cascades
and level-by-level cascades). Without `select` they return `{ count }` as before. Computed fields of
`$extends({ result })` apply to the returned nodes.
