# @cyphra/testing

> Part of [Cyphra](https://www.cyphra.dev), the TypeScript ORM for Neo4j. **Testing:** [docs](https://www.cyphra.dev/testing)

Integration-test helpers for apps built on Cyphra. They do not depend on a test framework, so they
work with Vitest, Jest, `node:test` or Mocha:

- **`startDatabase()`**: Neo4j (default), Memgraph or FalkorDB in Docker, through
  [Testcontainers](https://testcontainers.com).
- **`applySchema()`**: runs your migrations, then creates the schema's constraints and indexes.
- **`withRollback()`** and **`wipeDatabase()`**: isolate tests with a transaction that is always
  rolled back, or by deleting the test data. Both work on Neo4j Community, which has a single user
  database.
- **`defineFactory()`**: typed factories for the generated models, with sequences and relation
  helpers.
- **`createTestDatabase()`**: all of the above behind `setup` / `reset` / `teardown` hooks.

```bash
npm i -D @cyphra/testing testcontainers
```

```ts
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createTestDatabase, factoriesFor } from "@cyphra/testing";
import { createClient, type CyphraTypeMap } from "./cyphra.gen";

const testDb = createTestDatabase({
  schema: new URL("./schema.cyphra", import.meta.url),
  migrations: new URL("./migrations", import.meta.url),
  createClient,
});

const { defineFactory } = factoriesFor<CyphraTypeMap>();
const users = defineFactory("User", ({ sequence }) => ({ email: `user${sequence}@example.com` }));

beforeAll(() => testDb.setup()); // NEO4J_TEST_URI & co., else a new container
beforeEach(() => testDb.reset());
afterAll(() => testDb.teardown());

it("finds a user by email", async () => {
  await users.create(testDb.db, { email: "ada@example.com" });
  expect(await testDb.db.user.findUnique({ where: { email: "ada@example.com" } })).not.toBeNull();
});
```

`testcontainers` is only needed to start containers: with `NEO4J_TEST_URI`, `NEO4J_TEST_USER` and
`NEO4J_TEST_PASSWORD` set (for example a CI service container), the tests use that database.

See the [documentation](https://www.cyphra.dev/testing) for the Vitest global setup, Jest,
Memgraph and FalkorDB.

## License

MIT
