---
title: "Cypher"
description: "Cypher is Neo4j's declarative query language. It describes graph patterns with ASCII-art syntax such as (a:User)-[:FOLLOWS]->(b:User)."
date: "2026-11-20"
aliases: ["Cypher query language", "openCypher"]
related: ["property-graph", "graph-traversal", "node-label", "relationship-type"]
---

## Definition

Cypher is the query language of Neo4j. Instead of joining tables, you draw the shape of the data you
want: nodes in parentheses, relationships in square brackets, and arrows for direction.

```cypher
MATCH (u:User)-[:AUTHORED]->(p:Post)
WHERE p.published = $published
RETURN u.name AS name, count(p) AS posts
```

The main clauses are `MATCH` (find a pattern), `WHERE` (filter it), `RETURN` (shape the result),
`CREATE` and `MERGE` (write), and `SET` and `DELETE` (update and remove). Values are passed as
parameters such as `$published`, which keeps queries cacheable and safe from injection.

Cypher was created at Neo4j and opened up through the openCypher project, and it was a major input
to GQL, the ISO standard graph query language.

## In Cyphra

The [typed client](/client) compiles its calls to Cypher, and `db.$cypher` runs your own Cypher as a
parameterized tagged template. The [query builder](/queries) composes Cypher from typed parts.
