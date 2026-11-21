import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CyphraClient } from "@cyphra/runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CyphraConfig } from "../config.js";
import { runMigrateReset } from "./migrateReset.js";

/**
 * `cyphra migrate reset` empties the WHOLE test database, so this suite also needs
 * CYPHRA_TEST_RESET_DB=1: it must not run alongside other packages' Neo4j tests (root `pnpm test`).
 */
const enabled = Boolean(
  process.env.NEO4J_TEST_URI &&
  process.env.NEO4J_TEST_USER &&
  process.env.NEO4J_TEST_PASSWORD &&
  process.env.CYPHRA_TEST_RESET_DB === "1" &&
  process.env.CYPHRA_TEST_DIALECT !== "memgraph", // see migrateReset.memgraph.integration.test.ts
);

const MIGRATION = "20261121000000_init";

describe.skipIf(!enabled)("cyphra migrate reset (Neo4j)", () => {
  let dir: string;
  let config: CyphraConfig;
  let client: CyphraClient;
  const saved: Record<string, string | undefined> = {};
  const rows = async (text: string) =>
    client.withSession(async (s) => (await s.run(text)).records.map((r) => r.toObject()));

  beforeAll(async () => {
    for (const k of ["NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD", "NEO4J_DATABASE"]) {
      saved[k] = process.env[k];
    }
    process.env.NEO4J_URI = process.env.NEO4J_TEST_URI;
    process.env.NEO4J_USERNAME = process.env.NEO4J_TEST_USER;
    process.env.NEO4J_PASSWORD = process.env.NEO4J_TEST_PASSWORD;
    delete process.env.NEO4J_DATABASE;
    client = new CyphraClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
    });

    dir = await mkdtemp(path.join(tmpdir(), "cyphra-reset-"));
    await mkdir(path.join(dir, "migrations"));
    // A migration as `cyphra migrate dev` would write it (without the `cyphra` import, which this
    // temporary project cannot resolve; the loader only needs `name` and `up`).
    await writeFile(
      path.join(dir, "migrations", `${MIGRATION}.mjs`),
      `export default {
  name: ${JSON.stringify(MIGRATION)},
  async up({ db }) {
    await db.execute("CREATE CONSTRAINT ResetUser_id_unique IF NOT EXISTS FOR (n:ResetUser) REQUIRE n.id IS UNIQUE");
    await db.execute("CREATE VECTOR INDEX ResetDoc_embedding_vector IF NOT EXISTS FOR (n:ResetDoc) ON n.embedding OPTIONS {indexConfig: {\`vector.dimensions\`: 3, \`vector.similarity_function\`: 'cosine'}}");
    await db.execute("CREATE FULLTEXT INDEX resetDocSearch IF NOT EXISTS FOR (n:ResetDoc) ON EACH [n.title]");
  },
};
`,
    );
    // The seed connects with the NEO4J_* variables it inherits from the CLI.
    const driverUrl = pathToFileURL(createRequire(import.meta.url).resolve("neo4j-driver")).href;
    await writeFile(
      path.join(dir, "seed.mjs"),
      `const neo4j = (await import(${JSON.stringify(driverUrl)})).default;
const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD));
await driver.executeQuery("CREATE (:ResetUser {id: 'seeded'})");
await driver.close();
`,
    );
    config = {
      schema: path.join(dir, "schema.cyphra"),
      migrations: path.join(dir, "migrations"),
      generate: path.join(dir, "cyphra.gen.ts"),
      runtimeImport: "cyphra",
      seed: `${JSON.stringify(process.execPath)} seed.mjs`,
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rows("MATCH (n) WHERE n:ResetUser OR n:ResetDoc OR n:Stale DETACH DELETE n");
    for (const c of ["ResetUser_id_unique"]) await rows(`DROP CONSTRAINT ${c} IF EXISTS`);
    for (const i of ["ResetDoc_embedding_vector", "resetDocSearch"]) {
      await rows(`DROP INDEX ${i} IF EXISTS`);
    }
    await client?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("drops data, constraints and every kind of index, reapplies migrations and seeds", async () => {
    // More nodes than one batch, relationships, stale schema objects of each kind, and a
    // migration record that no longer has a file.
    await rows(
      "UNWIND range(1, 12500) AS i CREATE (:Stale {i: i, title: 'x', loc: point({x: i, y: i})})",
    );
    await rows("MATCH (a:Stale {i: 1}), (b:Stale {i: 2}) CREATE (a)-[:LINKS {w: 1}]->(b)");
    await rows("CREATE (:__CyphraMigration {name: 'old', checksum: 'x'})");
    await rows(
      "CREATE CONSTRAINT stale_i_unique IF NOT EXISTS FOR (n:Stale) REQUIRE n.i IS UNIQUE",
    );
    await rows(
      "CREATE CONSTRAINT stale_title_exists IF NOT EXISTS FOR (n:Stale) REQUIRE n.title IS NOT NULL",
    ).catch(
      () => undefined, // existence constraints are Enterprise-only
    );
    await rows("CREATE INDEX stale_title IF NOT EXISTS FOR (n:Stale) ON (n.title)");
    await rows("CREATE TEXT INDEX stale_title_text IF NOT EXISTS FOR (n:Stale) ON (n.title)");
    await rows("CREATE POINT INDEX stale_loc IF NOT EXISTS FOR (n:Stale) ON (n.loc)");
    await rows("CREATE INDEX stale_rel_w IF NOT EXISTS FOR ()-[r:LINKS]-() ON (r.w)");
    await rows("CREATE FULLTEXT INDEX staleSearch IF NOT EXISTS FOR (n:Stale) ON EACH [n.title]");
    await rows(
      "CREATE VECTOR INDEX stale_vec IF NOT EXISTS FOR (n:Stale) ON n.v OPTIONS {indexConfig: {`vector.dimensions`: 2, `vector.similarity_function`: 'euclidean'}}",
    );
    const lookupBefore = await rows(
      "SHOW INDEXES YIELD name, type WHERE type = 'LOOKUP' RETURN name",
    );

    expect(await runMigrateReset(dir, config, { yes: true })).toBe(0);
    await rows("CALL db.awaitIndexes(120)");

    const constraints = (await rows("SHOW CONSTRAINTS YIELD name RETURN name")).map((r) => r.name);
    expect(constraints.sort()).toEqual(["ResetUser_id_unique", "cyphra_migration_name_unique"]);
    const indexes = await rows(
      "SHOW INDEXES YIELD name, type, owningConstraint WHERE owningConstraint IS NULL RETURN name, type",
    );
    expect(
      indexes
        .filter((i) => i.type !== "LOOKUP")
        .map((i) => i.name)
        .sort(),
    ).toEqual(["ResetDoc_embedding_vector", "resetDocSearch"]);
    expect(indexes.filter((i) => i.type === "LOOKUP").length).toBe(lookupBefore.length);

    expect(Number((await rows("MATCH (n:Stale) RETURN count(n) AS c"))[0]!.c)).toBe(0);
    expect(Number((await rows("MATCH ()-[r]->() RETURN count(r) AS c"))[0]!.c)).toBe(0);
    const migrations = await rows("MATCH (m:__CyphraMigration) RETURN m.name AS name");
    expect(migrations.map((m) => m.name)).toEqual([MIGRATION]);
    const users = await rows("MATCH (u:ResetUser) RETURN u.id AS id");
    expect(users.map((u) => u.id)).toEqual(["seeded"]);
  }, 120_000);

  it("skips the seed with skipSeed and propagates a failing seed's exit code", async () => {
    expect(await runMigrateReset(dir, config, { yes: true, skipSeed: true })).toBe(0);
    expect(Number((await rows("MATCH (n) RETURN count(n) AS c"))[0]!.c)).toBe(1); // migration record
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = { ...config, seed: `${JSON.stringify(process.execPath)} -e "process.exit(4)"` };
    expect(await runMigrateReset(dir, failing, { yes: true })).toBe(4);
  }, 120_000);
});
