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
      "union U = P\ninterface P { id String @id }\nnode E implements P {}\nnode F implements P {}",
      "member P, which is an interface (list its implementations instead: E | F)",
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
    [
      'union U = A\nnode A { id String @id }\nrelationship E { type "E"\n from A\n to U }',
      "U is a union; a relationship model's ends are nodes or interfaces",
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
