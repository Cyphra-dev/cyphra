---
title: "Node label"
description: "A label is a tag on a Neo4j node that groups it with similar nodes, like a type. Labels anchor MATCH patterns, constraints and indexes."
date: "2026-11-20"
aliases: ["Label"]
related: ["relationship-type", "property-graph", "constraint", "neo4j-index"]
---

## Definition

In Neo4j, a label marks what kind of thing a node is: `:User`, `:Post`, `:Order`. A node can have
zero, one or several labels, and they can be added or removed at any time.

Labels do three jobs:

- **Query anchors.** `MATCH (u:User)` only looks at nodes with the `User` label instead of the
  whole graph.
- **Schema targets.** [Constraints](/glossary/constraint) and [indexes](/glossary/neo4j-index) are
  declared for a label and a property, for example "`email` is unique among `User` nodes".
- **Documentation.** They make a graph readable, both in queries and in tools such as Neo4j
  Browser.

By convention, labels are written in PascalCase.

## In Cyphra

Each `node User { … }` block in a [schema](/schema) maps to the `User` label. `cyphra generate`
also emits a `NodeLabel` constant, so hand-written queries can use `NodeLabel.User` instead of a
string. `cyphra pull` reads the labels of an existing database to write a schema.
