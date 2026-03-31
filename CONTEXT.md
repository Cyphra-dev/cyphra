# Cyphra — context for AI assistants

This file is **maintainer and agent context**: product boundaries, monorepo layout, invariants, and pointers to authoritative docs. It does **not** replace user-facing documentation.

## Product definition

**Cyphra** is a TypeScript toolkit for **Neo4j**: a **`.cyphra`** graph schema, a **project config** (`cyphra.config.ts` / `cyphra.json`) that points at the schema and provider, **`cyphra push` / migrate** to align **constraints and indexes** with the schema, then **application code** in one of two styles:

1. **ORM (Prisma-like)** — `createSchemaClient` and model delegates (`db.posts.create`, …) driven by the parsed schema.
2. **Query / Cypher-JS (Drizzle-like)** — builders and helpers in `@cyphra/query` that compile to **`CompiledCypher`** and run through the **official Bolt adapter** (`CyphraNeo4j`).

Everything executed against the database is **parameter-safe** (no string-splicing user data). Raw **`cypher`** templates remain the escape hatch. The **`cyphra`** meta-package exposes **`query`** and **`orm`** namespaces (plus optional subpaths) for a clearer DX.

**Beta:** APIs may change between releases; breaking changes should be noted in **`CHANGELOG.md`** and user-facing docs. Monorepo **`examples/*`** are the reference consumers.

## Monorepo map

| Package | Role |
| --- | --- |
| **`cyphra`** | Meta-package: **`query`** / **`orm`** namespaces, optional `cyphra/query` & `cyphra/orm` subpaths, workspace helper **`loadCyphraWorkspace`**, re-exports + `cyphra` CLI binary. |
| `@cyphra/schema` | Parse/validate `.cyphra`, canonical print, constraint/index DDL for Neo4j 5+. |
| `@cyphra/query` | `cypher` tag, `SelectQuery` and other compilers; grows toward Cypher Manual parity. |
| `@cyphra/orm` | CRUD/traversal helpers compiled from schema + client. |
| `@cyphra/runtime` | `CyphraClient`, sessions, transactions, execution helpers. |
| `@cyphra/migrator` | `defineMigration`, push/migrate flows, migration tracking in the graph. |
| `@cyphra/config` | **`loadConfig`**, path resolution — shared by CLI, **`cyphra`** (`loadCyphraWorkspace`), and apps. |
| `@cyphra/cli` | `init`, `validate`, `db pull`, schema/migrate/push. |
| `@cyphra/core` | Shared **provider** types and driver contracts. |
| `@cyphra/provider-neo4j` | Bolt implementation for Neo4j. |

Also in the workspace: **`doc/`** (Next.js/Nextra site), **`examples/*`** (clone-only samples, not published to npm), **`extensions/*`** (e.g. VS Code). **Fixed versioning**: `cyphra` and every `@cyphra/*` release share the same version (Changesets).

## Authoritative documentation (do not duplicate here)

- **Introduction / positioning:** `doc/app/introduction/page.mdx`
- **Guides:** `doc/app/getting-started/`, `doc/app/schema/`, `doc/app/queries/`, `doc/app/runtime/`, `doc/app/migrations/`, `doc/app/graph-orm/`, `doc/app/configuration/`, `doc/app/introspection/`, `doc/app/production/`
- **Roadmap (typed DSL vs Cypher):** `doc/app/cypher-coverage/page.mdx`
- **Providers / multi-backend intent:** `doc/app/providers/`
- **Version/edition matrices:** `doc/app/governance/`
- **Contributors:** `CONTRIBUTING.md` (pnpm, Vitest projects, build order for schema `dist`, changesets, `dev` → `main` releases)

Published site: **https://www.cyphra.dev**

## CI, release, and publishing flows

