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

  it("emits relationship property UNIQUE constraint for @unique (Neo4j 5.7+)", () => {
    const doc = parseSchema(`
      node A { id String @id }
      relationship R {
        type "KNOWS"
        from A
        to A
        edgeKey String @unique
      }
    `);
    const stmts = constraintStatementsFromSchema(doc);
    expect(stmts.some((s) => s.includes("FOR ()-[r:KNOWS]-()") && s.includes("edgeKey"))).toBe(
      true,
    );
    expect(stmts.some((s) => s.includes("R_edgeKey_rel_unique"))).toBe(true);
  });

  it("backticks non-identifier relationship types in unique constraint", () => {
    const doc = parseSchema(`
      node A { id String @id }
      relationship R {
        type "X-Y"
        from A
        to A
        k String @unique
      }
    `);
    const stmts = constraintStatementsFromSchema(doc);
    expect(stmts.some((s) => s.includes("FOR ()-[r:`X-Y`]-()"))).toBe(true);
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

  it("emits relationship RANGE INDEX for @index on relationship fields", () => {
    const doc = parseSchema(`
      node A { id String @id }
      relationship Membership {
        type "MEMBER_OF"
        from A
        to A
        role String @index
      }
    `);
    const stmts = indexStatementsFromSchema(doc);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain("FOR ()-[r:MEMBER_OF]-()");
    expect(stmts[0]).toContain("ON (r.`role`)");
    expect(stmts[0]).toContain("Membership_role_rel_idx");
  });

  it("backticks non-identifier relationship types in index pattern", () => {
    const doc = parseSchema(`
      node A { id String @id }
      relationship R {
        type "MY-TYPE"
        from A
        to A
        x String @index
      }
    `);
    const stmts = indexStatementsFromSchema(doc);
    expect(stmts[0]).toContain("FOR ()-[r:`MY-TYPE`]-()");
  });
});
