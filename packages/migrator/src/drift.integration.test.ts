import { CyphraClient } from "@cyphra/runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  compareSchemaObjects,
  isDriftFree,
  readSchemaObjects,
  replayMigrations,
  type DriftReport,
} from "./drift.js";
import type { LoadedMigration } from "./runner.js";
import { runPendingMigrations } from "./runner.js";

// Each test makes many round trips to Neo4j: the default 5 s is too tight on a busy CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hasNeo = Boolean(
  process.env.NEO4J_TEST_URI && process.env.NEO4J_TEST_USER && process.env.NEO4J_TEST_PASSWORD,
);

const DDL = [
  "CREATE CONSTRAINT DriftUser_id_id IF NOT EXISTS FOR (n:`DriftUser`) REQUIRE n.`id` IS UNIQUE",
  "CREATE CONSTRAINT DriftUser_tenant_handle_unique IF NOT EXISTS FOR (n:`DriftUser`) REQUIRE (n.`tenant`, n.`handle`) IS UNIQUE",
  "CREATE RANGE INDEX DriftUser_name_idx IF NOT EXISTS FOR (n:`DriftUser`) ON (n.`name`)",
  "CREATE POINT INDEX DriftUser_location_idx IF NOT EXISTS FOR (n:`DriftUser`) ON (n.`location`)",
  "CREATE VECTOR INDEX DriftDoc_embedding_vector IF NOT EXISTS FOR (n:`DriftDoc`) ON n.`embedding` OPTIONS {indexConfig: {`vector.dimensions`: 3, `vector.similarity_function`: 'cosine'}}",
  "CREATE FULLTEXT INDEX driftDocSearch IF NOT EXISTS FOR (n:`DriftDoc`) ON EACH [n.`title`, n.`body`] OPTIONS {indexConfig: {`fulltext.analyzer`: 'english'}}",
  "CREATE CONSTRAINT DriftFollows_key_rel_unique IF NOT EXISTS FOR ()-[r:`DRIFT_FOLLOWS`]-() REQUIRE r.`key` IS UNIQUE",
];
const NAMES = [
  "DriftUser_id_id",
  "DriftUser_tenant_handle_unique",
  "DriftUser_name_idx",
  "DriftUser_location_idx",
  "DriftDoc_embedding_vector",
  "driftDocSearch",
  "DriftFollows_key_rel_unique",
  "drift_manual_idx",
];

const migration: LoadedMigration = {
  name: "drift_test_init",
  checksum: "drift",
  definition: {
    name: "drift_test_init",
    async up({ db }) {
      for (const s of DDL) await db.execute(s);
      await db.execute("MATCH (n:DriftUser) WHERE n.tenant IS NULL SET n.tenant = 'x'");
    },
  },
};

describe.skipIf(!hasNeo)("drift detection (Neo4j)", () => {
  const client = hasNeo
    ? new CyphraClient({
        uri: process.env.NEO4J_TEST_URI!,
        user: process.env.NEO4J_TEST_USER!,
        password: process.env.NEO4J_TEST_PASSWORD!,
      })
    : (undefined as unknown as CyphraClient);
  const run = (text: string) => client.withSession(async (s) => (await s.run(text)).records);

  const cleanup = async () => {
    const constraints = await run("SHOW CONSTRAINTS YIELD name RETURN name");
    for (const r of constraints) {
      const name = r.get("name") as string;
      if (NAMES.includes(name)) await run(`DROP CONSTRAINT ${name} IF EXISTS`);
    }
    for (const name of NAMES) await run(`DROP INDEX ${name} IF EXISTS`);
    await run("MATCH (m:__CyphraMigration {name: 'drift_test_init'}) DELETE m");
  };

  /** Drift restricted to this suite's labels (other suites share the database). */
  const drift = async (): Promise<DriftReport> => {
    const { objects, warnings } = await replayMigrations([migration]);
    expect(warnings).toEqual([]);
    const ours = (await readSchemaObjects(client)).filter((o) =>
      o.labelsOrTypes.some((l) => l.startsWith("Drift") || l.startsWith("DRIFT")),
    );
    return compareSchemaObjects(objects, ours);
  };

  beforeAll(async () => {
    await cleanup();
    expect(await runPendingMigrations(client, [migration])).toEqual(["drift_test_init"]);
  });

  afterAll(async () => {
    await cleanup();
    await client?.close();
  });

  it("is in sync right after the migration", async () => {
    const report = await drift();
    expect(report).toEqual({ extra: [], missing: [], changed: [] });
    expect(isDriftFree(report)).toBe(true);
  });

  it("detects an extra index, a dropped constraint and an altered vector index", async () => {
    await run("CREATE TEXT INDEX drift_manual_idx IF NOT EXISTS FOR (n:DriftUser) ON (n.bio)");
    await run("DROP CONSTRAINT DriftUser_tenant_handle_unique");
    await run("DROP INDEX DriftDoc_embedding_vector");
    await run(
      "CREATE VECTOR INDEX DriftDoc_embedding_vector FOR (n:DriftDoc) ON n.embedding OPTIONS {indexConfig: {`vector.dimensions`: 4, `vector.similarity_function`: 'euclidean'}}",
    );
    await run("DROP INDEX DriftUser_location_idx");
    await run("CREATE RANGE INDEX DriftUser_location_idx FOR (n:DriftUser) ON (n.location)");

    const report = await drift();
    expect(report.extra.map((o) => [o.name, o.type])).toEqual([["drift_manual_idx", "TEXT"]]);
    expect(report.missing.map((o) => o.name)).toEqual(["DriftUser_tenant_handle_unique"]);
    expect(Object.fromEntries(report.changed.map((c) => [c.expected.name, c.differences]))).toEqual(
      {
        DriftUser_location_idx: ["type: POINT → RANGE"],
        DriftDoc_embedding_vector: ["dimensions: 3 → 4", "similarity: cosine → euclidean"],
      },
    );
  });
});
