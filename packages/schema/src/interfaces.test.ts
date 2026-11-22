import { describe, expect, it } from "vitest";
import { formatSchema } from "./formatSchema.js";
import { nodeLabels, resolveSchema } from "./model.js";
import { parseSchema } from "./parseSchema.js";
import { printSchemaDocument } from "./printSchema.js";
import { renderCyphraGenSource } from "./renderCyphraGen.js";

const SRC = `
interface Person {
  id      String  @id @default(cuid())
  email   String  @unique
  name    String
  manager Person? @relationship(type: "MANAGES", direction: IN)

  @@unique([name, email], name: "nameEmail")
  @@fulltext([name])
}

interface Archivable {}

node Employee implements Person, Archivable {
  salary Int @default(0)
  team   Team? @relationship(type: "MEMBER_OF", direction: OUT)

  @@index([name, salary])
}

node Customer implements Person {
  tier String
}

node Team {
  id      String     @id
  members Employee[] @relationship(type: "MEMBER_OF", direction: IN)
  owner   Person?    @relationship(type: "OWNS", direction: IN)
}
`;

const model = () => resolveSchema(parseSchema(SRC));
const node = (name: string) => model().nodes.find((n) => n.name === name)!;

describe("interfaces: parsing", () => {
  it("parses interface and implements", () => {
    const doc = parseSchema(SRC);
    const [person, archivable, employee] = doc.declarations;
    expect(person).toMatchObject({ kind: "Node", name: "Person", abstract: true });
    expect(person).not.toHaveProperty("implements");
    expect(archivable).toMatchObject({ kind: "Node", name: "Archivable", fields: [] });
    expect(employee).toMatchObject({ name: "Employee", implements: ["Person", "Archivable"] });
    expect(employee).not.toHaveProperty("abstract");
  });

  it("keeps plain nodes free of the new keys", () => {
    const doc = parseSchema("node A { id String @id }");
    expect(Object.keys(doc.declarations[0]!)).toEqual(["kind", "name", "fields"]);
  });

  it("records implements locations", () => {
    const doc = parseSchema("interface I {}\nnode A implements I { x Int }", { locations: true });
    const a = doc.declarations[1]!;
    expect(a.kind === "Node" && a.implementsLocs?.[0]?.start).toMatchObject({
      line: 2,
      column: 19,
    });
  });

  it("prints and formats interface headers", () => {
    const printed = printSchemaDocument(parseSchema(SRC));
    expect(printed).toContain("interface Person {");
    expect(printed).toContain("node Employee implements Person, Archivable {");
    expect(printSchemaDocument(parseSchema(printed))).toBe(printed);
    const formatted = formatSchema("interface   P {\n name String }\nnode X implements   P {}\n");
    expect(formatted).toContain("interface P {");
    expect(formatted).toContain("node X implements P {");
  });

  it("does not take a field named like the keywords for one", () => {
    const doc = parseSchema("node A { implements String\n interface Int }");
    const a = doc.declarations[0]!;
    expect(a.kind === "Node" && a.fields.map((f) => f.name)).toEqual(["implements", "interface"]);
  });
});

