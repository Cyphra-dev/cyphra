---
title: "Property graph"
description: "A property graph stores data as nodes and typed, directed relationships, with key-value properties on both. It is the data model behind Neo4j."
date: "2026-11-20"
aliases: ["Labeled property graph", "LPG"]
related: ["node-label", "relationship-type", "cypher"]
---

## Definition

A property graph models data with three building blocks:

- **Nodes**, the entities: a user, a post, an order. Nodes carry [labels](/glossary/node-label)
  that say what kind of thing they are.
- **Relationships**, the connections. Each one has a [type](/glossary/relationship-type), a
  direction, a start node and an end node.
- **Properties**, key-value pairs stored on nodes and on relationships, such as `email` on a user
  or `since` on a `FOLLOWS` relationship.

Because relationships are stored as first-class records rather than computed through joins, queries
that follow connections stay simple to write. Neo4j implements the labeled property graph model,
and [Cypher](/glossary/cypher) is built around it.

## In Cyphra

A `.cyphra` schema describes a property graph: `node` blocks for labels and their properties,
relation fields for relationships, and `relationship` blocks when the relationship itself has
properties. See the [schema reference](/schema).
