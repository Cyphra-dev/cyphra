---
"@cyphra/runtime": minor
---

Add shortest-path queries to the ORM client.

- `db.user.shortestPath({ from, to, via, maxDepth, direction, where, edgeWhere, select, include })` returns one shortest path between the nodes matching `from` and `to` along self-relations, or `null`; `db.user.allShortestPaths({ …, take })` returns every path of the minimal length. Both compile to one statement with a GQL shortest-path selector (`SHORTEST 1` / `ALL SHORTEST`), so they need Neo4j 5.21 or later.
- `maxDepth` is required and capped by the client option `maxTraversalDepth` (default 10). `where` (intermediate nodes) and `edgeWhere` (every edge) are applied before the shortest path is picked. When `from` / `to` match several nodes, the overall shortest paths over every pair are returned; a node matching both gives a zero-hop path.
- Results are typed paths (`{ nodes, edges }`): nodes are shaped by `select` / `include`, edge properties are typed from the `relationship { … }` model. The new `ShortestPathArgs` and `ShortestPathResult` types are exported.
