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
});
