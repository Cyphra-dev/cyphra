---
"@cyphra/runtime": minor
---

Add variable-length traversals and typed path results to the ORM client.

- `db.user.traverse({ from, via, depth: { min?, max }, where, edgeWhere, distinct, direction, select, include, orderBy, skip, take })` follows one or more self-relations (e.g. `following`) for `min..max` hops and returns the reached nodes, in one statement compiled to a quantified path pattern (Neo4j 5.9+). `depth.max` is required and capped by the new client option `maxTraversalDepth` (default 10). Each reached node is returned once by default; paths that loop back to their start node are skipped.
- `edgeWhere` filters every edge of the path on the properties of its `relationship { … }` model, typed from the schema.
- `returnPaths: true` returns `{ node, path }`, where `path` is `{ nodes, edges }`: the path's nodes (scalar fields) and its edges (`type`, `direction`, typed `properties`). The exported `Path`, `PathEdge` and `ModelPath` types describe them. Paths are decoded from plain maps, so they work with `neo4j-driver` 5 and 6.
