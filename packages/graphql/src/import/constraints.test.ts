import { parseSchema, printSchemaDocument, resolveSchema } from "@cyphra/schema";
import { describe, expect, it } from "vitest";
import type { UniquenessConstraint } from "./constraints.js";
import { convertGraphQLTypeDefs, type GraphQLImportOptions } from "./convert.js";
import type { ImportIssue } from "./mappings.js";

function convert(sdl: string, options?: GraphQLImportOptions) {
  const result = convertGraphQLTypeDefs(sdl, options);
  const schema = printSchemaDocument(result.document);
  resolveSchema(parseSchema(schema));
  return { schema, issues: result.issues };
}

function issueAt(issues: readonly ImportIssue[], at: string): ImportIssue | undefined {
  return issues.find((i) => i.at === at);
}

const unique = (label: string, ...properties: string[]): UniquenessConstraint => ({
  name: `${label.toLowerCase()}_${properties.join("_")}`,
  label,
  properties,
  type: "UNIQUE",
});

describe("uniqueness constraints of the database", () => {
  it("leave id: ID! as is without a database or hint", () => {
    const { schema, issues } = convert(`type User @node { id: ID! }`);
    expect(schema).toBe("node User {\n  id String\n}\n");
    expect(issues).toEqual([]);
  });

  it("mark a constrained ID field @id, without a default", () => {
    const { schema, issues } = convert(`type User @node { id: ID! email: String! }`, {
      constraints: [unique("User", "id"), unique("User", "email")],
    });
    expect(schema).toBe("node User {\n  id String @id\n  email String @unique\n}\n");
    expect(issueAt(issues, "User.id")?.message).toMatch(
      /uniqueness constraint user_id on :User\(id\): marked @id; no default/,
    );
    expect(issueAt(issues, "User.email")?.message).toMatch(/marked @unique$/);
  });

  it("use @unique when the node has an @id or the field is optional", () => {
    const { schema, issues } = convert(`type T @node { id: ID! @id slug: ID! ref: ID }`, {
      constraints: [unique("T", "slug"), unique("T", "ref")],
    });
    expect(schema).toContain("slug String @unique");
    expect(schema).toContain("ref String? @unique");
    expect(issueAt(issues, "T.slug")?.message).toMatch(/already has an @id/);
    expect(issueAt(issues, "T.ref")?.message).toMatch(/optional/);
  });

  it("confirm a field that is already @id", () => {
    const { schema, issues } = convert(`type T @node { id: ID! @id }`, {
      constraints: [unique("T", "id")],
    });
    expect(schema).toContain("id String @id @default(uuid())");
    expect(issues.find((i) => i.feature === "constraint")?.message).toMatch(
      /already @id; uniqueness constraint t_id backs it/,
    );
  });

  it("use the Neo4j property name of an @alias field", () => {
    const { schema } = convert(`type T @node { key: ID! @alias(property: "uid") }`, {
      constraints: [unique("T", "uid")],
    });
    expect(schema).toContain("uid String @id");
  });

  it("report the ID fields no constraint covers", () => {
    const { issues } = convert(`type T @node { id: ID! name: String }`, { constraints: [] });
    expect(issueAt(issues, "T.id")?.message).toMatch(
      /no uniqueness constraint on :T\(id\).*--id-fields T\.id/,
    );
    expect(issueAt(issues, "T.name")).toBeUndefined();
  });

  it("ignore constraints on labels the type definitions do not use", () => {
    const { issues } = convert(`type T @node { id: ID! }`, {
      constraints: [unique("Other", "id"), unique("T", "id")],
    });
    expect(issues.map((i) => i.at)).toEqual(["T.id"]);
  });

  it("map a constraint over several properties to @@unique", () => {
    const { schema, issues } = convert(`type T @node { a: String! b: Int! c: [Int!] }`, {
      constraints: [unique("T", "a", "b"), unique("T", "a", "c")],
    });
    expect(schema).toContain("@@unique([a, b])");
    expect(issues.find((i) => i.message.includes("t_a_c"))).toMatchObject({
      severity: "unsupported",
    });
  });

  it("report a constraint on a missing field", () => {
    const { issues } = convert(`type T @node { id: ID! }`, { constraints: [unique("T", "gone")] });
    expect(issueAt(issues, "T.gone")?.message).toMatch(/no scalar field "gone"/);
  });

  it("put a shared label's constraint on the interface", () => {
    const { schema } = convert(
      `
      type A @node(labels: ["A", "S"]) { id: ID! }
      type B @node(labels: ["B", "S"]) { id: ID! }
    `,
      { constraints: [{ name: "s_key", label: "S", properties: ["id"], type: "KEY" }] },
    );
    expect(schema).toContain("interface S {\n  id String @id\n}");
  });

  it("keep a field on its nodes when the constraint is on their own label", () => {
    const { schema, issues } = convert(
      `
      type A @node(labels: ["A", "S"]) { id: ID! name: String }
      type B @node(labels: ["B", "S"]) { id: ID! name: String }
    `,
      { constraints: [unique("A", "id")] },
    );
    expect(schema).toContain("interface S {\n  name String?\n}");
    expect(schema).toContain("node A implements S {\n  id String @id\n}");
    expect(schema).toContain("node B implements S {\n  id String\n}");
    expect(issueAt(issues, "S")?.message).toMatch(
      /kept on each implementation: id \(uniqueness constraint a_id is on :A\)/,
    );
  });

  it("report a constraint on a label mapped to @@labels", () => {
    const { issues } = convert(
      `
      type A @node(labels: ["A", "S"]) { id: ID! }
      type B @node(labels: ["B", "S"]) { id: Int! }
    `,
      { constraints: [unique("S", "id")] },
    );
    expect(issueAt(issues, "S")).toMatchObject({ severity: "unsupported" });
    expect(issueAt(issues, "S")?.message).toMatch(/not an interface/);
  });
});

describe("--id-fields hints", () => {
  it("mark the field @id", () => {
    const { schema, issues } = convert(`type Tag @node { key: String! }`, {
      idFields: ["Tag.key"],
    });
    expect(schema).toContain("key String @id");
    expect(issueAt(issues, "Tag.key")).toMatchObject({ feature: "--id-fields" });
  });

  it("name a shared label or interface", () => {
    const { schema } = convert(
      `
      type A @node(labels: ["A", "S"]) { id: ID! }
      type B @node(labels: ["B", "S"]) { id: ID! }
    `,
      { idFields: ["S.id"] },
    );
    expect(schema).toContain("interface S {\n  id String @id\n}");
  });

  it("report what they do not match", () => {
    const { issues } = convert(`type T @node { id: ID! }`, {
      idFields: ["T.nope", "Nope.id", "garbage", ""],
    });
    expect(issueAt(issues, "T.nope")?.message).toMatch(/no converted scalar field/);
    expect(issueAt(issues, "Nope.id")?.message).toMatch(/not a converted @node type/);
    expect(issueAt(issues, "--id-fields")?.message).toMatch(/"garbage" is not Type.field/);
    expect(issues).toHaveLength(3);
  });
});
