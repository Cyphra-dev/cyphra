import { describe, expect, it } from "vitest";
import { parseSchema } from "./parseSchema.js";
import {
  collectCodegenModel,
  relTypeToExportKey,
  renderCyphraGenSource,
} from "./renderCyphraGen.js";

const sample = `
node User {
  id String @id
  posts Post[] @relationship(type: "AUTHORED", direction: OUT)
}

node Post {
  id String @id
}

relationship Membership {
  type "MEMBER_OF"
  from User
  to Organization
}

node Organization {
  id String @id
}
`;

describe("renderCyphraGenSource", () => {
  it("collects labels, relationship models, and rel types", () => {
    const doc = parseSchema(sample);
    const m = collectCodegenModel(doc);
    expect(m.nodeLabels).toEqual(["User", "Post", "Organization"]);
    expect(m.relationshipModels).toEqual([
      {
        name: "Membership",
        neo4jType: "MEMBER_OF",
        fromLabel: "User",
        toLabel: "Organization",
      },
    ]);
    expect(m.relNeo4jTypes).toEqual(["AUTHORED", "MEMBER_OF"]);
  });

  it("emits a stable TypeScript module", () => {
    const doc = parseSchema(sample);
    const src = renderCyphraGenSource(doc);
    expect(src).toContain("export const NodeLabel = {");
    expect(src).toContain('User: "User"');
    expect(src).toContain("export const RelationshipSpec = {");
    expect(src).toContain('neo4jType: "MEMBER_OF"');
    expect(src).toContain("export const RelType = {");
    expect(src).toContain('AUTHORED: "AUTHORED"');
    expect(src).toContain('MEMBER_OF: "MEMBER_OF"');
  });

  it("dedupes export keys for similar sanitized rel types", () => {
    const used = new Set<string>();
    expect(relTypeToExportKey("A-B", used)).toBe("A_B");
    expect(relTypeToExportKey("A_B", used)).toBe("A_B_2");
  });
});
