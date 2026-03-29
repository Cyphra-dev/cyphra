import { describe, expect, it } from "vitest";
import { compileRenameLabel, compileRenameProperty } from "./rename.js";

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
});
