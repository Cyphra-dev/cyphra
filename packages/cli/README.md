# @cyphra/cli

Command-line interface for Cyphra projects (Neo4j + `.cyphra`).

Installing the **`cyphra`** meta-package includes this package and exposes the **`cyphra`** binary. To add only the CLI (e.g. for tooling repos): `npm add -D @cyphra/cli`.

## Common commands

| Command                                 | Purpose                                                         |
| --------------------------------------- | --------------------------------------------------------------- |
| `cyphra init`                           | Scaffold config, `schema.cyphra`, `migrations/`, `.env.example` |
| `cyphra validate`                       | Parse and validate the schema                                   |
| `cyphra schema print`                   | Canonical schema text to stdout                                 |
| `cyphra schema ddl`                     | Print constraint/index DDL (no DB)                              |
| `cyphra schema add`                     | Add a `node` block (interactive or `--json`)                    |
| `cyphra db pull` / `cyphra db-pull`     | Draft schema from a live Neo4j instance                         |
| `cyphra push`                           | Apply schema constraints and indexes                            |
| `cyphra migrate deploy` / `migrate dev` | Run pending migrations                                          |
| `cyphra migration:create <name>`        | Create a new migration file                                     |

Configuration is read from **`cyphra.config.ts`** (preferred) or **`cyphra.json`**. Commands that connect to Neo4j need **`NEO4J_URI`**, **`NEO4J_USER`**, and **`NEO4J_PASSWORD`** (optional **`NEO4J_DATABASE`**).

## Migrations

Migration modules are **ESM** (`.mjs`) and use **`defineMigration`** from **`cyphra`** or **`@cyphra/migrator`**.

## Docs

**[cyphra.dev — CLI](https://www.cyphra.dev/cli)**

## License

MIT
