import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSchemaFile } from "./readSchemaFile.js";

describe("parseSchemaFile", () => {
  it("reads and parses a .cyphra file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-schema-"));
    const path = join(dir, "schema.cyphra");
    await writeFile(
      path,
      `node X {
  id String @id
}
`,
      "utf8",
    );
    const doc = await parseSchemaFile(path);
    expect(doc.declarations[0]).toMatchObject({ kind: "Node", name: "X" });
  });
});
