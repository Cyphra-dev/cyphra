# Cypher conformance catalog

This folder holds **normative metadata** for DSL emission tests against the [Neo4j Cypher Manual](https://neo4j.com/docs/cypher-manual/current/).

- **`meta.json`** — pinned manual URL and human-readable doc version string.
- **Runtime catalog** — TypeScript modules under [`../src/spec/catalog/`](../src/spec/catalog/) list every conformance row (`implemented` golden tests today, `pending` rows reserved for full-standard TDD).

Execution of compiled Cypher against a database is **out of scope** for this suite; use `neo4j-driver` and `@cyphra/provider-neo4j` integration tests for that.
