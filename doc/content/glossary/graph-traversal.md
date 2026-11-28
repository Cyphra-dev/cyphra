---
title: "Graph traversal"
description: "A graph traversal follows relationships from node to node, one hop or many. It is the core operation of a graph database and of Cypher patterns."
date: "2026-11-20"
aliases: ["Traversal", "Variable-length path"]
related: ["cypher", "relationship-type", "neo4j-index"]
---

## Definition

Traversing a graph means starting at one or more nodes and following relationships to reach
others: a user's posts, the people they follow, the followers of those people. Each step along a
relationship is a hop.

In [Cypher](/glossary/cypher), a pattern describes the traversal. A fixed pattern names each hop,
and a variable-length pattern bounds the number of hops:

```cypher
// People reachable through one to three FOLLOWS hops
MATCH (me:User {id: $id})-[:FOLLOWS*1..3]->(other:User)
RETURN DISTINCT other.name
```

Neo4j stores relationships directly with the nodes they connect, so following a relationship does
not need an [index](/glossary/neo4j-index) lookup. Indexes are used to find the starting nodes.

## In Cyphra

The [typed client](/client) traverses through relation fields: `include` and `select` load related
nodes at any depth, and filters such as `posts: { some: { … } }` test related nodes. Paths with a
variable number of hops, or shortest paths, are clearer in Cypher, which `db.$cypher` runs as a
parameterized query.

For traversals with typed results in an application, see [Neo4j with TypeScript](/).
