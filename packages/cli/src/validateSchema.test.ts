import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CyphraConfig } from "@cyphra/config";
import { runValidateSchema } from "./commands/validateSchema.js";

describe("runValidateSchema", () => {
  it("prefixes parse errors with the schema path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-val-"));
    const schemaPath = join(dir, "schema.cyphra");
    await writeFile(schemaPath, "not valid cyphra !!!\n", "utf8");
    const config: CyphraConfig = {
      provider: "neo4j",
      schema: schemaPath,
      migrations: join(dir, "migrations"),
    };
    await expect(runValidateSchema(dir, config)).rejects.toSatisfy((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return msg.includes("schema.cyphra") && msg.length > "schema.cyphra".length;
    });
  });

  it("reports missing schema file clearly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-val-miss-"));
    const config: CyphraConfig = {
      provider: "neo4j",
      schema: join(dir, "missing.cyphra"),
      migrations: join(dir, "migrations"),
    };
    await expect(runValidateSchema(dir, config)).rejects.toSatisfy((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return /Schema file not found/.test(msg) && msg.includes("missing.cyphra");
    });
  });
});
