import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  constraintStatementsFromSchema,
  cypher,
  CyphraClient,
  defineMigration,
  parseSchema,
  parseSchemaFile,
} from "./index.js";

describe("cyphra package barrel", () => {
  it("re-exports schema, query, runtime, and migrator APIs", () => {
    expect(typeof parseSchema).toBe("function");
    expect(typeof parseSchemaFile).toBe("function");
    expect(typeof cypher).toBe("function");
    expect(CyphraClient).toBeDefined();
    expect(typeof defineMigration).toBe("function");
    const doc = parseSchema(`node N { x String @id }`);
    expect(constraintStatementsFromSchema(doc).length).toBeGreaterThan(0);
    const compiled = cypher`RETURN 1 AS n`;
    expect(compiled.text).toContain("RETURN");
  });

  it("re-exports parseSchemaFile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cyphra-barrel-"));
    const path = join(dir, "s.cyphra");
    await writeFile(path, `node Z { id String @id }\n`, "utf8");
    const doc = await parseSchemaFile(path);
    expect(doc.declarations[0]).toMatchObject({ kind: "Node", name: "Z" });
  });
});