describe("interfaces: resolution", () => {
  it("marks interfaces abstract with their implementations", () => {
    expect(node("Person")).toMatchObject({
      abstract: true,
      implementations: ["Employee", "Customer"],
      label: "Person",
      idField: "id",
      uniqueFields: ["id", "email"],
    });
    expect(node("Archivable")).toMatchObject({ abstract: true, implementations: ["Employee"] });
  });

  it("gives implementations inherited fields first, their labels and inherited keys", () => {
    const e = node("Employee");
    expect(e.interfaces).toEqual(["Person", "Archivable"]);
    expect(e.labels).toEqual(["Employee", "Person", "Archivable"]);
    expect(nodeLabels(e)).toEqual(["Employee", "Person", "Archivable"]);
    expect(nodeLabels(node("Person"))).toEqual(["Person"]);
    expect(e.fields.map((f) => [f.name, f.inheritedFrom])).toEqual([
      ["id", "Person"],
      ["email", "Person"],
      ["name", "Person"],
      ["manager", "Person"],
      ["salary", undefined],
      ["team", undefined],
    ]);
    expect(e.idField).toBe("id");
    expect(e.uniqueFields).toEqual(["id", "email"]);
    expect(e.compoundUniques).toEqual([
      { name: "nameEmail", key: "nameEmail", fields: ["name", "email"], inheritedFrom: "Person" },
    ]);
    expect(e.compoundIndexes).toEqual([
      { name: "Employee_name_salary_idx", fields: ["name", "salary"] },
    ]);
    expect(e.fulltextIndexes).toEqual([
      { name: "Person_name_fulltext", fields: ["name"], inheritedFrom: "Person" },
    ]);
  });

  it("leaves plain nodes unchanged", () => {
    const team = node("Team");
    expect(team).not.toHaveProperty("labels");
    expect(team).not.toHaveProperty("abstract");
    const plain = resolveSchema(parseSchema("node A { id String @id }")).nodes[0]!;
    expect(Object.keys(plain)).toEqual(["name", "label", "idField", "uniqueFields", "fields"]);
  });

  it("resolves relations to interfaces and edge models naming an interface", () => {
    const m = resolveSchema(
      parseSchema(`
        interface P { id String @id
          teams Team[] @relationship(type: "IN", direction: OUT) }
        node E implements P {
          lead Team? @relationship(type: "LEADS", direction: OUT) }
        node Team { id String @id }
        relationship In { type "IN" from P to Team
          since Int? }
        relationship Leads { type "LEADS" from P to Team
          at Int? }
      `),
    );
    const e = m.nodes.find((n) => n.name === "E")!;
    expect(e.fields.find((f) => f.name === "teams")).toMatchObject({
      edge: "In",
      inheritedFrom: "P",
    });
    expect(e.fields.find((f) => f.name === "lead")).toMatchObject({ edge: "Leads" });
  });

  it.each([
    ["node A implements B {}\nnode B {}", /implements B, which is not an interface/],
    ["node A implements Nope {}", /implements Nope, which is not an interface \(not declared\)/],
    ["interface I {}\nnode A implements I, I {}", /implements I twice/],
    ["interface I {}\ninterface J implements I {}", /write `interface J extends I`/],
    ["interface I {}\nnode A extends I {}", /write `node A implements I`/],
    ["node B {}\ninterface J extends B {}", /extends B, which is not an interface/],
    ["interface I extends J {}\ninterface J extends I {}", /I extends J extends I/],
    ["interface I extends I {}", /cannot extend themselves \(I extends I\)/],
    ["interface I {}\ninterface J extends I, I {}", /extends I twice/],
    [
      "interface I { name String }\ninterface J extends I { name String }",
      /field "name": already inherited from interface I/,
    ],
    [
      "interface I { name String }\ninterface J extends I {}\nnode A implements J { name Int }",
      /field "name": already inherited from interface I/,
    ],
    [
      "interface I { id String @id }\ninterface J extends I {}\ninterface K { key String @id }\nnode A implements J, K {}",
      /I and K both declare an @id field/,
    ],
    [
      "interface I { name String }\nnode A implements I { name String }",
      /field "name": already inherited from interface I/,
    ],
    [
      "interface I { name String }\ninterface J { name Int }\nnode A implements I, J {}",
      /field "name" is declared by both I and J/,
    ],
    [
      "interface I { id String @id }\ninterface J { key String @id }\nnode A implements I, J {}",
      /I and J both declare an @id field/,
    ],
    [
      "interface I { id String @id }\nnode A implements I { key String @id }",
      /@id conflicts with the @id inherited from I/,
    ],
    [
      'interface I { a Int\n b Int\n @@unique([a, b], name: "k") }\nnode A implements I { k Int }',
      /key "k" is already a field/,
    ],
    ["interface I { a String @id\n b String @id }", /Interface "I" must have at most one @id/],
  ])("rejects %j", (src, error) => {
    expect(() => resolveSchema(parseSchema(src))).toThrow(error);
  });

  it("lets model attributes of an implementation name inherited fields", () => {
    const m = resolveSchema(
      parseSchema(
        "interface I { a String }\nnode A implements I { b String\n @@unique([a, b])\n @@fulltext([a, b]) }",
      ),
    );
    expect(m.nodes[1]).toMatchObject({
      compoundUniques: [{ key: "a_b", fields: ["a", "b"] }],
      fulltextIndexes: [{ name: "A_a_b_fulltext", fields: ["a", "b"] }],
    });
  });
});

