import { parseSchema, printSchemaDocument, resolveSchema } from "@cyphra/schema";
import { describe, expect, it } from "vitest";
import { convertGraphQLTypeDefs, type GraphQLImportOptions } from "./convert.js";
import type { ImportIssue } from "./mappings.js";

function convert(sdl: string, options?: GraphQLImportOptions) {
  const result = convertGraphQLTypeDefs(sdl, options);
  const schema = printSchemaDocument(result.document);
  const model = resolveSchema(parseSchema(schema));
  return { schema, model, issues: result.issues };
}

function issueAt(issues: readonly ImportIssue[], at: string): ImportIssue | undefined {
  return issues.find((i) => i.at === at);
}

describe("shared @node labels", () => {
  const SDL = `
    type Lab @node(labels: ["Lab", "LearningActivity"]) {
      id: ID! @id
      title: String!
      environment: String!
    }
    type Quiz @node(labels: ["Quiz", "LearningActivity"]) {
      id: ID! @id
      title: String!
      passMark: Int!
    }
  `;

  it("become an interface holding the common fields", () => {
    const { schema, model, issues } = convert(SDL);
    expect(schema).toContain(
      "interface LearningActivity {\n  id String @id @default(uuid())\n  title String\n}",
    );
    expect(schema).toContain("node Lab implements LearningActivity {\n  environment String\n}");
    expect(schema).toContain("node Quiz implements LearningActivity {\n  passMark Int\n}");
    // Cyphra writes and matches both labels, like v7.
    expect(model.nodes.find((n) => n.name === "Lab")?.labels).toEqual(["Lab", "LearningActivity"]);
    expect(issueAt(issues, "LearningActivity")).toMatchObject({
      severity: "changed",
      feature: "@node(labels)",
    });
    expect(issueAt(issues, "LearningActivity")?.message).toMatch(
      /label shared by Lab and Quiz: mapped to interface LearningActivity.*fields id and title.*uniqueness of id now spans every :LearningActivity/,
    );
  });

  it("become @@labels when a common field differs", () => {
    const { schema, model, issues } = convert(`
      type Lab @node(labels: ["Lab", "Activity"]) { title: String! }
      type Quiz @node(labels: ["Quiz", "Activity"]) { title: String }
    `);
    expect(schema).not.toContain("interface");
    expect(schema).toContain("@@labels([Activity])");
    expect(model.nodes.find((n) => n.name === "Quiz")?.dynamicLabels).toEqual(["Activity"]);
    expect(issueAt(issues, "Lab")?.message).toMatch(
      /became @@labels\(\[Activity\]\).*field "title" differs: Lab has `title String`, Quiz has `title String\?`/,
    );
    expect(issueAt(issues, "Quiz")?.severity).toBe("changed");
  });

  it("on one type become an interface without fields", () => {
    const { schema } = convert(`type A @node(labels: ["A", "Flagged"]) { x: Int }`);
    expect(schema).toContain("interface Flagged {\n}");
    expect(schema).toContain("node A implements Flagged {\n  x Int?\n}");
  });

  it("collect several labels per type", () => {
    const { schema } = convert(`
      type A @node(labels: ["A", "X", "Y"]) { x: Int }
      type B @node(labels: ["B", "Y"]) { x: Int! }
      type C @node(labels: ["C", "Y"]) { x: String }
    `);
    expect(schema).toContain("node A implements X {");
    expect(schema).toContain("@@labels([Y])");
  });

  it("are not converted when a label is another node's label", () => {
    const { schema, issues } = convert(`
      type Person @node { name: String }
      type Mentor @node(labels: ["Mentor", "Person"]) { name: String }
    `);
    expect(schema).toContain("node Mentor {");
    expect(issueAt(issues, "Mentor")).toMatchObject({ severity: "unsupported" });
    expect(issueAt(issues, "Mentor")?.message).toMatch(/label of node Person/);
  });

  it("become @@labels when the name is taken by another type", () => {
    const { schema, issues } = convert(`
      enum Status { OPEN }
      type A @node(labels: ["A", "Status"]) { s: Status }
    `);
    expect(schema).toContain("@@labels([Status])");
    expect(issueAt(issues, "A")?.message).toMatch(/already the name of a type/);
  });

  it("compare fields by their Cyphra definition (@alias included)", () => {
    const { schema } = convert(`
      type A @node(labels: ["A", "S"]) { t: String @alias(property: "title") }
      type B @node(labels: ["B", "S"]) { t: String @alias(property: "title") }
    `);
    expect(schema).toContain("interface S {\n  title String?\n}");
  });

  it("move a relationship with properties to the interface end", () => {
    const { schema } = convert(`
      type A @node(labels: ["A", "S"]) {
        tags: [Tag!]! @relationship(type: "TAGGED", direction: OUT, properties: "Tagged")
      }
      type B @node(labels: ["B", "S"]) {
        tags: [Tag!]! @relationship(type: "TAGGED", direction: OUT, properties: "Tagged")
      }
      type Tag @node { name: String }
      type Tagged @relationshipProperties { at: DateTime }
    `);
    expect(schema).toContain(
      'interface S {\n  tags Tag[] @relationship(type: "TAGGED", direction: OUT)\n}',
    );
    expect(schema).toMatch(/relationship Tagged \{\n {2}type "TAGGED"\n {2}from S\n {2}to Tag\n/);
    expect(schema.match(/relationship /g)).toHaveLength(1);
  });

  it("do not move an @id twice for a node with two interfaces", () => {
    const { schema } = convert(`
      type A @node(labels: ["A", "S", "T"]) { id: ID! @id }
      type B @node(labels: ["B", "S", "T"]) { id: ID! @id }
    `);
    expect(schema).toContain("interface S {\n  id String @id @default(uuid())\n}");
    expect(schema).toContain("interface T {\n}");
    expect(schema).toContain("node A implements S, T {");
  });
});

describe("GraphQL interfaces", () => {
  it("map to an interface when every implementation carries the label", () => {
    const { schema, model, issues } = convert(`
      interface Production { title: String! }
      type Movie implements Production @node(labels: ["Movie", "Production"]) {
        title: String!
        runtime: Int
      }
      type Series implements Production @node(labels: ["Series", "Production"]) {
        title: String!
        episodes: Int
      }
      type Person @node {
        actedIn: [Production!]! @relationship(type: "ACTED_IN", direction: OUT, properties: "ActedIn")
      }
      type ActedIn @relationshipProperties { role: String }
    `);
    expect(schema).toContain("interface Production {\n  title String\n}");
    expect(schema).toContain("node Movie implements Production {");
    expect(schema).toContain(
      'actedIn Production[] @relationship(type: "ACTED_IN", direction: OUT)',
    );
    expect(schema).toMatch(
      /relationship ActedIn \{\n {2}type "ACTED_IN"\n {2}from Person\n {2}to Production\n/,
    );
    expect(model.nodes.find((n) => n.name === "Series")?.labels).toEqual(["Series", "Production"]);
    expect(issueAt(issues, "Production")).toMatchObject({
      severity: "changed",
      feature: "interface",
    });
    expect(issueAt(issues, "Production")?.message).toMatch(
      /carry its label through @node\(labels\)/,
    );
  });

  it("are not converted when the implementations do not carry the label", () => {
    const { schema, issues } = convert(`
      interface Production { title: String! }
      type Movie implements Production @node { title: String! }
      type Person @node {
        actedIn: [Production!]! @relationship(type: "ACTED_IN", direction: OUT)
      }
    `);
    expect(schema).not.toContain("interface");
    expect(schema).toContain("node Movie {\n  title String\n}");
    expect(schema).not.toContain("actedIn Production");
    expect(issueAt(issues, "Production")).toMatchObject({ severity: "unsupported" });
    expect(issueAt(issues, "Production")?.message).toMatch(/--add-interface-labels/);
    expect(issueAt(issues, "Person.actedIn")?.message).toMatch(/"Production" was not converted/);
  });

  it("map with addInterfaceLabels and report the Cypher that adds the label", () => {
    const { schema, issues } = convert(
      `
      interface Production { title: String! }
      type Movie implements Production @node(labels: ["Film", "Archive"]) { title: String! }
      type Person @node {
        actedIn: [Production!]! @relationship(type: "ACTED_IN", direction: OUT)
      }
    `,
      { addInterfaceLabels: true },
    );
    expect(schema).toContain("interface Production {\n  title String\n}");
    expect(schema).toContain("node Film implements Production, Archive {\n}");
    expect(schema).toContain("actedIn Production[]");
    const movie = issues.filter((i) => i.at === "Movie").map((i) => i.message);
    expect(movie.join("\n")).toContain("MATCH (n:Film:Archive) SET n:Production");
  });

  it("are not converted when the implementations differ", () => {
    const { schema, issues } = convert(
      `
      interface Production { title: String }
      type Movie implements Production @node { title: String! }
      type Series implements Production @node { title: String }
    `,
      { addInterfaceLabels: true },
    );
    expect(schema).not.toContain("interface");
    expect(issueAt(issues, "Production")?.message).toMatch(/field "title" differs/);
  });

  it("are not converted without @node implementations", () => {
    const { issues } = convert(`
      interface Named { name: String }
      type Stats implements Named { name: String }
      type T @node { x: Int }
    `);
    expect(issueAt(issues, "Named")?.message).toMatch(/no @node type implements it/);
  });

  it("share a field once with a label interface of the same nodes", () => {
    const { schema } = convert(`
      interface Named { name: String! }
      type A implements Named @node(labels: ["A", "Named", "Tagged"]) { name: String! code: Int }
      type B implements Named @node(labels: ["B", "Named", "Tagged"]) { name: String! code: Int }
    `);
    expect(schema).toContain("interface Named {\n  name String\n}");
    expect(schema).toContain("interface Tagged {\n  code Int?\n}");
    expect(schema).toContain("node A implements Named, Tagged {\n}");
  });

  it("reject implementing a type that is not an interface", () => {
    expect(() => convert(`type A { x: Int }\ntype B implements A @node { x: Int }`)).toThrow(
      /can only implement interfaces/,
    );
  });
});
