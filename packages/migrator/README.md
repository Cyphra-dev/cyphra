# @cyphra/migrator

> Part of [Cyphra](https://www.cyphra.dev), the TypeScript ORM for Neo4j. **Migrations docs:** [www.cyphra.dev/migrations](https://www.cyphra.dev/migrations)

Versioned Neo4j migrations and schema push for Cyphra.

```ts
import { defineMigration, runPendingMigrations } from "@cyphra/migrator";
import { CyphraClient } from "@cyphra/runtime";

export default defineMigration({
  name: "001_example",
  async up({ db }) {
    await db.run`RETURN 1`;
  },
});
```

Tracking node: `(:__CyphraMigration { name, appliedAt, checksum })`.
