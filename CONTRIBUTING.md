# Contributing

## Setup

- Node 20+
- [pnpm](https://pnpm.io/) 9+

**Project links:** documentation **[www.cyphra.dev](https://www.cyphra.dev)** · monorepo **[github.com/cyphra-dev/cyphra](https://github.com/cyphra-dev/cyphra)**

The repo includes **[`.editorconfig`](./.editorconfig)** (spacing, newlines) and **[`.vscode/extensions.json`](./.vscode/extensions.json)** (recommended ESLint, Prettier, MDX extensions for VS Code).

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

Documentation lives in [`doc/`](./doc) (Next.js + Nextra). Sidebar order and section titles are defined in [`doc/app/_meta.tsx`](./doc/app/_meta.tsx); new top-level routes need a matching `page.mdx`, an entry in that file, and the same path segment in [`doc/lib/sitemap-paths.ts`](./doc/lib/sitemap-paths.ts) so the sitemap stays accurate.

The **`cyphra`** meta-package and all **`@cyphra/*`** libraries are versioned and published together (see [Changesets](#changesets)).

Imports: prefer **`import { query, orm, loadConfig, loadCyphraWorkspace } from "cyphra"`** for the two product tracks (Cypher-JS vs schema ORM) and workspace bootstrap. Tree-shake with subpaths **`import … from "cyphra/query"`** or **`"cyphra/orm"`** (mirrors the **`query`** / **`orm`** namespace objects). Shared config loading for CLI and apps lives in **`@cyphra/config`**.

Example app: [`examples/basic/`](./examples/basic) (`pnpm build` packages first).

### Query stack: when to use what

Execution always goes through **`CompiledCypher`** (same Neo4j driver path). Choose the layer that matches how much control you need:

1. **`@cyphra/orm`** — object-shaped reads and writes when the pattern fits (for example `queryRecordsRootOptionalOutgoing` and `runCreateLinkedNodesTx` in [`packages/orm/src/graphOps.ts`](./packages/orm/src/graphOps.ts)), schema-backed CRUD, and Prisma-like **`createSchemaClient`** (`db.posts.create({ data })` — see [`packages/orm/src/schemaClient.ts`](./packages/orm/src/schemaClient.ts)).
2. **Structured query helpers in `@cyphra/query`** — `compileRootOptionalOutgoingSelect`, `buildReturnRawFieldsMap`, `compileCreateLinkedNodes` (see [`packages/query/src/graphQuery.ts`](./packages/query/src/graphQuery.ts)) when you want composable Cypher without pasting full `MATCH` / `OPTIONAL MATCH` / map projection strings.
3. **Fluent read chain (`createFluentQueryRoot`, `CyphraClient.query.match`)** — [`packages/query/src/fluentReadQuery.ts`](./packages/query/src/fluentReadQuery.ts): `MATCH` + optional outgoing + `WHERE` compiled with `select()`; run via an injected `readQuery` (for example **`CyphraClient.readQuery`**). Distinct from the static namespace **`import { query } from "cyphra"`** (`query.select`, `query.cypher`, …).
4. **Fluent `select()` + typed predicates** — full control over clauses while keeping literals parameterized.
5. **`cypher` tag** — small ad hoc fragments with interpolation still turned into parameters.
6. **Hand-reviewed Cypher strings** — last resort for anything the DSL does not model yet.

If you change the public API of `@cyphra/schema`, run `pnpm build` (or `pnpm --filter @cyphra/schema build`) before `pnpm typecheck` so dependent packages see updated `dist/*.d.ts`. Rebuild **`cyphra`** (`pnpm --filter cyphra build`) when changing any re-exported surface so the meta-package `dist/` stays aligned. After changing **`@cyphra/query`**, rebuild it before typechecking **`@cyphra/orm`** (ORM’s published types re-export query symbols from `dist/`).

`@cyphra/migrator` Vitest config resolves `@cyphra/schema` (and related packages) to **TypeScript source**, so `pnpm test` stays accurate without rebuilding `dist/` after every schema change. `@cyphra/runtime` tests alias `@cyphra/query` the same way. `@cyphra/orm` tests alias `@cyphra/query` to source for the same reason.

Optional **Neo4j-backed** checks — set `NEO4J_TEST_URI`, `NEO4J_TEST_USER`, and `NEO4J_TEST_PASSWORD`, then run:

```bash
pnpm --filter @cyphra/provider-neo4j exec vitest run src/client.integration.test.ts
pnpm --filter @cyphra/migrator exec vitest run src/push.integration.test.ts
```

**Testcontainers** (`@cyphra/provider-neo4j`, `src/client.testcontainers.test.ts`) needs Docker. To skip locally: `CYPHRA_SKIP_TESTCONTAINERS=1 pnpm test`.

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

Shared **install → build → lint → format → typecheck → test → smoke** steps live in [`.github/workflows/quality-reusable.yml`](./.github/workflows/quality-reusable.yml); [CI](.github/workflows/ci.yml) and [Release](.github/workflows/release.yml) both call it so checks stay in one place.

The Release job then **builds** again and runs Changesets. For **`pnpm changeset publish`**, add the repository secret **`NPM_TOKEN`** (npm automation token with publish access); the workflow mirrors it to **`NODE_AUTH_TOKEN`** for `setup-node`. If the org uses **npm Trusted Publishers** (OIDC) for this repo, you may be able to rely on OIDC instead of a long-lived token—see npm’s trusted publishing docs.

## VS Code extension (maintainers)

The folder is [`extensions/vscode-cyphra/`](./extensions/vscode-cyphra/). Marketplace extension id: **`Cyphra.cyphra-vscode`** (`package.json` name: **`cyphra-vscode`**).

### Package a `.vsix`

From the monorepo root:

```bash
pnpm --filter cyphra-vscode run package
```

Install locally: VS Code → **Extensions** → **…** → **Install from VSIX…** and choose `cyphra-vscode-<version>.vsix` under `extensions/vscode-cyphra/`.  
Or use **Developer: Install Extension from Location…** and select `extensions/vscode-cyphra`.

### Publish to the Visual Studio Marketplace

Use [`@vscode/vsce`](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) with a Personal Access Token (Azure DevOps, scope **Marketplace → Manage**, organization **All accessible organizations**).

1. Create a [publisher](https://marketplace.visualstudio.com/manage) matching the `publisher` field in `extensions/vscode-cyphra/package.json`.
2. For GitHub Actions, set the repository secret `VSCE_PAT`, or publish locally:

   ```bash
   cd extensions/vscode-cyphra
   pnpm exec vsce login <publisher>
   pnpm exec vsce publish
   ```

Upload only **`cyphra-vscode-<version>.vsix`** from the `package` script. Do not publish a stray `vscode-cyphra-*.vsix` — that id conflicts globally on the Marketplace.

### Open VSX (optional)

For the Open VSX registry, use [`ovsx`](https://github.com/eclipse/openvsx) with `OVSX_PAT`.

### Releases from Git tags

Pushing a tag matching `vscode-v*` (e.g. `vscode-v0.2.0`) triggers [`.github/workflows/vscode-extension-publish.yml`](./.github/workflows/vscode-extension-publish.yml). Bump `version` in `extensions/vscode-cyphra/package.json` to match before tagging, or `vsce` will reject the upload.

Some organizations block the default `GITHUB_TOKEN` from **creating pull requests** (Changesets opens a “Version Packages” PR). If the Release workflow fails with that error, add a repository secret **`CHANGESET_RELEASE_PAT`**: a fine-grained PAT with **Contents** and **Pull requests** read/write on this repo (or a classic PAT with `repo` scope). The workflow uses it instead of `GITHUB_TOKEN` for the Changesets step. Alternatively, an org owner can allow GitHub Actions to create pull requests for this repository.
