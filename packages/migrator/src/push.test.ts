import { describe, expect, it } from "vitest";
import { parseSchema } from "@cyphra/schema";
import { constraintStatementsFromSchema } from "./push.js";

describe("constraintStatementsFromSchema", () => {
  it("emits unique constraints for @id and @unique", () => {
    const doc = parseSchema(`
      node User {
        id String @id
        email String @unique
      }
    `);
    const stmts = constraintStatementsFromSchema(doc);
    expect(stmts.length).toBe(2);
    expect(stmts[0]).toContain("User");
    expect(stmts[0]).toContain("id");
    expect(stmts[1]).toContain("email");
  });
});
