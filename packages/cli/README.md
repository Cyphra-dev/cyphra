# @cyphra/cli

Command-line interface for Cyphra.

## Commands

- `cyphra init` — scaffold `cyphra.json`, `schema.cyphra`, `migrations/`, `.env.example`
- `cyphra migrate deploy` / `cyphra migrate dev` — run pending `.mjs` migrations
- `cyphra migration:create <name>` — add a migration stub
- `cyphra push` — apply `@id` / `@unique` constraints from the schema
- `cyphra generate` — reserved (not implemented)

## Migrations

Migration files are ESM (`.mjs`) and should import `defineMigration` from `@cyphra/migrator` (add that dependency to your app).

## Environment

- `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`
- Optional: `NEO4J_DATABASE`
