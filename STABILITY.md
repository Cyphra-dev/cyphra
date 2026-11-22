# Stability policy

> **Draft for Cyphra 1.0, not in force yet.** Tracked in [#124](https://github.com/Cyphra-dev/cyphra/issues/124).

The full policy is on the docs site: **<https://www.cyphra.dev/stability>** (source:
[`doc/app/stability/page.mdx`](./doc/app/stability/page.mdx)). In short, from `1.0.0`:

- **Semantic Versioning.** Breaking changes only in majors; minors add features and deprecations;
  patches fix bugs and security issues.
- **One version for every package.** `cyphra` and all `@cyphra/*` packages are a fixed Changesets
  group: they are released together with the same version, so a breaking change in any of them is a
  major for all. Use the same version of every Cyphra package in an app.
- **Public API** covers exported TypeScript APIs, the generated client's types and runtime behavior,
  the `.cyphra` schema language, CLI commands, flags, exit codes and `--json` output, the migration
  file format and the `__CyphraMigration` history, and the `@cyphra/graphql` compatibility contract
  with `@neo4j/graphql` 7. The Cypher text Cyphra generates, error messages and human-readable CLI
  output are not public API.
- **Deprecations** are announced in a minor, with warnings, and removed in a later major.
- **Experimental** features are marked in the docs and with `@experimental`, and may change in
  minors.
- **Supported versions** (Neo4j, Memgraph, FalkorDB, `neo4j-driver`, Node.js, TypeScript) are the
  ones CI tests; the page lists them.

Open decisions are marked **Decision needed** on the page.
