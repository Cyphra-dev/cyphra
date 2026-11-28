---
"@cyphra/runtime": patch
---

Internal engine entries for `@cyphra/graphql`'s `compat.v7` (not in the client's types, not covered by semver), Neo4j only: Cypher `CALL` clauses (`$call`) in `select` (scalars, lists, nodes, on the node or on the edge it was reached through) and in `orderBy` (a projection can reuse a sort's value), `call` bodies in `$cypherNodes` filters, `findMany({ $from })` reading the nodes of a statement's rows, `runCypherFragment` (a whole statement, raw rows), and `withReservedVariables` (names a client's statements never give their variables). Relation and node loads whose projection, sort or filter needs a `CALL` clause, or whose filter contains a fragment marked with `CYPHER_AGGREGATES`, run as `CALL` clauses: Neo4j 5 rejects aggregating functions in the subquery expressions of a projection or an `ORDER BY`.
