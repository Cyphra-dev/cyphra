import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CyphraClient } from "@cyphra/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `cyphra migrate status` compares the WHOLE database with the migrations, so this suite empties
 * the test database's schema first: like the reset suite, it needs CYPHRA_TEST_RESET_DB=1 and must
 * not run alongside other Neo4j tests. It runs the built CLI (`dist/`), to check exit codes.
 */
const enabled = Boolean(
  process.env.NEO4J_TEST_URI &&
  process.env.NEO4J_TEST_USER &&
  process.env.NEO4J_TEST_PASSWORD &&
  process.env.CYPHRA_TEST_RESET_DB === "1",
);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "../../dist/index.js");

type CliResult = { code: number; stdout: string; stderr: string };

function cli(cwd: string, args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        cwd,
        env: {
          PATH: process.env.PATH ?? "",
          NEO4J_URI: process.env.NEO4J_TEST_URI!,
          NEO4J_USERNAME: process.env.NEO4J_TEST_USER!,
          NEO4J_PASSWORD: process.env.NEO4J_TEST_PASSWORD!,
          ...env,
        },
      },
      (err, stdout, stderr) => {
        const code = err ? Number((err as { code?: number }).code ?? 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe.skipIf(!enabled)("cyphra migrate status (Neo4j)", () => {
  let dir: string;
  let client: CyphraClient;
  const rows = async (text: string) =>
    client.withSession(async (s) => (await s.run(text)).records.map((r) => r.toObject()));

  /** Drop every constraint and non-lookup index, and the migration records. */
  const emptySchema = async () => {
    for (const c of await rows("SHOW CONSTRAINTS YIELD name RETURN name")) {
      await rows(`DROP CONSTRAINT \`${String(c.name)}\` IF EXISTS`);
    }
    for (const i of await rows(
      "SHOW INDEXES YIELD name, type WHERE type <> 'LOOKUP' RETURN name",
    )) {
      await rows(`DROP INDEX \`${String(i.name)}\` IF EXISTS`);
    }
    await rows("MATCH (m:__CyphraMigration) DELETE m");
  };

  beforeAll(async () => {
    client = new CyphraClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
    });
    await emptySchema();
    dir = await mkdtemp(path.join(tmpdir(), "cyphra-status-"));
    // Generated migrations import defineMigration; point them at the workspace migrator.
    const migrator = pathToFileURL(path.resolve(HERE, "../../../migrator/dist/index.js")).href;
    await writeFile(
      path.join(dir, "cyphra.json"),
      JSON.stringify({
        schema: "./schema.cyphra",
        migrations: "./migrations",
        runtimeImport: migrator,
      }),
    );
    await writeFile(
      path.join(dir, "schema.cyphra"),
      `node StatusUser {
  id    String @id
  email String @unique
  tenant String
  handle String
  @@unique([tenant, handle])
}
node StatusDoc {
  id        String @id
  embedding Vector(3)? @vectorIndex(similarity: cosine)
}
`,
    );
  }, 60_000);

  afterAll(async () => {
    await emptySchema();
    await client?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("reports a pending migration (exit 1), then in sync after deploy (exit 0)", async () => {
    const created = await cli(dir, ["migrate", "dev", "--name", "init", "--create-only"]);
    expect(created.code).toBe(0);

    const pending = await cli(dir, ["migrate", "status", "--json"]);
    expect(pending.code).toBe(1);
    const report = JSON.parse(pending.stdout) as {
      inSync: boolean;
      migrations: { name: string; state: string }[];
    };
    expect(report.inSync).toBe(false);
    expect(report.migrations.map((m) => m.state)).toEqual(["pending"]);

    expect((await cli(dir, ["migrate", "deploy"])).code).toBe(0);
    const ok = await cli(dir, ["migrate", "status"]);
    expect(ok.stdout).toContain("No drift");
    expect(ok.code).toBe(0);
  }, 120_000);

  it("reports drift made outside migrations (exit 1) and warns in migrate dev", async () => {
    await rows("CREATE TEXT INDEX status_manual IF NOT EXISTS FOR (n:StatusUser) ON (n.bio)");
    await rows("DROP CONSTRAINT StatusUser_tenant_handle_unique");
    await rows("DROP INDEX StatusDoc_embedding_vector");
    await rows(
      "CREATE VECTOR INDEX StatusDoc_embedding_vector FOR (n:StatusDoc) ON n.embedding OPTIONS {indexConfig: {`vector.dimensions`: 4, `vector.similarity_function`: 'cosine'}}",
    );

    const human = await cli(dir, ["migrate", "status"]);
    expect(human.code).toBe(1);
    expect(human.stdout).toContain(
      "extra     index status_manual: TEXT index on (:StatusUser {bio})",
    );
    expect(human.stdout).toContain("missing   constraint StatusUser_tenant_handle_unique");
    expect(human.stdout).toContain(
      "changed   index StatusDoc_embedding_vector: dimensions: 3 → 4 (expected → actual)",
    );

    const json = await cli(dir, ["migrate", "status", "--json"]);
    expect(json.code).toBe(1);
    const report = JSON.parse(json.stdout) as {
      drift: {
        expected: string;
        extra: { name: string }[];
        missing: { name: string }[];
        changed: { expected: { name: string }; differences: string[] }[];
      };
    };
    expect(report.drift.expected).toBe("migrations");
    expect(report.drift.extra.map((o) => o.name)).toEqual(["status_manual"]);
    expect(report.drift.missing.map((o) => o.name)).toEqual(["StatusUser_tenant_handle_unique"]);
    expect(report.drift.changed.map((c) => c.differences)).toEqual([["dimensions: 3 → 4"]]);

    // Against the schema: same drift (the schema matches the migrations).
    const schema = await cli(dir, ["migrate", "status", "--schema", "--json"]);
    expect(schema.code).toBe(1);
    expect(JSON.parse(schema.stdout).drift.expected).toBe("schema");

    const dev = await cli(dir, ["migrate", "dev", "--create-only"]);
    expect(dev.code).toBe(0);
    expect(dev.stdout).toContain("No schema changes since the last migration.");
    expect(dev.stderr).toContain("the database has drifted from the applied migrations");
    expect(dev.stderr).toContain("cyphra migrate reset");
  }, 120_000);

  it("exits 2 when the database cannot be reached", async () => {
    const res = await cli(dir, ["migrate", "status"], { NEO4J_URI: "bolt://127.0.0.1:1" });
    expect(res.code).toBe(2);
  }, 120_000);
});
