import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, loadConfigSync } from "./loadConfig.js";

describe("loadConfig", () => {
  it("suggests cyphra init when no config file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-cfg-"));
    await expect(loadConfig(dir)).rejects.toThrow(/cyphra init|cyphra\.config/);
  });

  it("loads cyphra.config.ts (default export object)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-cfg-ts-"));
    await writeFile(
      join(dir, "cyphra.config.ts"),
      `export default {
  schema: "./graph.cyphra",
  migrations: "./db/migrations",
};
`,
      "utf8",
    );
    const cfg = await loadConfig(dir);
    expect(cfg.schema).toBe(join(dir, "graph.cyphra"));
    expect(cfg.migrations).toBe(join(dir, "db/migrations"));
  });

  it("loads migrations as { path } and datasource.provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-cfg-nested-"));
    await writeFile(
      join(dir, "cyphra.config.ts"),
      `export default {
  schema: "./schema.cyphra",
  migrations: { path: "./migrations" },
  datasource: { provider: "neo4j" },
};
`,
      "utf8",
    );
    const cfg = await loadConfig(dir);
    expect(cfg.migrations).toBe(join(dir, "migrations"));
    expect(cfg.provider).toBe("neo4j");
  });

  it("loadConfigSync matches loadConfig for cyphra.config.ts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-cfg-sync-"));
    await writeFile(
      join(dir, "cyphra.config.ts"),
      `export default {
  schema: "./s.cyphra",
  migrations: { path: "./m" },
};
`,
      "utf8",
    );
    const asyncCfg = await loadConfig(dir);
    const syncCfg = loadConfigSync(dir);
    expect(syncCfg).toEqual(asyncCfg);
  });

  it("reports invalid JSON with the config path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-cfg-json-"));
    const file = join(dir, "cyphra.json");
    await writeFile(file, "{ not json\n", "utf8");
    await expect(loadConfig(dir)).rejects.toSatisfy((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return /Invalid JSON/.test(msg) && msg.includes("cyphra.json");
    });
  });
});
