import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInit } from "./commands/init.js";

describe("runInit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates cyphra.json, schema, migrations, and .env.example", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-init-"));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    await runInit(dir);
    const cfg = JSON.parse(await readFile(join(dir, "cyphra.json"), "utf8")) as {
      $schema?: string;
      provider: string;
      schema: string;
    };
    expect(cfg.$schema).toContain("cyphra-config.schema.json");
    expect(cfg.provider).toBe("neo4j");
    expect(cfg.schema).toBe("./schema.cyphra");
    expect(await readFile(join(dir, "schema.cyphra"), "utf8")).toContain("node Example");
    await stat(join(dir, "migrations"));
    expect(await readFile(join(dir, ".env.example"), "utf8")).toContain("NEO4J_URI");
    expect(logs.some((l) => l.includes("Created"))).toBe(true);
  });

  it("refuses to overwrite an existing cyphra.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-init-dup-"));
    await writeFile(join(dir, "cyphra.json"), "{}\n", "utf8");
    await expect(runInit(dir)).rejects.toThrow(/already exists/);
  });
});
