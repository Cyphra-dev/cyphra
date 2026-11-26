---
"@cyphra/graphql": minor
---

Native API traversals (#246): `<model>Traverse` (`from`, `via`, `direction`, `depth`, `where`, `distinct`, `orderBy`, `skip`, `take`), `<model>TraversePaths` (`{ node, path { nodes, edges { type direction _edge } } }`) and `<model>ShortestPath` (`from`, `to`, `via`, `maxDepth`, `where`) on models with relations back to themselves, in the `traverse` operation group (off by default); named traversal fields across models from `config.traversals` (`{ Chunk: { context: { via: [{ rel }, …], args } } }` → `Chunk.context(…): [Chunk!]!`), compiled into the parent's statement and checked at startup; `limits.maxTraversalDepth`. A traversal never steps through a node the read rules hide, and path nodes follow the field rules.
