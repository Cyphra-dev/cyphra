---
title: "ORM vs OGM"
description: "An ORM maps relational tables to objects; an OGM maps graph nodes and relationships to objects. The two terms, and why Cyphra is an OGM."
date: "2026-11-20"
updated: "2026-11-28"
aliases: ["Object-relational mapper", "Object-graph mapper"]
related: ["property-graph", "relationship-type"]
---

## Definition

An **ORM** (object-relational mapper) maps rows of relational tables to objects in application
code, and turns method calls into SQL. An **OGM** (object-graph mapper) does the same for a graph
database: nodes become objects, and relationships become references or collections between them.
Neo4j-OGM for Java, used by Spring Data Neo4j, is a well-known example.

The jobs are the same in both cases: describe the model once, get typed objects back, and write
related records without assembling queries by hand. What differs is the target. A graph mapper has
to deal with relationship direction, relationship types and properties stored on relationships,
which have no direct equivalent in a table.

## In Cyphra

Cyphra is an OGM for Neo4j, Memgraph and FalkorDB: it maps nodes, labels, relationships and edge
properties from a `.cyphra` schema, and compiles every call to Cypher. Its API follows the ORMs
TypeScript developers already know (`findMany`, `include`, `select`, nested writes), which is why
people often find it by searching for a "Neo4j ORM".

For the full comparison, with a concept table, Cyphra examples and an FAQ, read
**[ORM or OGM? on the Neo4j ORM page](/neo4j-orm#orm-or-ogm)**.
