import { describe, expect, it } from "vitest";
import { formatSchema } from "./formatSchema.js";
import { resolveSchema } from "./model.js";
import { parseSchema } from "./parseSchema.js";
import { printSchemaDocument } from "./printSchema.js";
import { renderCyphraGenSource } from "./renderCyphraGen.js";
import { renderZodFromModel } from "./renderZod.js";

const SRC = `
union SearchHit = Post | User

node Post {
  id    String @id
  title String
}

node User {
  id   String @id
  name String
}

node Tag {
  id      String      @id
  targets SearchHit[] @relationship(type: "TAGS", direction: OUT, onDelete: Cascade)
  pinned  SearchHit?  @relationship(type: "PINS", direction: OUT)
}
`;

const model = () => resolveSchema(parseSchema(SRC));

describe("unions: schema", () => {
  it("parses a union, with an optional leading bar and members over several lines", () => {
    const doc = parseSchema(`
union A =
  | X
  | Y
node X { id String @id }
node Y { id String @id }
`);
    expect(doc.declarations[0]).toEqual({ kind: "Union", name: "A", members: ["X", "Y"] });
  });

  it("resolves a union as an abstract model with its members and no fields", () => {
    const m = model();
    expect(m.nodes.map((n) => n.name)).toEqual(["SearchHit", "Post", "User", "Tag"]);
    expect(m.nodes[0]).toEqual({
      name: "SearchHit",
      label: "SearchHit",
      abstract: true,
      union: true,
      implementations: ["Post", "User"],
      uniqueFields: [],
      fields: [],
    });
    // Members are plain nodes: a union adds no label and no interface.
    expect(m.nodes[1]).not.toHaveProperty("labels");
    expect(m.nodes[1]).not.toHaveProperty("interfaces");
  });

  it("lets relation fields target a union", () => {
    const tag = model().nodes.find((n) => n.name === "Tag")!;
    expect(tag.fields.find((f) => f.name === "targets")).toMatchObject({
      kind: "relation",
      target: "SearchHit",
      many: true,
      onDelete: "Cascade",
    });
  });

  it("leaves schemas without unions unchanged", () => {
    const m = resolveSchema(parseSchema("node A { id String @id }"));
    expect(m.nodes).toHaveLength(1);
    expect(m.nodes[0]).not.toHaveProperty("union");
  });

  it.each([
    ["union U = A | A\nnode A { id String @id }", "member A is listed twice"],
    ["union U = Nope", "member Nope, which is not declared"],
    [
      "union U = P | E\ninterface P { id String @id }\nnode E implements P {}\nnode F implements P {}",
      "E is a member twice (through P and directly); list it once",
    ],
    [
      "union U = P | Q\ninterface P { id String @id }\ninterface Q { k String @unique }\nnode E implements P, Q {}",
      "E is a member twice (through P and through Q)",
    ],
    [
      "union U = V\nunion V = A\nnode A { id String @id }",
      "member V, which is a union (list its members instead)",
    ],
    ["union U = R\nenum R { A }", "member R, which is an enum"],
    [
      'union U = E\nnode A { id String @id }\nrelationship E { type "E"\n from A\n to A }',
      "member E, which is a relationship model",
    ],
    ["union String = A\nnode A { id String @id }", "String is a built-in type name"],
    [
      "union A = B\nnode A { id String @id }\nnode B { id String @id }",
      'Duplicate declaration "A"',
    ],
  ])("rejects %j", (src, message) => {
    expect(() => resolveSchema(parseSchema(src))).toThrow(message);
  });

  it("prints and formats a union on one line", () => {
    const src = `// hits\nunion   SearchHit   =  |Post|User // search results\nnode Post { id String @id }\nnode User { id String @id }\n`;
    const formatted = formatSchema(src);
    expect(formatted).toContain("// hits\nunion SearchHit = Post | User // search results\n");
    expect(formatSchema(formatted)).toBe(formatted);
    expect(printSchemaDocument(parseSchema(src))).toContain("union SearchHit = Post | User\n");
  });

  it("keeps comments between members when formatting", () => {
    const src =
      "union U =\n  // first\n  | A\n  | B\nnode A { id String @id }\nnode B { id String @id }\n";
    expect(formatSchema(src)).toContain("// first\nunion U = A | B\n");
  });
});

