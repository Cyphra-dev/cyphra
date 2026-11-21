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

describe("schemaFromIntrospection (vector indexes)", () => {
  const vectorIndex = (
    name: string,
    property: string,
    indexConfig: Record<string, unknown>,
  ): IntrospectionResult["indexes"][number] => ({
    name,
    type: "VECTOR",
    entityType: "NODE",
    labelsOrTypes: ["Chunk"],
    properties: [property],
    owningConstraint: null,
    options: { indexProvider: "vector-2.0", indexConfig },
  });
  const { doc, warnings } = schemaFromIntrospection({
    nodeTypes: [
      {
        labels: ["Chunk"],
        properties: [
          { propertyName: "embedding", propertyTypes: ["DoubleArray"], mandatory: false },
          { propertyName: "title", propertyTypes: ["FloatArray"], mandatory: true },
          { propertyName: "weird", propertyTypes: ["DoubleArray"], mandatory: false },
        ],
      },
    ],
    relTypes: [],
    constraints: [],
    indexes: [
      vectorIndex("Chunk_embedding_vector", "embedding", {
        "vector.dimensions": 1536,
        "vector.similarity_function": "COSINE",
        "vector.quantization.enabled": true,
      }),
      vectorIndex("titles", "title", {
        "vector.dimensions": 384,
        "vector.similarity_function": "EUCLIDEAN",
        "vector.quantization.enabled": false,
      }),
      vectorIndex("weird_idx", "weird", { "vector.similarity_function": "COSINE" }),
    ],
  });
  const printed = printSchemaDocument(doc);

  it("maps vector indexes to Vector(N) fields with @vectorIndex", () => {
    expect(printed).toBe(`node Chunk {
  embedding Vector(1536)? @vectorIndex(similarity: cosine)
  title Vector(384) @vectorIndex(similarity: euclidean, name: "titles", quantization: false)
  weird Float[]
}
`);
    expect(() => resolveSchema(parseSchema(printed))).not.toThrow();
    expect(warnings.join("\n")).toMatch(
      /Skipped vector index weird_idx: no supported vector\.dimensions/,
    );
  });
});

describe("schemaFromIntrospection (full-text indexes)", () => {
  const fulltextIndex = (
    name: string,
    properties: string[],
    indexConfig: Record<string, unknown>,
    extra: Partial<IntrospectionResult["indexes"][number]> = {},
  ): IntrospectionResult["indexes"][number] => ({
    name,
    type: "FULLTEXT",
    entityType: "NODE",
    labelsOrTypes: ["Post"],
    properties,
    owningConstraint: null,
    options: { indexProvider: "fulltext-1.0", indexConfig },
    ...extra,
  });
  const { doc, warnings } = schemaFromIntrospection({
    nodeTypes: [
      {
        labels: ["Post"],
        properties: [
          { propertyName: "title", propertyTypes: ["String"], mandatory: true },
          { propertyName: "body", propertyTypes: ["String"], mandatory: false },
          { propertyName: "tags", propertyTypes: ["StringArray"], mandatory: false },
          { propertyName: "views", propertyTypes: ["Long"], mandatory: false },
        ],
      },
    ],
    relTypes: [],
    constraints: [],
    indexes: [
      fulltextIndex("postSearch", ["title", "body"], {
        "fulltext.analyzer": "english",
        "fulltext.eventually_consistent": false,
      }),
      fulltextIndex("Post_tags_fulltext", ["tags"], {
        "fulltext.analyzer": "standard-no-stop-words",
        "fulltext.eventually_consistent": true,
      }),
      fulltextIndex("byViews", ["views"], {}),
      fulltextIndex("custom", ["title"], { "fulltext.analyzer": "my-analyzer" }),
      fulltextIndex("multi", ["title"], {}, { labelsOrTypes: ["Post", "Page"] }),
      fulltextIndex("rels", ["note"], {}, { entityType: "RELATIONSHIP", labelsOrTypes: ["R"] }),
      fulltextIndex("ghost", ["name"], {}, { labelsOrTypes: ["Ghost"] }),
    ],
  });
  const printed = printSchemaDocument(doc);

  it("maps node full-text indexes to @@fulltext attributes", () => {
    expect(printed).toBe(`node Post {
  body String?
  tags String[]
  title String
  views Int?

  @@fulltext([title, body], name: "postSearch", analyzer: "english")
  @@fulltext([tags], eventuallyConsistent: true)
}
`);
    expect(() => resolveSchema(parseSchema(printed))).not.toThrow();
    const w = warnings.join("\n");
    expect(w).toMatch(/Skipped full-text index byViews: Post\.views not found as String/);
    expect(w).toMatch(/Skipped full-text index custom: unsupported analyzer "my-analyzer"/);
    expect(w).toMatch(/Skipped full-text index multi: only single-label/);
    expect(w).toMatch(/Skipped full-text index rels: relationship full-text indexes/);
    expect(w).toMatch(/Skipped full-text index ghost: label Ghost has no nodes/);
  });
});
