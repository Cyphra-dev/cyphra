/**
 * startDatabase() with Testcontainers: needs Docker, so it is opt-in. CYPHRA_TEST_CONTAINERS lists
 * the dialects to start (`neo4j,memgraph,falkordb`; `1` means `neo4j`).
 */
import { describe, expect, it } from "vitest";
import { createTestDatabase, dropSchema, startDatabase, wipeDatabase } from "../src/index.js";
import { createClient } from "./fixtures/shop.gen.js";
import { users } from "./factories.js";

const requested = process.env.CYPHRA_TEST_CONTAINERS ?? "";
const dialects = (requested === "1" ? "neo4j" : requested)
  .split(",")
  .map((d) => d.trim())
  .filter((d): d is "neo4j" | "memgraph" | "falkordb" =>
    ["neo4j", "memgraph", "falkordb"].includes(d),
  );

// One skipped suite when none is requested (an empty `each` would leave the file without tests).
describe.skipIf(dialects.length === 0).each(dialects.length ? dialects : ["neo4j" as const])(
  "startDatabase (%s)",
  (dialect) => {
    it(
      "starts a container, migrates it, wipes and drops its schema, and stops it",
      { timeout: 600_000 },
      async () => {
        const testDb = createTestDatabase({
          // Ignore NEO4J_TEST_URI & co.: always start a container here.
          connection: undefined,
          container: { dialect, name: `cy-testing-tc-${dialect}-${process.pid}` },
          schema: new URL("./fixtures/shop.cyphra", import.meta.url),
          migrations: new URL("./fixtures/migrations", import.meta.url),
          createClient,
          fresh: true,
        });
        const saved = { ...process.env };
        for (const key of ["NEO4J_TEST_URI", "FALKORDB_TEST_URL"]) delete process.env[key];
        try {
          const { migrations, statements } = await testDb.setup();
          expect(testDb.container?.dialect).toBe(dialect);
          expect(migrations).toEqual(["001_tst_settings"]);
          expect(statements).toBeGreaterThan(0);
          await users.create(testDb.db, { email: "a@example.com" });
          await expect(users.create(testDb.db, { email: "a@example.com" })).rejects.toThrow();

          await testDb.reset();
          expect(await testDb.db.tstUser.count()).toBe(0);
          // The migration record survives a default wipe…
          expect(await testDb.db.$cypher`MATCH (m:__CyphraMigration) RETURN count(m) AS n`).toEqual(
            [{ n: 1 }],
          );
          // …and not a full one; then nothing is left of the schema either.
          await wipeDatabase(testDb.db, { keepMigrations: false });
          expect(await testDb.db.$cypher`MATCH (n) RETURN count(n) AS n`).toEqual([{ n: 0 }]);
          const dropped = await dropSchema(testDb.db);
          expect(dropped.constraints).toBeGreaterThan(0);
          await users.create(testDb.db, { email: "a@example.com" });
          await users.create(testDb.db, { email: "a@example.com" });

          const second = await startDatabase({
            dialect,
            name: `cy-testing-tc2-${dialect}-${process.pid}`,
          });
          expect(second.env).toMatchObject(
            dialect === "falkordb"
              ? { FALKORDB_TEST_URL: expect.any(String) }
              : { NEO4J_TEST_URI: expect.any(String) },
          );
          await second.stop();
        } finally {
          process.env = saved;
          await testDb.teardown();
        }
      },
    );
  },
);