describe("interfaces: codegen", () => {
  it("emits abstract and implementations in the type map, and labels in the model", () => {
    const out = renderCyphraGenSource(parseSchema(SRC));
    expect(out).toContain(
      "/** `Person` interface properties (shared by `Employee`, `Customer`). */",
    );
    expect(out).toContain("export type Archivable = Record<never, never>;");
    expect(out).toContain('    abstract: true;\n    implementations: "Employee" | "Customer";');
    expect(out).toContain(
      "/** `Employee` node properties (labels `:Employee`, `:Person`, `:Archivable`). */",
    );
    expect(out).toMatch(/"labels": \[\s*"Employee",\s*"Person",\s*"Archivable"\s*\]/);
  });
});

const NESTED = `
interface Person {
  id    String @id @default(cuid())
  email String @unique
  name  String
  @@fulltext([name])
}

interface Staff extends Person {
  badge String @unique
  team  Team?  @relationship(type: "MEMBER_OF", direction: OUT)
}

interface Contact extends Person {
  phone String?
}

node Employee implements Staff, Contact {
  salary Int
}

node Customer implements Contact {
  tier String
}

node Team {
  id      String  @id
  members Staff[] @relationship(type: "MEMBER_OF", direction: IN)
}
`;

describe("interfaces extending interfaces", () => {
  const m = resolveSchema(parseSchema(NESTED));
  const node = (n: string) => m.nodes.find((x) => x.name === n)!;

  it("inherits fields transitively, once through a diamond, tagged with the declaring interface", () => {
    expect(node("Staff")).toMatchObject({
      abstract: true,
      extends: ["Person"],
      interfaces: ["Person"],
      implementations: ["Employee"],
      idField: "id",
      uniqueFields: ["id", "email", "badge"],
    });
    expect(node("Staff").labels).toBeUndefined();
    expect(node("Staff").fields.map((f) => [f.name, f.inheritedFrom])).toEqual([
      ["id", "Person"],
      ["email", "Person"],
      ["name", "Person"],
      ["badge", undefined],
      ["team", undefined],
    ]);
    expect(node("Employee").fields.map((f) => [f.name, f.inheritedFrom])).toEqual([
      ["id", "Person"],
      ["email", "Person"],
      ["name", "Person"],
      ["badge", "Staff"],
      ["team", "Staff"],
      ["phone", "Contact"],
      ["salary", undefined],
    ]);
    expect(node("Employee").fulltextIndexes).toEqual([
      expect.objectContaining({ name: "Person_name_fulltext", inheritedFrom: "Person" }),
    ]);
  });

  it("gives a node every label it inherits and an interface every node below it", () => {
    expect(node("Employee").interfaces).toEqual(["Staff", "Person", "Contact"]);
    expect(nodeLabels(node("Employee"))).toEqual(["Employee", "Staff", "Person", "Contact"]);
    expect(nodeLabels(node("Customer"))).toEqual(["Customer", "Contact", "Person"]);
    expect(node("Person").implementations).toEqual(["Employee", "Customer"]);
    expect(node("Contact").implementations).toEqual(["Employee", "Customer"]);
    expect(nodeLabels(node("Staff"))).toEqual(["Staff"]);
  });

  it("prints and formats extends", () => {
    const doc = parseSchema(NESTED);
    expect(printSchemaDocument(doc)).toContain("interface Staff extends Person {");
    expect(
      formatSchema("interface A {}\ninterface   B   extends  A ,A2 {}\ninterface A2 {}\n"),
    ).toContain("interface B extends A, A2 {");
    expect(doc.declarations[1]).toMatchObject({
      kind: "Node",
      abstract: true,
      extends: ["Person"],
    });
  });

  it("emits the transitive implementations in the type map", () => {
    const out = renderCyphraGenSource(parseSchema(NESTED));
    expect(out).toMatch(/Staff: \{[^}]*abstract: true;\s*implementations: "Employee";/s);
  });
});