- **CI:** `.github/workflows/ci.yml` runs on `main` and `dev` (push + PR), reuses `.github/workflows/quality-reusable.yml`, and includes a Neo4j service job for integration tests.
- **Shared quality gate:** `.github/workflows/quality-reusable.yml` is the canonical install/build/lint/format/typecheck/audit/test/docs/example/extension-smoke pipeline.
- **Package release (changesets):** `.github/workflows/release.yml` runs from `main`, creates/updates the version PR (`chore: version packages`) and publishes to npm when changesets are present.
- **Tag/manual package publish:** `.github/workflows/packages-publish.yml` supports manual or `v*` tag-triggered publishing of JS packages.
- **VS Code extension publish:** `.github/workflows/vscode-extension-publish.yml` supports manual or `vscode-v*` tag-triggered publish with `vsce`.
- **npm auth model:** publishing uses **trusted publisher (OIDC)** with `id-token: write`; no long-lived npm tokens are expected in repository secrets.

## Package boundaries (dependency rules)

- **`@cyphra/schema`** — parse, validate, DDL text only; **no** `CyphraClient`, no Bolt.
- **`@cyphra/query`** — compile to **`CompiledCypher`** only; **no** DB execution.
- **`@cyphra/orm`** — schema-driven helpers; depends on **`schema`** + **`query`** + **`runtime`** types.
- **`@cyphra/runtime`** + **`@cyphra/provider-neo4j`** — execution; all runs go through **`CompiledCypher`** (or driver `run` with the same parameter discipline).
- **`@cyphra/migrator`** + **`@cyphra/cli`** — tooling and orchestration; CLI may load config and open clients for push/migrate.

## Technical invariants

- **Parameters, not concatenation:** interpolated values in queries must go through the parameterized pipeline (e.g. `cypher` / builders)—never build Cypher by string-splicing user or variable data.
- **Schema as contract:** `.cyphra` is the declarative model; DDL and migrations should stay aligned with **Neo4j 5+** capabilities.
- **Providers:** `@cyphra/core` defines contracts; **only Neo4j is implemented** via `@cyphra/provider-neo4j`. Config may allow a `provider` field for future backends—do not assume other databases exist today.

## Living roadmap (query layer)

The typed DSL **incrementally** approaches the [Neo4j Cypher Manual](https://neo4j.com/docs/cypher-manual/current/). Until a clause or function exists in the typed API, use **`cypher`**—there is no runtime penalty. Human-oriented tiers: `doc/app/cypher-coverage/page.mdx`. Machine-oriented catalog: `packages/query/src/spec/catalog/` (implemented vs pending entries and tests).

## Maintainer intent and non-goals

**Intent**

- Favor **safety and reviewability** over hiding Cypher; generated or compiled output should remain understandable.
- Keep the **`cyphra`** meta-package the **default** developer experience (`import { … } from "cyphra"` + CLI in one dependency).
- Treat **`examples/`** as **monorepo-only** demos; npm consumers use the published packages.
- Preserve **fixed, synchronized versions** across `cyphra` and `@cyphra/*` so the meta-package never drifts from its dependencies.
- Expand the **typed query surface** in small, tested steps; use the spec catalog and golden tests to avoid regressions.
- **Document** user-visible behavior in `doc/app/`; keep this file **short** and pointer-heavy.
- Keep CI and release automation **explicit and auditable** (reusable quality gate + changesets-driven package versioning + separate extension publish flow).

**Non-goals (today)**

- First-class support for **non-Neo4j** graph databases (no second provider in-tree yet).
- Replacing **raw Cypher** for every use case—the `cypher` escape hatch remains intentional.
- Duplicating full **CLI reference** or **API listings** inside `CONTEXT.md`.

## When editing this codebase

- Run **`pnpm lint`**, **`pnpm typecheck`**, **`pnpm test`** before considering work done.
- After **`@cyphra/schema`** public API or `.d.ts` changes, run **`pnpm build`** (or filter-build schema) so dependents resolve fresh types; rebuild **`cyphra`** when re-exports change (`CONTRIBUTING.md`).
- Optional **Neo4j-backed** tests: set `NEO4J_TEST_*` env vars as described in `CONTRIBUTING.md`; Testcontainers tests need Docker unless skipped with `CYPHRA_SKIP_TESTCONTAINERS=1`.
- Useful local entry points from repo root: **`pnpm blog:db`** (start Next.js blog Neo4j), **`pnpm blog:dev`** (start DB + blog app), **`pnpm doc:dev`**, **`pnpm example:basic`**.
