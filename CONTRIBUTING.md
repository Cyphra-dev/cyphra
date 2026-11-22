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

Publishable packages: **`@cyphra/schema`** (`.cyphra` parser, validation, codegen), **`@cyphra/query`** (Cypher templates and builder), **`@cyphra/runtime`** (Neo4j client), **`@cyphra/migrator`** (migrations and `push`), **`@cyphra/cli`**, and the **`cyphra`** meta-package that re-exports the libraries.

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

Choose the bump (`major`, `minor`, `patch`) with the [stability policy](./STABILITY.md) (draft for 1.0): it lists what is public API, what counts as a breaking change, and how to deprecate.

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

### New npm packages

npm trusted publishing can only be configured on a package that already exists. Before the first release that contains a new package (for example `@cyphra/language-server`), publish it once by hand from an npm account with access to the `@cyphra` scope (`pnpm --filter <name> publish --access public` after a build), then add this repository as its Trusted Publisher on npmjs.com, so later releases go through the Release workflow.

### VS Code extension

`packages/vscode` (`cyphra-vscode`, private on npm and ignored by Changesets) is the VS Code extension; it bundles `@cyphra/language-server`. CI builds `packages/vscode/cyphra-vscode.vsix` on every run and uploads it as the `cyphra-vscode-vsix` artifact. Version it by hand (`version` in `packages/vscode/package.json`, plus `packages/vscode/CHANGELOG.md`).

Publishing is manual, with [`.github/workflows/vscode-publish.yml`](./.github/workflows/vscode-publish.yml) (Actions tab, **Publish VS Code extension**, **Run workflow**; choose `both`, `marketplace` or `open-vsx`). One-time setup:

1. **Visual Studio Marketplace.** Create a publisher at <https://marketplace.visualstudio.com/manage> (its ID must equal `publisher` in `packages/vscode/package.json`, currently the placeholder `cyphra`: change one or the other). In Azure DevOps (<https://dev.azure.com>, same Microsoft account), create a personal access token with organization **All accessible organizations** and scope **Marketplace > Manage**. Save it as the repository secret **`VSCE_PAT`**.
2. **Open VSX.** Sign in at <https://open-vsx.org> with GitHub, sign the Eclipse Foundation publisher agreement (profile page), and create an access token (Settings > Access Tokens). Create the namespace once: `npx ovsx create-namespace <publisher> -p <token>` (same name as `publisher`). Save the token as the repository secret **`OVSX_PAT`**.

A target whose secret is missing is skipped with a warning. To publish by hand instead: `pnpm --filter cyphra-vscode run package`, then `npx @vscode/vsce publish --no-dependencies --packagePath packages/vscode/cyphra-vscode.vsix` (with `VSCE_PAT` set) and `npx ovsx publish packages/vscode/cyphra-vscode.vsix -p <token>`.

## Dependency audit exceptions

`pnpm audit --audit-level=high` runs in CI. Exceptions live in `pnpm.auditConfig.ignoreGhsas` in the root `package.json` and must be listed here:

- **GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6)**: only reached through `nextra` / `nextra-theme-docs` in the docs site. They are pinned to zod 4.3.6 (`pnpm.overrides`) because Nextra 4.6.1 fails to prerender with zod 4.6.x. The advisory concerns validating attacker-controlled oversized collections, while Nextra only validates our own component props at build time. Remove the override and the exception once Nextra supports zod ≥ 4.6.6.
