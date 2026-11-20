---
title: "Index"
description: "A Neo4j index speeds up finding the nodes or relationships a query starts from. Range, text, point, full-text, vector and lookup indexes exist."
date: "2026-11-20"
aliases: ["Range index", "Neo4j index"]
related: ["constraint", "graph-traversal", "schema-migration"]
---

## Definition

Neo4j uses indexes to find the starting points of a query quickly, for example the user with a
given name, instead of scanning every node with a label. Once it has a starting node, following
relationships does not need an index.

Neo4j 5 offers several index types:

- **Range**: the general-purpose index for equality and range predicates.
- **Text**: string predicates such as `CONTAINS` and `ENDS WITH`.
- **Point**: spatial queries.
- **Full-text** and **vector**: text search and similarity search, queried through procedures.
- **Token lookup**: created by default, they find nodes by label and relationships by type.

```cypher
CREATE RANGE INDEX User_name_idx IF NOT EXISTS FOR (n:`User`) ON (n.`name`)
```

## In Cyphra

`@index` on a field creates a range index like the one above, on nodes or on the properties of a
`relationship { … }` model. Fields with `@id` or `@unique` do not need it: their
[constraint](/glossary/constraint) already comes with an index. See [Decorators](/schema#decorators).
