import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadMigrationsFromDir } from "./loadMigrations.js";

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureMigrations = join(cliRoot, "test-fixtures", "migrations");

describe("loadMigrationsFromDir", () => {
  it("loads sorted .mjs modules from the fixture directory", async () => {
    const loaded = await loadMigrationsFromDir(fixtureMigrations, cliRoot);
    expect(loaded.map((m) => m.name)).toEqual(["fixture_one", "fixture_two"]);
    expect(loaded.every((m) => m.checksum.length === 64)).toBe(true);
  });

  it("wraps syntax errors in Failed to load migration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-lm-bad-"));
    const mig = join(dir, "migrations");
    await mkdir(mig, { recursive: true });
    await writeFile(join(mig, "broken.mjs"), "export +++\n", "utf8");
    let msg = "";
    try {
      await loadMigrationsFromDir(mig, dir);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toMatch(/^Failed to load migration/);
    expect(msg).toContain("broken.mjs");
  });

  it("rejects migrations directory outside project root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-lm-out-"));
    await expect(loadMigrationsFromDir(join(tmpdir(), "elsewhere"), dir)).rejects.toThrow(
      /inside the project root/,
    );
  });
});
