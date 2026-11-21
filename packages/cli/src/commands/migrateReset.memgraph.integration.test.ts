import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CyphraClient } from "@cyphra/runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CyphraConfig } from "../config.js";
import { runMigrateReset } from "./migrateReset.js";

/**
 * `cyphra migrate reset` on Memgraph: empties the WHOLE test database (CYPHRA_TEST_RESET_DB=1),
 * with the dialect detected from the server (cyphra.json sets none here) and a migration written
 * in Neo4j's DDL syntax, translated when it runs.
 */
const enabled = Boolean(
  process.env.NEO4J_TEST_URI &&
  process.env.NEO4J_TEST_USER &&
  process.env.NEO4J_TEST_PASSWORD &&
  process.env.CYPHRA_TEST_RESET_DB === "1" &&
  process.env.CYPHRA_TEST_DIALECT === "memgraph",
);

const MIGRATION = "20261121000000_init";

describe.skipIf(!enabled)("cyphra migrate reset (Memgraph)", () => {
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
      dialect: "memgraph",
    });
    dir = await mkdtemp(path.join(tmpdir(), "cyphra-reset-mg-"));
    await mkdir(path.join(dir, "migrations"));
    await writeFile(
      path.join(dir, "migrations", `${MIGRATION}.mjs`),
      `export default {
  name: ${JSON.stringify(MIGRATION)},
  async up({ db }) {
    await db.execute("CREATE CONSTRAINT ResetUser_id_id IF NOT EXISTS FOR (n:\`ResetUser\`) REQUIRE n.\`id\` IS UNIQUE");
    await db.execute("CREATE RANGE INDEX ResetUser_name_idx IF NOT EXISTS FOR (n:\`ResetUser\`) ON (n.\`name\`)");
  },
};
`,
    );
    config = {
      schema: path.join(dir, "schema.cyphra"),
      migrations: path.join(dir, "migrations"),
      generate: path.join(dir, "cyphra.gen.ts"),
      runtimeImport: "cyphra",
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rows("MATCH (n) WHERE n:ResetUser OR n:Stale DETACH DELETE n");
    await rows("DROP CONSTRAINT ON (n:ResetUser) ASSERT n.id IS UNIQUE");
    await rows("DROP INDEX ON :ResetUser(name)");
    await client?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("drops data and every kind of constraint and index, then reapplies migrations", async () => {
    await rows(
      "UNWIND range(1, 300) AS i CREATE (:Stale {i: i, title: 'x', loc: point({x: i, y: i})})",
    );
    await rows("MATCH (a:Stale {i: 1}), (b:Stale {i: 2}) CREATE (a)-[:LINKS {w: 1}]->(b)");
    await rows("MERGE (:__CyphraMigration {name: 'old', checksum: 'x'})");
    for (const ddl of [
      "CREATE CONSTRAINT ON (n:Stale) ASSERT n.i IS UNIQUE",
      "CREATE CONSTRAINT ON (n:Stale) ASSERT EXISTS (n.title)",
      "CREATE CONSTRAINT ON (n:Stale) ASSERT n.title IS TYPED STRING",
      "CREATE INDEX ON :Stale(title)",
      "CREATE INDEX ON :Stale",
      "CREATE POINT INDEX ON :Stale(loc)",
      "CREATE EDGE INDEX ON :LINKS(w)",
      "CREATE EDGE INDEX ON :LINKS",
      "CREATE VECTOR INDEX stale_vec ON :Stale(v) WITH CONFIG {'dimension': 2, 'capacity': 100, 'metric': 'l2sq'}",
    ]) {
      await rows(ddl);
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await runMigrateReset(dir, config, { yes: true, skipSeed: true })).toBe(0);
    // No dialect in the config: detected, with a note to set it.
    expect(warn.mock.calls.flat().join("\n")).toMatch(/"dialect": "memgraph"/);

    const constraints = await rows("SHOW CONSTRAINT INFO");
    expect(constraints.map((c) => `${c.label}(${String(c.properties)})`).sort()).toEqual([
      "ResetUser(id)",
      "__CyphraMigration(name)",
    ]);
    const indexes = await rows("SHOW INDEX INFO");
    expect(indexes.map((i) => `${i["index type"]} ${i.label}(${String(i.property)})`)).toEqual([
      "label+property ResetUser(name)",
    ]);
    expect(Number((await rows("MATCH (n:Stale) RETURN count(n) AS c"))[0]!.c)).toBe(0);
    const migrations = await rows("MATCH (m:__CyphraMigration) RETURN m.name AS name");
    expect(migrations.map((m) => m.name)).toEqual([MIGRATION]);
  }, 120_000);
});
