---
title: "Constraint"
description: "A Neo4j constraint is a rule the database enforces on every write, such as property uniqueness. Cyphra generates uniqueness constraints from @id and @unique."
date: "2026-11-20"
aliases: ["Uniqueness constraint", "Neo4j constraint"]
related: ["neo4j-index", "schema-migration", "node-label"]
---

## Definition

A constraint makes Neo4j reject writes that would break a rule. Neo4j 5 has several kinds:

- **Property uniqueness**: no two nodes with a label share a value, for example `User.email`.
  Relationship property uniqueness is available from Neo4j 5.7.
- **Property existence** and **property type**: a property must be present, or must have a given
  type.
- **Key**: a combination of existence and uniqueness.

Uniqueness constraints are available in every edition. Existence, type and key constraints are
Neo4j Enterprise Edition features. Each uniqueness constraint is backed by an
[index](/glossary/neo4j-index), so lookups on that property are fast.

```cypher
CREATE CONSTRAINT User_email_unique IF NOT EXISTS
FOR (n:`User`) REQUIRE n.`email` IS UNIQUE
```

## In Cyphra

`@id` and `@unique` in a [schema](/schema#decorators) become uniqueness constraints like the one
above, created by a [migration](/migrations) or by `cyphra push`. `cyphra schema ddl` prints them
without a database.

How constraints are created, changed and deployed is covered in
[Neo4j migrations](/migrations).
