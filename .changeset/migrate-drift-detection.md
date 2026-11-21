---
"@cyphra/migrator": minor
"@cyphra/cli": minor
---

Schema drift detection: `cyphra migrate status` now compares the database's constraints and indexes with the ones the applied migrations created.

- **Migrator**: `detectDrift`, `replayMigrations` (runs each applied migration's `up()` against a recording `db` handle that never touches the database and keeps its `CREATE` / `DROP` constraint and index statements), `parseDdlStatement`, `expectedSchemaFromStatements`, `expectedSchemaFromModel`, `readSchemaObjects` (`SHOW CONSTRAINTS` / `SHOW INDEXES`, read-only), `schemaObjectsFromShow`, `compareSchemaObjects` and `describeSchemaObject`. Reports objects that are **extra** (in the database only), **missing** (created by migrations, absent) or **changed** (labels, properties, index or constraint type, vector dimensions / similarity / quantization, full-text analyzer / consistency, or name). `LOOKUP` indexes, constraint-backing indexes and Cyphra's bookkeeping constraint are ignored.
- **CLI**: `cyphra migrate status` lists migrations (`applied`, `pending`, `modified` by checksum, `missing`), uncaptured schema changes and drift. `--json` prints one JSON document; `--schema` compares with `schema.cyphra` instead of the migrations. Exit codes: `0` in sync, `1` drift or anything pending, `2` when the check could not run. `cyphra migrate dev` warns about drift before generating a migration and suggests `cyphra migrate reset` in development.
