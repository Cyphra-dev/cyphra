import { parseSchema, resolveSchema } from "@cyphra/schema";
import { describe, expect, it } from "vitest";
import { convertGraphQLTypeDefs } from "./convert.js";
import { mergeImportedSchema } from "./print.js";

const TYPEDEFS = `
  scalar Geo
  type User @node {
    id: ID! @id
    email: String!
    age: Int
    loc: Geo
    posts: [Post!]! @relationship(type: "WROTE", direction: OUT)
  }
  type Post @node { id: ID! @id, title: String! }
`;

describe("mergeImportedSchema", () => {
  it("keeps existing models, fields and comments and adds what is missing", () => {
    const existing = `// My schema
node User {
  id String @id @default(cuid()) // keep cuid
  email String @unique
  // nickname comes from the old app
  nickname String?
}

node Audit {
  at DateTime @default(now())
}
`;
    const { source, issues } = mergeImportedSchema(existing, convertGraphQLTypeDefs(TYPEDEFS));
    expect(source).toBe(`// My schema
node User {
  id String @id @default(cuid()) // keep cuid
  email String @unique
  // nickname comes from the old app
  nickname String?
  age Int?
  posts Post[] @relationship(type: "WROTE", direction: OUT)
  // loc: Geo (not converted: type not supported)
}

node Audit {
  at DateTime @default(now())
}

// Imported from @neo4j/graphql type definitions with \`cyphra import graphql\`.

node Post {
  id String @id @default(uuid())
  title String
}
`);
    expect(issues.map((i) => i.at)).toEqual(["User.id", "User.email"]);
    resolveSchema(parseSchema(source));
  });

  it("is idempotent", () => {
    const result = convertGraphQLTypeDefs(TYPEDEFS);
    const once = mergeImportedSchema("node User {\n  id String @id\n}\n", result).source;
    const twice = mergeImportedSchema(once, result);
    expect(twice.source).toBe(once);
  });

  it("handles a closing brace on the last field line", () => {
    const { source } = mergeImportedSchema(
      "node Post { id String @id @default(uuid()) }\n",
      convertGraphQLTypeDefs(`type Post @node { id: ID! @id, title: String! }`),
    );
    expect(source).toBe("node Post { id String @id @default(uuid())\n  title String\n}\n");
  });

  it("keeps an existing relationship model", () => {
    const existing = `node A {
  bs B[] @relationship(type: "R", direction: OUT)
}

node B {
  x Int?
}

relationship P {
  type "R"
  from A
  to B
  since Int?
}
`;
    const { source, issues } = mergeImportedSchema(
      existing,
      convertGraphQLTypeDefs(`
        type A @node { bs: [B!]! @relationship(type: "R", direction: OUT, properties: "P") }
        type B @node { x: Int }
        type P @relationshipProperties { since: Int!, note: String }
      `),
    );
    expect(source).toBe(existing);
    expect(issues).toEqual([expect.objectContaining({ at: "P", feature: "--merge" })]);
  });

  it("adds full-text indexes the existing node lacks, once", () => {
    const result = convertGraphQLTypeDefs(`
      type Post @node @fulltext(indexes: [
        { indexName: "PostTitle", queryName: "q1", fields: ["title"] }
        { indexName: "PostText", queryName: "q2", fields: ["title", "body"] }
      ]) { title: String!, body: String }
    `);
    const existing = `node Post {
  title String
  body String?

  @@fulltext([title], name: "PostTitle", analyzer: "english")
}
`;
    const { source, issues } = mergeImportedSchema(existing, result);
    expect(source).toBe(`node Post {
  title String
  body String?

  @@fulltext([title], name: "PostTitle", analyzer: "english")
  @@fulltext([title, body], name: "PostText")
}
`);
    expect(issues).toEqual([
      expect.objectContaining({
        at: "Post",
        feature: "--merge",
        message: expect.stringMatching(/PostTitle/),
      }),
    ]);
    expect(mergeImportedSchema(source, result).source).toBe(source);
  });

  it("throws when the merged schema does not resolve", () => {
    expect(() =>
      mergeImportedSchema(
        "node Post {\n  id String @id\n}\n",
        convertGraphQLTypeDefs(`type Post @node { uid: ID! @id }`),
      ),
    ).toThrow(/invalid schema/);
  });

  it("reports the interfaces an existing node does not implement", () => {
    const existing = `node Lab {
  id String @id
  title String
}
`;
    const result = convertGraphQLTypeDefs(`
      type Lab @node(labels: ["Lab", "Activity"]) { id: ID! title: String! }
      type Quiz @node(labels: ["Quiz", "Activity"]) { id: ID! title: String! }
    `);
    const { source, issues } = mergeImportedSchema(existing, result);
    expect(source).toContain("interface Activity {");
    expect(source).toContain("node Quiz implements Activity {");
    expect(source).toContain("node Lab {\n  id String @id\n  title String\n}");
    expect(issues.find((i) => i.at === "Lab")?.message).toMatch(/implements Activity: kept yours/);
    resolveSchema(parseSchema(source));
  });
});
