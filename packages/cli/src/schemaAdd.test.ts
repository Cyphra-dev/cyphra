import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSchemaAddFromJson } from "./commands/schemaAdd.js";

describe("runSchemaAddFromJson", () => {
  it("appends a valid node block", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-schema-add-"));
    const schemaPath = join(dir, "schema.cyphra");
    await writeFile(schemaPath, `node Existing { id String @id }\n`, "utf8");
    const config = {
      provider: "neo4j" as const,
      schema: schemaPath,
      migrations: join(dir, "migrations"),
    };
    await runSchemaAddFromJson(config, {
      label: "Product",
      fields: [
        { name: "id", type: "String", id: true },
        { name: "sku", type: "String", unique: true },
      ],
    });
    const out = await readFile(schemaPath, "utf8");
    expect(out).toContain("node Product");
    expect(out).toContain("sku String @unique");
  });
});
