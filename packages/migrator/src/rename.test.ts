import { describe, expect, it } from "vitest";
import {
  compileRenameLabel,
  compileRenameProperty,
  compileRenameRelationshipType,
} from "./rename.js";

describe("rename compilers", () => {
  it("rejects unsafe label names", () => {
    expect(() => compileRenameLabel("A`; DROP", "B")).toThrow(/Invalid/);
  });

  it("produces SET/REMOVE label Cypher", () => {
    const { text } = compileRenameLabel("Person", "User");
    expect(text).toContain("Person");
    expect(text).toContain("User");
  });

  it("produces property rename Cypher", () => {
    const { text } = compileRenameProperty("User", "fullName", "name");
    expect(text).toContain("fullName");
    expect(text).toContain("name");
  });

  it("produces relationship type rename Cypher, quoted, scoped to labels when given", () => {
    expect(compileRenameRelationshipType({ from: "AUTHORED", to: "WROTE" }).text).toBe(
      "MATCH (a)-[r:`AUTHORED`]->(b) CREATE (a)-[n:`WROTE`]->(b) SET n = properties(r) DELETE r",
    );
    expect(
      compileRenameRelationshipType({ from: "HAS-TAG", to: "x`y", startLabel: "Post" }).text,
    ).toBe(
      "MATCH (a:`Post`)-[r:`HAS-TAG`]->(b) CREATE (a)-[n:`x``y`]->(b) SET n = properties(r) DELETE r",
    );
    expect(() => compileRenameRelationshipType({ from: "", to: "B" })).toThrow(/required/);
  });
});
