---
"@cyphra/runtime": patch
---

Engine rules (`withEngineRules`) on paths: `traverse`, `shortestPath` and `allShortestPaths` apply the read rules to every node a path steps through (before, only to the start and reached nodes, so a path could go through a hidden node and return it), and the nodes of returned paths read their fields through the field rules. On Memgraph and FalkorDB, which cannot run a subquery on each node of a path, a read rule with a relation filter on a traversed model now fails the traversal (`UnsupportedFeatureError`) instead of being skipped. Internal: a traversal load (`$traverse` in `select`, Neo4j only), for the native GraphQL API's named traversal fields.
