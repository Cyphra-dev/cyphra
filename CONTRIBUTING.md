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
```

If you change the public API of `@cyphra/schema`, run `pnpm build` (or `pnpm --filter @cyphra/schema build`) before `pnpm typecheck` so dependent packages see updated `dist/*.d.ts`.

`@cyphra/migrator` Vitest config resolves `@cyphra/schema` (and related packages) to **TypeScript source**, so `pnpm test` stays accurate without rebuilding `dist/` after every schema change. `@cyphra/runtime` tests alias `@cyphra/query` the same way.

Tests use a root `vitest.config.ts` with `test.projects` pointing at each `packages/*` workspace (see [Vitest projects](https://vitest.dev/config/#projects)).

## Changesets

User-facing package changes should include a changeset:

```bash
pnpm changeset
```

## Releases

Publishing is automated from `main` via GitHub Actions when changesets are present. Configure **npm Trusted Publishers** for this repository so OIDC can authenticate publishes without long-lived `NPM_TOKEN` secrets.
