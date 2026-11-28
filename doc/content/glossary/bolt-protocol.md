---
title: "Bolt protocol"
description: "Bolt is the binary protocol Neo4j drivers use to talk to the database, by default on port 7687, with bolt:// and neo4j:// connection URIs."
date: "2026-11-20"
aliases: ["Bolt"]
related: ["neo4j-aura", "cypher"]
---

## Definition

Bolt is Neo4j's client-server protocol. Official drivers (JavaScript, Java, Python, Go, .NET) use
it to send Cypher and parameters and to stream results back in a compact binary format. It runs
over TCP, by default on port 7687, and over WebSockets for browser clients.

The URI scheme says how a driver connects:

| Scheme     | Meaning                                                  |
| ---------- | -------------------------------------------------------- |
| `bolt://`  | Direct connection to one server                          |
| `neo4j://` | Routing: the driver discovers servers and routes queries |
| `…+s://`   | TLS with full certificate verification                   |
| `…+ssc://` | TLS that also accepts a self-signed certificate          |

## In Cyphra

The [runtime](/runtime) wraps the official `neo4j-driver` package, so any URI it accepts works in
`NEO4J_URI`. `cyphra dev` writes a local `bolt://` URI to `.env`, and
[Cyphra Cloud](/cloud) databases are only reachable over TLS with `neo4j+s://`.

To connect from Node.js with typed results instead of raw records, see
[Neo4j with TypeScript](/).
