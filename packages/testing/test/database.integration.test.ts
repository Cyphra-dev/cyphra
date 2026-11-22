/**
 * The helpers against a real database: the one named by NEO4J_TEST_URI / _USER / _PASSWORD (or
 * FALKORDB_TEST_URL), with CYPHRA_TEST_DIALECT for Memgraph and FalkorDB. Only `Tst*` nodes and
 * the fixture's migration record are touched, so it can share the database with other suites.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  applySchema,
  connectionFromEnv,
  createTestDatabase,
  hasTestDatabase,
  resetSequences,
  wipeDatabase,
  withRollback,
} from "../src/index.js";
import { createClient, type TstUser } from "./fixtures/shop.gen.js";
import { posts, tags, users } from "./factories.js";

const LABELS = ["TstUser", "TstPost", "TstTag", "TstSetting"];
const onFalkorDB = connectionFromEnv()?.dialect === "falkordb";

describe.skipIf(!hasTestDatabase())("@cyphra/testing on a database", () => {
  const testDb = createTestDatabase({
    schema: new URL("./fixtures/shop.cyphra", import.meta.url),
    migrations: new URL("./fixtures/migrations", import.meta.url),
    createClient,
    container: false,
    wipe: { labels: LABELS },
  });
  let applied: readonly string[];

  beforeAll(async () => {
    // Forget an earlier run's migration record, so setup() applies the fixture migration again.
    const pre = createTestDatabase({ container: false });
    await pre.setup();
    await pre.client.withSession((s) =>
      s.run("MATCH (m:__CyphraMigration {name: '001_tst_settings'}) DETACH DELETE m"),
    );
    await wipeDatabase(pre.client, { labels: LABELS });
    await pre.teardown();
    applied = (await testDb.setup()).migrations;
  });
  beforeEach(async () => {
    await testDb.reset({ labels: ["TstUser", "TstPost", "TstTag"] });
    resetSequences();
  });
  afterAll(() => testDb.teardown());

  it("applies the migrations once, then the schema's constraints", async () => {
    expect(applied).toEqual(["001_tst_settings"]);
    expect(await testDb.db.$cypher`MATCH (s:TstSetting) RETURN s.value AS value`).toEqual([
      { value: "dark" },
    ]);
    const again = await applySchema(testDb.db, {
      schema: new URL("./fixtures/shop.cyphra", import.meta.url),
      migrations: new URL("./fixtures/migrations", import.meta.url),
    });
    expect(again.migrations).toEqual([]);
    expect(again.statements).toBeGreaterThan(0);
    await users.create(testDb.db, { email: "taken@example.com" });
    // The unique constraint on TstUser.email exists.
    await expect(users.create(testDb.db, { email: "taken@example.com" })).rejects.toThrow();
  });

  it("creates records with factories, nested relations included", async () => {
    const ada = await users.create(testDb.db, { name: "Ada" });
    expectTypeOf(ada).toEqualTypeOf<TstUser>();
    expect(ada).toMatchObject({ name: "Ada", email: "user1@example.com", role: "member" });
    await posts.create(testDb.db, {
      author: users.connect({ id: ada.id }),
      tags: tags.nestedList(2),
    });
    await posts.createList(testDb.db, 2);
    const found = await testDb.db.tstPost.findMany({
      include: { author: true, tags: true },
      orderBy: { title: "asc" },
    });
    expect(found.map((p) => [p.title, p.author?.name, p.tags.length])).toEqual([
      ["Post 1", "Ada", 2],
      ["Post 2", "User 2", 0],
      ["Post 3", "User 3", 0],
    ]);
    expect(await testDb.db.tstUser.count()).toBe(3);
  });

  it("reset() deletes the test data and keeps the rest", async () => {
    await users.createList(testDb.db, 3);
    await testDb.reset({ labels: ["TstUser"] });
    expect(await testDb.db.tstUser.count()).toBe(0);
    expect(await testDb.db.$cypher`MATCH (s:TstSetting) RETURN count(s) AS n`).toEqual([{ n: 1 }]);
  });

  it.skipIf(onFalkorDB)("withRollback undoes every write made through tx", async () => {
    const result = await withRollback(testDb.db, async (tx) => {
      await users.create(tx, { name: "Temp" });
      await posts.create(tx);
      expect(await tx.tstUser.count()).toBe(2);
      return "done";
    });
    expect(result).toBe("done");
    expect(await testDb.db.tstUser.count()).toBe(0);
    expect(await testDb.db.tstPost.count()).toBe(0);

    // The low-level client too.
    await withRollback(testDb.client, async (tx) => {
      await tx.run("CREATE (:TstTag {name: 'raw'})");
    });
    expect(await testDb.db.tstTag.count()).toBe(0);
  });

  it.skipIf(onFalkorDB)("withRollback rethrows the errors of the work", async () => {
    await expect(
      withRollback(testDb.db, async (tx) => {
        await users.create(tx);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await testDb.db.tstUser.count()).toBe(0);
  });
});