describe("unions: codegen", () => {
  it("emits the union in the type map and as the discriminated union of its members", () => {
    const out = renderCyphraGenSource(parseSchema(SRC));
    expect(out).toContain(
      'export type SearchHit = ({ __typename: "Post" } & Post) | ({ __typename: "User" } & User);',
    );
    expect(out).toMatch(
      /SearchHit: \{\n {4}scalars: Record<never, never>;\n {4}abstract: true;\n {4}union: true;\n {4}implementations: "Post" \| "User";\n {4}createRequired: never;\n {4}unique: never;\n {4}relations: Record<never, never>;/,
    );
    expect(out).toContain(
      'targets: { target: "SearchHit"; many: true; optional: false; edge: null };',
    );
    // No label for the union.
    expect(out).not.toContain('SearchHit: "SearchHit"');
  });

  it("emits a read schema only (no create or update schema)", () => {
    const out = renderZodFromModel(model());
    expect(out).toContain(
      [
        'export const SearchHitSchema = z.discriminatedUnion("__typename", [',
        '  PostSchema.extend({ __typename: z.literal("Post") }),',
        '  UserSchema.extend({ __typename: z.literal("User") }),',
        "]);",
      ].join("\n"),
    );
    expect(out).not.toContain("SearchHitCreateInputSchema");
    expect(out).not.toContain("SearchHitUpdateInputSchema");
    expect(out.indexOf("SearchHitSchema =")).toBeGreaterThan(out.indexOf("UserSchema ="));
  });
});

describe("unions: typed edges", () => {
  const EDGES = `
union SearchHit = Post | User

node Post {
  id       String @id
  taggedBy Tag[]  @relationship(type: "TAGS", direction: IN)
}

node User {
  id String @id
}

node Tag {
  id      String      @id
  targets SearchHit[] @relationship(type: "TAGS", direction: OUT)
}

relationship Tagging {
  type "TAGS"
  from Tag
  to   SearchHit
  weight Int @default(1)
}
`;

  it("lets a relationship model name a union, for the relation and its members' inverse fields", () => {
    const m = resolveSchema(parseSchema(EDGES));
    const field = (node: string, name: string) =>
      m.nodes.find((n) => n.name === node)!.fields.find((f) => f.name === name);
    expect(m.relationships[0]).toMatchObject({ name: "Tagging", from: "Tag", to: "SearchHit" });
    expect(field("Tag", "targets")).toMatchObject({ target: "SearchHit", edge: "Tagging" });
    expect(field("Post", "taggedBy")).toMatchObject({ target: "Tag", edge: "Tagging" });
  });

  it("types $edge on the relation to the union", () => {
    const out = renderCyphraGenSource(parseSchema(EDGES));
    expect(out).toContain(
      'targets: { target: "SearchHit"; many: true; optional: false; edge: Tagging };',
    );
    expect(out).toContain(
      'taggedBy: { target: "Tag"; many: true; optional: false; edge: Tagging };',
    );
    expect(renderZodFromModel(resolveSchema(parseSchema(EDGES)))).toContain("TaggingSchema");
  });

  it("accepts a union at either end", () => {
    const reversed = EDGES.replace("from Tag\n  to   SearchHit", "from SearchHit\n  to   Tag")
      .replace(
        '@relationship(type: "TAGS", direction: IN)',
        '@relationship(type: "TAGS", direction: OUT)',
      )
      .replace(
        'targets SearchHit[] @relationship(type: "TAGS", direction: OUT)',
        'targets SearchHit[] @relationship(type: "TAGS", direction: IN)',
      );
    const m = resolveSchema(parseSchema(reversed));
    expect(m.relationships[0]).toMatchObject({ from: "SearchHit", to: "Tag" });
    expect(m.nodes.find((n) => n.name === "Tag")!.fields[1]).toMatchObject({ edge: "Tagging" });
  });

  it("rejects a model no field uses (here, the other way round from Tag.targets)", () => {
    const reversed = EDGES.replace("from Tag\n  to   SearchHit", "from SearchHit\n  to   Tag");
    expect(() => resolveSchema(parseSchema(reversed))).toThrow(
      /Relationship "Tagging": no relation field uses it/,
    );
  });
});

describe("unions: interface members", () => {
  const PARTY = `
union Party = Person | Team

interface Person {
  id    String @id
  email String @unique
}

node Employee implements Person {
  salary Int
}

node Customer implements Person {
  tier String
}

node Team {
  id String @id
}
`;

  it("resolves an interface member to its implementations and keeps the declared members", () => {
    const party = resolveSchema(parseSchema(PARTY)).nodes[0]!;
    expect(party).toEqual({
      name: "Party",
      label: "Party",
      abstract: true,
      union: true,
      implementations: ["Employee", "Customer", "Team"],
      members: ["Person", "Team"],
      uniqueFields: [],
      fields: [],
    });
  });

  it("emits the implementations and the interface members in the type map", () => {
    const out = renderCyphraGenSource(parseSchema(PARTY));
    expect(out).toContain(
      '    implementations: "Employee" | "Customer" | "Team";\n    members: "Person";',
    );
    expect(out).toContain("/** `Party` union (`Person` | `Team`)");
    expect(out).toContain(
      'export type Party = ({ __typename: "Employee" } & Employee) | ({ __typename: "Customer" } & Customer) | ({ __typename: "Team" } & Team);',
    );
  });

  it("emits a read schema over the implementations", () => {
    const out = renderZodFromModel(resolveSchema(parseSchema(PARTY)));
    expect(out).toContain(
      [
        "/** `Party` union results (`Person` | `Team`), as the client returns them. */",
        'export const PartySchema = z.discriminatedUnion("__typename", [',
        '  EmployeeSchema.extend({ __typename: z.literal("Employee") }),',
        '  CustomerSchema.extend({ __typename: z.literal("Customer") }),',
        '  TeamSchema.extend({ __typename: z.literal("Team") }),',
        "]);",
      ].join("\n"),
    );
  });

  it("accepts an interface without implementations yet", () => {
    const m = resolveSchema(
      parseSchema("union U = P | A\ninterface P { id String @id }\nnode A { id String @id }"),
    );
    expect(m.nodes[0]).toMatchObject({ implementations: ["A"], members: ["P", "A"] });
  });
});
