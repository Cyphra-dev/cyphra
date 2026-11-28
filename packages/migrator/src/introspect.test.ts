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
        { propertyName: "loc", propertyTypes: ["Point"], mandatory: true, pointCrs: ["wgs-84"] },
        {
          propertyName: "grid",
          propertyTypes: ["Point"],
          mandatory: false,
          pointCrs: ["cartesian"],
        },
        {
          propertyName: "mixed",
          propertyTypes: ["Point"],
          mandatory: false,
          pointCrs: ["wgs-84", "cartesian-3d"],
        },
        { propertyName: "opens", propertyTypes: ["LocalTime"], mandatory: false },
        { propertyName: "slot", propertyTypes: ["Time"], mandatory: false },
        { propertyName: "seen", propertyTypes: ["LocalDateTime"], mandatory: false },
        { propertyName: "ttl", propertyTypes: ["Duration"], mandatory: false },
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
      name: "loc_idx",
      type: "POINT",
      entityType: "NODE",
      labelsOrTypes: ["User"],
      properties: ["loc"],
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
  authoredBy User[] @in(AUTHORED)
}

node User {
  id String @id
  age Int? @index
  email String @unique
  grid CartesianPoint?
  loc Point @index
  opens LocalTime?
  seen LocalDateTime?
  slot Time?
  tags String[]
  ttl Duration?
  authored Post[] @out(AUTHORED)
  follows User[] @out(FOLLOWS)
  followsBy User[] @in(FOLLOWS)
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
    expect(warnings.join("\n")).toMatch(/User\.mixed: unsupported/);
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

describe("schemaFromIntrospection: composite constraints and indexes", () => {
  const { doc, warnings } = schemaFromIntrospection({
    nodeTypes: [
      {
        labels: ["Account"],
        properties: [
          { propertyName: "provider", propertyTypes: ["String"], mandatory: true },
          { propertyName: "accountId", propertyTypes: ["String"], mandatory: true },
          { propertyName: "tenant", propertyTypes: ["String"], mandatory: false },
          { propertyName: "tags", propertyTypes: ["StringArray"], mandatory: false },
        ],
      },
    ],
    relTypes: [],
    constraints: [
      {
        name: "Account_provider_accountId_unique",
        type: "UNIQUENESS",
        entityType: "NODE",
        labelsOrTypes: ["Account"],
        properties: ["provider", "accountId"],
      },
      {
        name: "tenantKey",
        type: "NODE_KEY",
        entityType: "NODE",
        labelsOrTypes: ["Account"],
        properties: ["tenant", "accountId"],
      },
      {
        name: "withTags",
        type: "UNIQUENESS",
        entityType: "NODE",
        labelsOrTypes: ["Account"],
        properties: ["tenant", "tags"],
      },
    ],
    indexes: [
      {
        name: "Account_provider_accountId_unique",
        type: "RANGE",
        entityType: "NODE",
        labelsOrTypes: ["Account"],
        properties: ["provider", "accountId"],
        owningConstraint: "Account_provider_accountId_unique",
      },
      {
        name: "Account_tenant_provider_idx",
        type: "RANGE",
        entityType: "NODE",
        labelsOrTypes: ["Account"],
        properties: ["tenant", "provider"],
        owningConstraint: null,
      },
      {
        name: "byProvider",
        type: "RANGE",
        entityType: "NODE",
        labelsOrTypes: ["Account"],
        properties: ["provider", "tenant"],
        owningConstraint: null,
      },
    ],
  });
  const printed = printSchemaDocument(doc);

  it("maps them to @@unique / @@index, naming only non-default names", () => {
    expect(printed).toBe(`node Account {
  accountId String
  provider String
  tags String[]
  tenant String?

  @@unique([provider, accountId])
  @@unique([tenant, accountId], name: "tenantKey")
  @@index([tenant, provider])
  @@index([provider, tenant], name: "byProvider")
}
`);
    expect(() => resolveSchema(parseSchema(printed))).not.toThrow();
    const w = warnings.join("\n");
    expect(w).toMatch(/Node key tenantKey became @@unique/);
    expect(w).toMatch(/Skipped composite constraint withTags: Account\.tags not found/);
  });
});

describe("schemaFromIntrospection: interfaces", () => {
  const str = (name: string, mandatory = true) => ({
    propertyName: name,
    propertyTypes: ["String"],
    mandatory,
  });
  const input: IntrospectionResult = {
    nodeTypes: [
      {
        labels: ["Employee", "Person"],
        properties: [str("id"), str("email"), str("name"), str("badge")],
      },
      {
        labels: ["Customer", "Person"],
        properties: [str("id"), str("email"), str("name", false), str("tier")],
      },
      { labels: ["Team"], properties: [str("id")] },
      // Not an interface layout: :Tagged also appears alone.
      { labels: ["Note", "Tagged"], properties: [str("text")] },
      { labels: ["Tagged"], properties: [str("tag")] },
    ],
    relTypes: [
      {
        type: "MANAGES",
        properties: [],
        endpoints: [
          { from: ["Employee", "Person"], to: ["Employee", "Person"] },
          { from: ["Employee", "Person"], to: ["Customer", "Person"] },
        ],
      },
      {
        type: "MEMBER_OF",
        properties: [],
        endpoints: [{ from: ["Employee", "Person"], to: ["Team"] }],
      },
    ],
    constraints: [
      {
        name: "Person_id_id",
        type: "UNIQUENESS",
        entityType: "NODE",
        labelsOrTypes: ["Person"],
        properties: ["id"],
      },
      {
        name: "Employee_email_unique",
        type: "UNIQUENESS",
        entityType: "NODE",
        labelsOrTypes: ["Employee"],
        properties: ["email"],
      },
      {
        name: "Employee_badge_unique",
        type: "UNIQUENESS",
        entityType: "NODE",
        labelsOrTypes: ["Employee"],
        properties: ["badge"],
      },
    ],
    indexes: [],
  };
  const { doc, warnings } = schemaFromIntrospection(input);
  const printed = printSchemaDocument(doc);

  it("detects interfaces and keeps constraints on the label that has them", () => {
    // email stays on the implementations: Employee constrains it, Person does not.
    expect(printed).toBe(`node Customer implements Person {
  email String
  tier String
}

node Employee implements Person {
  badge String @unique
  email String @unique
  manages Person[] @out(MANAGES)
  memberOf Team[] @out(MEMBER_OF)
}

node Note {
  text String
}

interface Person {
  id String @id
  name String?
  managesBy Employee[] @in(MANAGES)
}

node Tagged {
  tag String?
  text String?
}

node Team {
  id String
  memberOfBy Employee[] @in(MEMBER_OF)
}
`);
  });

  it("produces a schema that parses and resolves", () => {
    const model = resolveSchema(parseSchema(printed));
    expect(model.nodes.find((n) => n.name === "Employee")?.labels).toEqual(["Employee", "Person"]);
  });

  it("lists the label combinations it could not turn into interfaces", () => {
    expect(warnings.join("\n")).toMatch(/:Note:Tagged became one model per label/);
  });
});

describe("schemaFromIntrospection: interfaces extending interfaces", () => {
  const str = (name: string, mandatory = true) => ({
    propertyName: name,
    propertyTypes: ["String"],
    mandatory,
  });
  const input: IntrospectionResult = {
    nodeTypes: [
      {
        labels: ["Employee", "Staff", "Person"],
        properties: [str("id"), str("name"), str("team"), str("salary")],
      },
      {
        labels: ["Contractor", "Staff", "Person"],
        properties: [str("id"), str("name"), str("team"), str("agency")],
      },
      { labels: ["Customer", "Person"], properties: [str("id"), str("name", false), str("tier")] },
      { labels: ["Site"], properties: [str("code")] },
    ],
    relTypes: [
      {
        type: "WORKS_AT",
        properties: [],
        endpoints: [
          { from: ["Employee", "Staff", "Person"], to: ["Site"] },
          { from: ["Contractor", "Staff", "Person"], to: ["Site"] },
        ],
      },
      {
        type: "VISITS",
        properties: [],
        endpoints: [
          { from: ["Employee", "Staff", "Person"], to: ["Site"] },
          { from: ["Contractor", "Staff", "Person"], to: ["Site"] },
          { from: ["Customer", "Person"], to: ["Site"] },
        ],
      },
    ],
    constraints: [
      {
        name: "Person_id_id",
        type: "UNIQUENESS",
        entityType: "NODE",
        labelsOrTypes: ["Person"],
        properties: ["id"],
      },
    ],
    indexes: [
      {
        name: "Staff_team_idx",
        type: "RANGE",
        entityType: "NODE",
        labelsOrTypes: ["Staff"],
        properties: ["team"],
        owningConstraint: null,
      },
    ],
  };
  const { doc, warnings } = schemaFromIntrospection(input);
  const printed = printSchemaDocument(doc);

  it("detects a chain of labels as interfaces extending each other", () => {
    expect(printed).toBe(`node Contractor implements Staff {
  agency String
}

node Customer implements Person {
  tier String
}

node Employee implements Staff {
  salary String
}

interface Person {
  id String @id
  name String?
  visits Site[] @out(VISITS)
}

node Site {
  code String
  visitsBy Person[] @in(VISITS)
  worksAtBy Staff[] @in(WORKS_AT)
}

interface Staff extends Person {
  team String @index
  worksAt Site[] @out(WORKS_AT)
}
`);
    expect(warnings).toEqual([]);
  });

  it("produces a schema that parses and resolves", () => {
    const model = resolveSchema(parseSchema(printed));
    expect(model.nodes.find((n) => n.name === "Employee")?.labels).toEqual([
      "Employee",
      "Staff",
      "Person",
    ]);
    expect(model.nodes.find((n) => n.name === "Person")?.implementations).toEqual([
      "Contractor",
      "Customer",
      "Employee",
    ]);
  });

  it("falls back to one model per label when which label is the interface is ambiguous", () => {
    const { doc, warnings } = schemaFromIntrospection({
      ...input,
      nodeTypes: [
        // Staff is always seen with Intern: which one is the node's own label is ambiguous.
        { labels: ["Intern", "Staff", "Worker"], properties: [str("id")] },
        { labels: ["Boss", "Worker"], properties: [str("id")] },
        // Two labels always together.
        { labels: ["A", "B"], properties: [str("id")] },
      ],
      relTypes: [],
      constraints: [],
      indexes: [],
    });
    expect(doc.declarations.some((d) => d.kind === "Node" && (d.abstract || d.implements))).toBe(
      false,
    );
    expect(warnings).toEqual([
      expect.stringMatching(
        /^Nodes labelled :Intern:Staff:Worker, :Boss:Worker became one model per label \(Boss, Intern, Staff, Worker\): which labels are interfaces is ambiguous\. .*--interface <label>.*\(candidates: Intern, Staff\)/,
      ),
      expect.stringMatching(/^Nodes labelled :A:B became one model per label .*candidates: A, B/),
    ]);
  });
});
