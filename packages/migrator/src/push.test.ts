import { describe, expect, it } from "vitest";
import { parseSchema } from "@cyphra/schema";
import { constraintStatementsFromSchema, indexStatementsFromSchema } from "./push.js";

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

describe("indexStatementsFromSchema", () => {
  it("emits CREATE RANGE INDEX for @index on node scalars", () => {
    const doc = parseSchema(`
      node Post {
        id String @id
        slug String @index
      }
    `);
    const stmts = indexStatementsFromSchema(doc);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain("CREATE RANGE INDEX");
    expect(stmts[0]).toContain("Post_slug_idx");
    expect(stmts[0]).toContain("slug");
  });
});
