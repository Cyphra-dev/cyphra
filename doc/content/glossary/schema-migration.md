---
title: "Schema migration"
description: "A schema migration is a versioned, reviewed change to a database's schema and data, applied once and in order on every environment."
date: "2026-11-20"
aliases: ["Database migration", "Migration"]
related: ["constraint", "neo4j-index"]
---

## Definition

A schema migration is a script that moves a database from one version of its schema to the next.
Migrations are stored with the code, applied in order, and recorded in the database so that each
one runs exactly once per environment. That makes a schema change reproducible: development,
staging and production end up in the same state.

In a relational database, migrations mostly create and alter tables. Neo4j has no tables, so a
migration there does two jobs: keep [constraints](/glossary/constraint) and
[indexes](/glossary/neo4j-index) in line with the model, and fix up existing data, for example by
backfilling a new property or refusing to continue when a required property is missing.

## In Cyphra

`cyphra migrate dev` generates a migration from the difference between your schema and the last
snapshot, with DDL, backfills and guards. `cyphra migrate deploy` applies pending ones, and
`cyphra migrate status` reports drift, which makes it usable as a CI check. Applied migrations are
recorded as `__CyphraMigration` nodes. See [Migrations](/migrations) and
[Neo4j migrations: constraints and indexes as code](/blog/neo4j-schema-migrations-constraints-as-code).
