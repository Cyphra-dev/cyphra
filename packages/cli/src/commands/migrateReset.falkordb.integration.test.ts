import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CyphraClient } from "@cyphra/runtime";
import { readFalkorDBSchemaObjects } from "@cyphra/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig, type CyphraConfig } from "../config.js";
import { createMigrationFromSchema } from "./migrateDev.js";
import { runMigrate } from "./migrate.js";
import { migrateStatusReport } from "./migrateStatus.js";
import { runMigrateReset } from "./migrateReset.js";
import { runPull } from "./pull.js";
import { runPush } from "./push.js";

/**
 * The CLI on FalkorDB (`"dialect": "falkordb"`, `FALKORDB_URL` / `FALKORDB_GRAPH`): push, migrate
 * dev / deploy, status, reset and pull, on its own graph (`cyphra_cli_test`).
 */
const enabled =
  process.env.CYPHRA_TEST_DIALECT === "falkordb" && Boolean(process.env.FALKORDB_TEST_URL);

const GRAPH = "cyphra_cli_test";

const SCHEMA = `node CliUser {
  id    String @id
  email String @unique
  name  String @index
  embedding Vector(3)? @vectorIndex(similarity: cosine)
  posts CliPost[] @relationship(type: "CLI_WROTE", direction: OUT)

  @@fulltext([name], name: "cliUserSearch")
}

node CliPost {
  id    String @id
  title String
  author CliUser? @relationship(type: "CLI_WROTE", direction: IN)
}
`;

describe.skipIf(!enabled)("cyphra CLI on FalkorDB", () => {
  let dir: string;
  let config: CyphraConfig;
  let client: CyphraClient;
  const saved: Record<string, string | undefined> = {};
  const rows = async (text: string) =>
    client.withSession(async (s) => (await s.run(text)).records.map((r) => r.toObject()));
  const objects = async () =>
    (await readFalkorDBSchemaObjects(client))
      .map((o) => `${o.kind} ${o.type} ${o.labelsOrTypes[0]}(${o.properties.join(", ")})`)
      .sort();

  beforeAll(async () => {
    for (const k of ["FALKORDB_URL", "FALKORDB_GRAPH"]) saved[k] = process.env[k];
    process.env.FALKORDB_URL = process.env.FALKORDB_TEST_URL;
    process.env.FALKORDB_GRAPH = GRAPH;
    client = new CyphraClient({ falkordb: { url: process.env.FALKORDB_TEST_URL!, graph: GRAPH } });
    dir = await mkdtemp(path.join(tmpdir(), "cyphra-cli-fk-"));
    await mkdir(path.join(dir, "migrations"));
    await writeFile(path.join(dir, "schema.cyphra"), SCHEMA);
    await writeFile(
      path.join(dir, "cyphra.json"),
      JSON.stringify({
        schema: "./schema.cyphra",
        migrations: "./migrations",
        dialect: "falkordb",
      }),
    );
    config = await loadConfig(dir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (client) {
      await runMigrateReset(dir, config, { yes: true, skipSeed: true }).catch(() => undefined);
      await rows("MATCH (n) DETACH DELETE n");
      await client.close();
    }
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("requires FALKORDB_GRAPH", async () => {
    delete process.env.FALKORDB_GRAPH;
    try {
      await expect(runPush(dir)).rejects.toThrow(/FALKORDB_GRAPH/);
    } finally {
      process.env.FALKORDB_GRAPH = GRAPH;
    }
  });

  it("resets the graph, then pushes the schema (twice: idempotent)", async () => {
    await rows("UNWIND range(1, 50) AS i CREATE (:Stale {i: i})");
    await rows("CREATE INDEX FOR (n:Stale) ON (n.i)");
    await rows("GRAPH.CONSTRAINT CREATE MANDATORY NODE `Stale` PROPERTIES 1 `i`");
    expect(await runMigrateReset(dir, config, { yes: true, skipSeed: true })).toBe(0);
    // Only Cyphra's migration bookkeeping is left (reset reapplies the (no) migrations).
    expect(await objects()).toEqual([
      "constraint UNIQUE __CyphraMigration(name)",
      "index RANGE __CyphraMigration(name)",
    ]);
    expect(Number((await rows("MATCH (n) RETURN count(n) AS c"))[0]!.c)).toBe(0);

    await runPush(dir);
    await runPush(dir);
    expect((await objects()).filter((o) => !o.includes("__Cyphra"))).toEqual([
      "constraint UNIQUE CliPost(id)",
      "constraint UNIQUE CliUser(email)",
      "constraint UNIQUE CliUser(id)",
      "index FULLTEXT CliUser(name)",
      "index RANGE CliPost(id)",
      "index RANGE CliUser(email)",
      "index RANGE CliUser(id)",
      "index RANGE CliUser(name)",
      "index VECTOR CliUser(embedding)",
    ]);
  });

  it("writes FalkorDB migrations, applies them, and reports no drift", async () => {
    expect(await runMigrateReset(dir, config, { yes: true, skipSeed: true })).toBe(0);
    const file = await createMigrationFromSchema(dir, config, "init");
    expect(file).not.toBeNull();
    const source = await readFile(file!, "utf8");
    expect(source).toContain("GRAPH.CONSTRAINT CREATE UNIQUE NODE `CliUser` PROPERTIES 1 `email`");
    // The temp project has no `cyphra` package to import defineMigration from.
    await writeFile(
      file!,
      source.replace(
        /^import \{ defineMigration \} from .*$/m,
        "const defineMigration = (m) => m;",
      ),
    );
    await runMigrate(dir, false);
    const client2 = new CyphraClient({
      falkordb: { url: process.env.FALKORDB_TEST_URL!, graph: GRAPH },
    });
    try {
      const report = await migrateStatusReport(dir, config, client2);
      expect(report.migrations.map((m) => m.state)).toEqual(["applied"]);
      expect(report.drift).toMatchObject({ extra: [], missing: [], changed: [] });
      expect(report.inSync).toBe(true);
      const bySchema = await migrateStatusReport(dir, config, client2, { schema: true });
      expect(bySchema.drift).toMatchObject({ extra: [], missing: [], changed: [] });
    } finally {
      await client2.close();
    }

    // Reset reapplies the migration.
    expect(await runMigrateReset(dir, config, { yes: true, skipSeed: true })).toBe(0);
    const migrations = await rows("MATCH (m:__CyphraMigration) RETURN m.name AS name");
    expect(migrations).toHaveLength(1);
    expect(await objects()).toContain("constraint UNIQUE __CyphraMigration(name)");
  });

  it("pulls the schema back", async () => {
    await rows(
      "CREATE (:CliUser {id: 'u1', email: 'a@x.io', name: 'Ada'})-[:CLI_WROTE]->(:CliPost {id: 'p1', title: 'T'})",
    );
    const out: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        out.push(String(chunk));
        return true;
      });
    try {
      await runPull(dir, config, { print: true });
    } finally {
      write.mockRestore();
    }
    const text = out.join("");
    expect(text).toMatch(/node CliUser \{[^}]*id\s+String\s+@id/s);
    expect(text).toMatch(/email\s+String\s+@unique/);
    expect(text).toMatch(/CLI_WROTE/);
    expect(text).not.toMatch(/__CyphraMigration/);
  });
});
