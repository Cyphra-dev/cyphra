import { parseSchema, printSchemaDocument, resolveSchema } from "@cyphra/schema";
import { describe, expect, it } from "vitest";
import { schemaFromIntrospection, type IntrospectionResult } from "./introspect.js";

const sample: IntrospectionResult = {
  nodeTypes: [
    {
      labels: ["User"],
      properties: [
        { propertyName: "id", propertyTypes: ["String"], mandatory: true },
        { propertyName: "email", propertyTypes: ["String"], mandatory: true },
        { propertyName: "age", propertyTypes: ["Long"], mandatory: false },
        { propertyName: "tags", propertyTypes: ["StringArray"], mandatory: false },
        { propertyName: "loc", propertyTypes: ["Point"], mandatory: true },
        { propertyName: "bad-name", propertyTypes: ["String"], mandatory: true },
      ],
    },
    {
      labels: ["Post"],
      properties: [{ propertyName: "score", propertyTypes: ["Long", "Double"], mandatory: true }],
    },
    {
      labels: ["__CyphraMigration"],
      properties: [{ propertyName: "name", propertyTypes: ["String"], mandatory: true }],
    },
  ],
  relTypes: [
    {
      type: "AUTHORED",
      properties: [{ propertyName: "at", propertyTypes: ["DateTime"], mandatory: true }],
      endpoints: [{ from: ["User"], to: ["Post"] }],
    },
    { type: "FOLLOWS", properties: [], endpoints: [{ from: ["User"], to: ["User"] }] },
  ],
  constraints: [
    {
      name: "user_id",
      type: "UNIQUENESS",
      entityType: "NODE",
      labelsOrTypes: ["User"],
      properties: ["id"],
    },
    {
      name: "user_email",
      type: "UNIQUENESS",
      entityType: "NODE",
      labelsOrTypes: ["User"],
      properties: ["email"],
    },
  ],
  indexes: [
    {
      name: "age_idx",
      type: "RANGE",
      entityType: "NODE",
      labelsOrTypes: ["User"],
      properties: ["age"],
      owningConstraint: null,
    },
    {
      name: "user_id",
      type: "RANGE",
      entityType: "NODE",
      labelsOrTypes: ["User"],
      properties: ["id"],
      owningConstraint: "user_id",
    },
  ],
};

describe("schemaFromIntrospection", () => {
  const { doc, warnings } = schemaFromIntrospection(sample);
  const printed = printSchemaDocument(doc);

  it("produces a schema that parses and resolves", () => {
    expect(() => resolveSchema(parseSchema(printed))).not.toThrow();
  });

  it("maps types, required-ness, constraints, indexes and relations", () => {
    expect(printed).toBe(`node Post {
  score Float
  authoredBy User[] @relationship(type: "AUTHORED", direction: IN)
}

node User {
  id String @id
  age Int? @index
  email String @unique
  tags String[]
  authored Post[] @relationship(type: "AUTHORED", direction: OUT)
  follows User[] @relationship(type: "FOLLOWS", direction: OUT)
  followsBy User[] @relationship(type: "FOLLOWS", direction: IN)
}

relationship Authored {
  type "AUTHORED"
  from User
  to Post
  at DateTime
}
`);
  });

  it("explains what it skipped", () => {
    expect(warnings.join("\n")).toMatch(/User\.bad-name/);
    expect(warnings.join("\n")).toMatch(/User\.loc: unsupported/);
    expect(printed).not.toContain("__CyphraMigration");
  });
});
