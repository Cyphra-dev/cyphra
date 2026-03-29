# Contributing

## Setup

- Node 20+
- [pnpm](https://pnpm.io/) 9+

```bash
pnpm install
```

## Checks

```bash
pnpm lint
pnpm lint:fix
pnpm format
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm doc:build
pnpm example:basic
```

Documentation lives in [`doc/`](./doc) (Next.js + Nextra). Sidebar order and section titles are defined in [`doc/app/_meta.tsx`](./doc/app/_meta.tsx); new top-level routes need a matching `page.mdx` and usually an entry in that file.

Publishable packages include **`@cyphra/core`** (provider contracts) and **`@cyphra/provider-neo4j`** (Neo4j driver); **`@cyphra/runtime`** re-exports both for the usual import path.

Example app: [`examples/basic/`](./examples/basic) (`pnpm build` packages first).

If you change the public API of `@cyphra/schema`, run `pnpm build` (or `pnpm --filter @cyphra/schema build`) before `pnpm typecheck` so dependent packages see updated `dist/*.d.ts`. Rebuild **`cyphra`** (`pnpm --filter cyphra build`) when changing any re-exported surface so the meta-package `dist/` stays aligned.

`@cyphra/migrator` Vitest config resolves `@cyphra/schema` (and related packages) to **TypeScript source**, so `pnpm test` stays accurate without rebuilding `dist/` after every schema change. `@cyphra/runtime` tests alias `@cyphra/query` the same way.

Optional **Neo4j-backed** checks — set `NEO4J_TEST_URI`, `NEO4J_TEST_USER`, and `NEO4J_TEST_PASSWORD`, then run:

```bash
pnpm --filter @cyphra/runtime exec vitest run src/client.integration.test.ts
pnpm --filter @cyphra/migrator exec vitest run src/push.integration.test.ts
```

The migrator test applies generated `CREATE CONSTRAINT` / `CREATE RANGE INDEX` DDL twice (idempotent `IF NOT EXISTS`). CI runs both against a Neo4j 5 service container on every push and pull request.

Tests use a root `vitest.config.ts` with `test.projects` pointing at each `packages/*` workspace (see [Vitest projects](https://vitest.dev/config/#projects)). The **`cyphra`** package’s Vitest config aliases `@cyphra/*` to **source** so barrel tests do not depend on stale `dist/`.

## Changesets

User-facing package changes should include a changeset:

```bash
pnpm changeset
```

Publishable packages are **fixed** in [`.changeset/config.json`](./.changeset/config.json): `cyphra` and every `@cyphra/*` release share the **same version**, so the meta-package stays aligned with its dependencies on npm.

## Branches and pull requests

Day-to-day work targets **`dev`**; **`main`** is where versions are bumped and packages are published.

- Create feature or fix branches from **`dev`** (for example `feat/...`, `fix/...`).
- Open **pull requests into `dev`**. CI (see [`.github/workflows/ci.yml`](./.github/workflows/ci.yml)) runs on pushes and PRs to **`main`** and **`dev`**.
- When you are ready to ship: open a **pull request from `dev` into `main`**, get CI green, and merge.
- For any change that should affect the next npm release, add a **changeset** on the branch that will reach `main` (see [Changesets](#changesets) above) so `.changeset/*.md` files land on **`main`** before the Release workflow runs.

Optional on GitHub: **branch protection** on `main` and `dev` (require PRs, required status checks, reviews if you want).

## Releases

Publishing is automated from **`main`** only via [`.github/workflows/release.yml`](./.github/workflows/release.yml). Pushes to **`dev`** do **not** publish to npm. You can also trigger a release run manually from the Actions tab (**workflow_dispatch**).

### Automatic publish (CD)

1. With pending `.changeset/*.md` on **`main`**, the workflow runs [Changesets](https://github.com/changesets/changesets): it opens or updates a PR titled **“chore: version packages”** that applies `pnpm changeset version`.
2. After that PR is merged (another push to **`main`**), if there is nothing left to version, the workflow runs **`pnpm changeset publish`** to npm with **provenance** (`NPM_CONFIG_PROVENANCE`).

The job runs **lint**, **format check**, **typecheck**, and **tests** before the Changesets step so broken code does not get versioned or published.

Configure **npm Trusted Publishers** for this repository so OIDC can authenticate publishes without long-lived `NPM_TOKEN` secrets.

Some organizations block the default `GITHUB_TOKEN` from **creating pull requests** (Changesets opens a “Version Packages” PR). If the Release workflow fails with that error, add a repository secret **`CHANGESET_RELEASE_PAT`**: a fine-grained PAT with **Contents** and **Pull requests** read/write on this repo (or a classic PAT with `repo` scope). The workflow uses it instead of `GITHUB_TOKEN` for the Changesets step. Alternatively, an org owner can allow GitHub Actions to create pull requests for this repository.
