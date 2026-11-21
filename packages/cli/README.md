# @cyphra/cli

> Part of [Cyphra](https://www.cyphra.dev), the TypeScript ORM for Neo4j. **CLI reference:** [www.cyphra.dev/cli](https://www.cyphra.dev/cli)

Command-line interface for Cyphra.

## Commands

- `cyphra init` — scaffold `cyphra.json`, `schema.cyphra`, `migrations/`, `.env.example`
- `cyphra migrate deploy` / `cyphra migrate dev` — run pending `.mjs` migrations
- `cyphra migration:create <name>` — add a migration stub
- `cyphra push` — apply `@id` / `@unique` constraints from the schema
- `cyphra migrate reset` — empty a local database, reapply every migration, run the seed (`--yes`, `--force`, `--skip-seed`)
- `cyphra db seed` — run the `"seed"` command from `cyphra.json` (e.g. `"tsx seed.ts"`)
- `cyphra generate` — generate the typed client (`--watch` regenerates on schema changes)

## Migrations

Migration files are ESM (`.mjs`) and should import `defineMigration` from **`cyphra`** or `@cyphra/migrator` (library dependency).

## Environment

- `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`
- Optional: `NEO4J_DATABASE`
