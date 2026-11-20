---
title: "APOC"
description: "APOC (Awesome Procedures On Cypher) is a library of procedures and functions that extends Neo4j's Cypher. Cyphra does not need it."
date: "2026-11-20"
aliases: ["Awesome Procedures On Cypher", "APOC Core", "APOC Extended"]
related: ["cypher", "schema-migration"]
---

## Definition

APOC is the standard extension library for [Cypher](/glossary/cypher). It adds hundreds of
procedures and functions, called with `CALL apoc.…` or used inside expressions: data import and
export, string, map and collection helpers, graph refactoring, and batch processing such as
`apoc.periodic.iterate`.

Since Neo4j 5, APOC comes in two parts. APOC Core is maintained by Neo4j and distributed with the
database, but it has to be enabled as a plugin. APOC Extended is maintained separately by the
community and installed on its own.

Recent Cypher versions cover several former APOC use cases natively: `CALL { … } IN TRANSACTIONS`
for batched writes, and `COLLECT { … }` and `EXISTS { … }` subqueries for nested results.

## In Cyphra

Cyphra does not require APOC. The [typed client](/client) compiles to built-in Cypher (including
`COLLECT {}` subqueries, hence Neo4j 5.6+), and [migrations](/migrations) batch large rewrites with
`CALL { … } IN TRANSACTIONS`. If your database has APOC enabled, you can still call it from
`db.$cypher`.
