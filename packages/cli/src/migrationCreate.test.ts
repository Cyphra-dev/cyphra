import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMigrationCreate } from "./commands/migrationCreate.js";

describe("runMigrationCreate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a migration file and logs the relative path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-mc-"));
    const mig = join(dir, "migrations");
    await mkdir(mig, { recursive: true });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    await runMigrationCreate(dir, mig, "add-users");
    expect(await readFile(join(mig, "add-users.mjs"), "utf8")).toContain("defineMigration");
    expect(logs.some((l) => l.includes("add-users.mjs"))).toBe(true);
  });

  it("sanitizes special characters in the file name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-mc-safe-"));
    const mig = join(dir, "migrations");
    await mkdir(mig, { recursive: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runMigrationCreate(dir, mig, "fix-#tags");
    expect(await readFile(join(mig, "fix-_tags.mjs"), "utf8")).toMatch(/name: "fix-_tags"/);
  });

  it("refuses an empty name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-mc-empty-"));
    const mig = join(dir, "migrations");
    await mkdir(mig, { recursive: true });
    await expect(runMigrationCreate(dir, mig, "   ")).rejects.toThrow(/empty/);
  });

  it("refuses a name with no letters or digits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-mc-sym-"));
    const mig = join(dir, "migrations");
    await mkdir(mig, { recursive: true });
    await expect(runMigrationCreate(dir, mig, "---")).rejects.toThrow(/letter or digit/);
  });

  it("refuses to overwrite an existing migration file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-mc-dup-"));
    const mig = join(dir, "migrations");
    await mkdir(mig, { recursive: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runMigrationCreate(dir, mig, "once");
    await expect(runMigrationCreate(dir, mig, "once")).rejects.toThrow(/already exists/);
  });
});
