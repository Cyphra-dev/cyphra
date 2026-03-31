import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CyphraConfig } from "@cyphra/config";
import { runSchemaDdl } from "./commands/schemaDdl.js";

describe("runSchemaDdl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints constraint and range index lines in push order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-ddl-"));
    const schemaPath = join(dir, "schema.cyphra");
    await writeFile(
      schemaPath,
      `node U {
  id   String @id
  slug String @index
}
`,
      "utf8",
    );
    const config: CyphraConfig = {
      provider: "neo4j",
      schema: schemaPath,
      migrations: join(dir, "migrations"),
    };
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      lines.push(String(msg));
    });
    await runSchemaDdl(dir, config);
    const joined = lines.join("\n");
    expect(joined).toMatch(/CREATE CONSTRAINT.*U.*id/s);
    expect(joined).toMatch(/CREATE RANGE INDEX.*slug/s);
    const cIdx = lines.findIndex((l) => l.includes("CREATE CONSTRAINT"));
    const iIdx = lines.findIndex((l) => l.includes("CREATE RANGE INDEX"));
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(iIdx).toBeGreaterThan(cIdx);
  });
});
