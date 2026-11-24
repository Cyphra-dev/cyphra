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
- **Generated code** runs on a runtime of the same major that is at least as new as the CLI that
  generated it; the generated file checks this at startup.
- **Deprecations** are announced in a minor, with warnings, and removed in a major at least 3 months
  and at least one minor later.
- **Experimental** features are marked with a docs callout and `@experimental` (`previewFeatures`
  in `cyphra.json` for schema-level ones), and may change in minors. At 1.0: GraphQL
  subscriptions, `cyphra studio`, the output of `cyphra import`, and `cyphra push`.
- **Supported versions** are the ones CI tests: the latest Neo4j release; the tested Memgraph and
  FalkorDB versions and later releases of the same major; `neo4j-driver` 5 and 6 (a major is
  dropped only in a Cyphra major); every maintained Node.js LTS line (22 and 24 at 1.0);
  TypeScript in a rolling two-year window from 5.9. Bun, Deno and edge runtimes are best effort.
- **Security fixes** go to the latest minor; the previous major gets high and critical fixes for 6
  months after the next major.
- **Releases** ship whenever ready; majors get prereleases on the `next` dist-tag first.

The maintainers' decisions are recorded on the page.
