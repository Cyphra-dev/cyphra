import { describe, expect, it } from "vitest";
import {
  constraintStatementsFromSchema,
  cypher,
  CyphraClient,
  defineMigration,
  parseSchema,
} from "./index.js";

describe("cyphra package barrel", () => {
  it("re-exports schema, query, runtime, and migrator APIs", () => {
    expect(typeof parseSchema).toBe("function");
    expect(typeof cypher).toBe("function");
    expect(CyphraClient).toBeDefined();
    expect(typeof defineMigration).toBe("function");
    const doc = parseSchema(`node N { x String @id }`);
    expect(constraintStatementsFromSchema(doc).length).toBeGreaterThan(0);
    const compiled = cypher`RETURN 1 AS n`;
    expect(compiled.text).toContain("RETURN");
  });
});
