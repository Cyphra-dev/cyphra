---
title: "Relationship type"
description: "Every Neo4j relationship has exactly one type, such as AUTHORED or FOLLOWS, plus a direction. The type names the connection in Cypher patterns."
date: "2026-11-20"
aliases: ["Edge type"]
related: ["node-label", "property-graph", "graph-traversal"]
---

## Definition

A relationship in Neo4j connects a start node to an end node, and it always has exactly one type:
`AUTHORED`, `FOLLOWS`, `MEMBER_OF`. Types are written in UPPER_SNAKE_CASE by convention and appear
between square brackets in [Cypher](/glossary/cypher):

```cypher
MATCH (u:User)-[:AUTHORED]->(p:Post) RETURN p
```

Relationships are always stored with a direction, but queries can ignore it with an undirected
pattern such as `(a)-[:KNOWS]-(b)`. Like nodes, relationships can hold properties, for example the
date a follow started.

## In Cyphra

A relation field names the type and the direction:
`posts Post[] @out(AUTHORED)`. Both ends of a relationship can be
declared, here `User.posts` and `Post.author`. When the relationship has properties, a
`relationship { … }` block types them, and the [typed client](/client) exposes them as `$edge`.
See [Relationships](/schema#relationships).

How relationships map to typed fields, the graph side of an ORM, is explained on the
[Neo4j ORM](/neo4j-orm) page.
