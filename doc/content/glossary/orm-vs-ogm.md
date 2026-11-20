---
title: "ORM vs OGM"
description: "An ORM maps database tables to objects; an OGM maps graph nodes and relationships to objects. What the terms mean and why Cyphra calls itself an ORM."
date: "2026-11-20"
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

Strictly speaking, Cyphra is an object-graph mapper: it maps nodes, relationships and edge
properties from a `.cyphra` schema. It uses the more familiar word ORM because its API follows the
ORMs TypeScript developers already know, with `findMany`, `include`, `select` and nested writes.
See the [typed client](/client).
