import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CyphraConfig } from "../config.js";
import { runFormat } from "./format.js";

describe("runFormat", () => {
  let dir: string;
  let config: CyphraConfig;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cyphra-format-"));
    config = {
      schema: join(dir, "schema.cyphra"),
      migrations: join(dir, "migrations"),
      generate: join(dir, "cyphra.gen.ts"),
      runtimeImport: "cyphra",
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("rewrites the schema in place and keeps comments", async () => {
    await writeFile(config.schema, "// users\nnode User { id String @id // key\n}\n");
    expect(await runFormat(dir, config)).toBe(0);
    expect(await readFile(config.schema, "utf8")).toBe(
      "// users\nnode User {\n  id String @id // key\n}\n",
    );
  });

  it("--check reports an unformatted schema without writing it", async () => {
    const raw = "node User { id String @id }";
    await writeFile(config.schema, raw);
    expect(await runFormat(dir, config, { check: true })).toBe(1);
    expect(await readFile(config.schema, "utf8")).toBe(raw);
    await writeFile(config.schema, "node User {\n  id String @id\n}\n");
    expect(await runFormat(dir, config, { check: true })).toBe(0);
  });

  it("--codemod rewrites @relationship fields into @out / @in; plain format only hints", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const raw =
      'node User {\n  id    String @id\n  posts Post[] @relationship(type: "AUTHORED", direction: OUT)\n}\n\nnode Post {\n  id String @id\n}\n';
    await writeFile(config.schema, raw);
    expect(await runFormat(dir, config)).toBe(0);
    expect(await readFile(config.schema, "utf8")).toBe(raw);
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual([
      "schema.cyphra is formatted.",
      "hint: 1 relation field uses @relationship(…): `cyphra format --codemod` rewrites it into @out(…) / @in(…).",
    ]);
    expect(await runFormat(dir, config, { check: true, codemod: true })).toBe(1);
    log.mockClear();
    expect(await runFormat(dir, config, { codemod: true })).toBe(0);
    const out = await readFile(config.schema, "utf8");
    expect(out).toContain("  posts Post[] @out(AUTHORED)\n");
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual(["Formatted schema.cyphra."]);
    // Idempotent.
    expect(await runFormat(dir, config, { check: true, codemod: true })).toBe(0);
  });
});
