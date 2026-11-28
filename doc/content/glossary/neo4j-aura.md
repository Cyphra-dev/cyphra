---
title: "Neo4j Aura"
description: "Neo4j Aura is Neo4j's fully managed cloud service for running Neo4j databases, with a free tier and paid tiers. Cyphra connects to it over neo4j+s://."
date: "2026-11-20"
aliases: ["AuraDB"]
related: ["bolt-protocol", "constraint"]
---

## Definition

Neo4j Aura is the managed cloud offering from Neo4j, Inc. AuraDB runs Neo4j databases for you on the
major cloud providers: you create an instance in a console, receive a connection URI and
credentials, and Neo4j handles servers, upgrades and backups. There is a free tier for small
projects and several paid tiers for production. Aura instances are reached over TLS with a
`neo4j+s://` [Bolt](/glossary/bolt-protocol) URI.

Aura is one of several ways to run Neo4j: self-managed on your own servers or Kubernetes, in Docker
for development, or on another managed service.

## In Cyphra

Cyphra connects through the official Neo4j driver, so an Aura instance is configured like any other
Neo4j database (the typed client needs Neo4j 5.6 or later): set `NEO4J_URI`, `NEO4J_USERNAME` and
`NEO4J_PASSWORD`, then run `cyphra migrate deploy`. If you would rather have a
dedicated Neo4j Community instance per database, [Cyphra Cloud](/cloud) offers that, and the
[Cyphra Operator](https://github.com/Cyphra-dev/operator) runs the same setup on your own
Kubernetes. Neo4j and Aura are trademarks of Neo4j, Inc.

To query an Aura database from Node.js with a typed client, see [Neo4j with TypeScript](/).
