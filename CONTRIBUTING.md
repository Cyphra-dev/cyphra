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

Example app: [`examples/basic/`](./examples/basic) (`pnpm build` packages first).

If you change the public API of `@cyphra/schema`, run `pnpm build` (or `pnpm --filter @cyphra/schema build`) before `pnpm typecheck` so dependent packages see updated `dist/*.d.ts`.

`@cyphra/migrator` Vitest config resolves `@cyphra/schema` (and related packages) to **TypeScript source**, so `pnpm test` stays accurate without rebuilding `dist/` after every schema change. `@cyphra/runtime` tests alias `@cyphra/query` the same way.

Optional **Neo4j-backed** checks — set `NEO4J_TEST_URI`, `NEO4J_TEST_USER`, and `NEO4J_TEST_PASSWORD`, then run:

```bash
pnpm --filter @cyphra/runtime exec vitest run src/client.integration.test.ts
pnpm --filter @cyphra/migrator exec vitest run src/push.integration.test.ts
```

The migrator test applies generated `CREATE CONSTRAINT` / `CREATE RANGE INDEX` DDL twice (idempotent `IF NOT EXISTS`). CI runs both against a Neo4j 5 service container on every push and pull request.

Tests use a root `vitest.config.ts` with `test.projects` pointing at each `packages/*` workspace (see [Vitest projects](https://vitest.dev/config/#projects)).

## Changesets

User-facing package changes should include a changeset:

```bash
pnpm changeset
```

## Releases

Publishing is automated from `main` via GitHub Actions when changesets are present. Configure **npm Trusted Publishers** for this repository so OIDC can authenticate publishes without long-lived `NPM_TOKEN` secrets.
