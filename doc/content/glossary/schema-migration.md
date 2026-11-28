---
title: "Schema migration"
description: "A schema migration is a versioned, reviewed change to a database's schema and data, applied once and in order on every environment."
date: "2026-11-20"
updated: "2026-11-28"
aliases: ["Database migration", "Migration"]
related: ["constraint", "neo4j-index"]
---

## Definition

A schema migration is a script that moves a database from one version of its schema to the next.
Migrations are stored with the code, applied in order, and recorded in the database so that each
one runs exactly once per environment: development, staging and production end up in the same
state.

Neo4j has no tables, so a migration there keeps [constraints](/glossary/constraint) and
[indexes](/glossary/neo4j-index) in line with the model, and fixes up existing data, for example by
backfilling a new property or refusing to continue when a required property is missing. Without
migrations, those changes are run by hand and drift apart between environments.

## In Cyphra

`cyphra migrate dev` generates a migration from the difference between your schema and the last
snapshot, `cyphra migrate deploy` applies pending ones, and `cyphra migrate status` reports drift
in CI.

**For the full guide, read [Neo4j migrations with Cyphra](/migrations)**: every generated step,
backfills and guards, and how to deploy them.
