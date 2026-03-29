import { describe, expect, it } from "vitest";
import { parseSchema } from "./parseSchema.js";
import { SchemaValidationError } from "./errors.js";

const fullExample = `
node User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String?
  createdAt DateTime @default(now())

  posts Post[] @relationship(type: "AUTHORED", direction: OUT)
  orgs  Organization[] @relationship(type: "MEMBER_OF", direction: OUT, through: Membership)
}

node Post {
  id        String   @id
  title     String
  content   String?
  author    User? @relationship(type: "AUTHORED", direction: IN)
}

node Organization {
  id   String @id
  name String
}

relationship Membership {
  type "MEMBER_OF"
  from User
  to Organization

  role  String
  since DateTime @index
}
`;

describe("parseSchema", () => {
  it("parses the reference User/Post/Org/Membership example", () => {
    const doc = parseSchema(fullExample);
    expect(doc.kind).toBe("Document");
    const names = doc.declarations.map((d) => d.name);
    expect(names).toEqual(["User", "Post", "Organization", "Membership"]);
  });

  it("parameterizes malicious-looking values only as data (scalar field names stay schema)", () => {
    const doc = parseSchema(`
      node N {
        x String
      }
    `);
    expect(doc.declarations[0]).toMatchObject({ kind: "Node", name: "N" });
  });

  it("rejects two @id fields on the same node", () => {
    expect(() =>
      parseSchema(`
      node Bad {
        a String @id
        b String @id
      }
    `),
    ).toThrow(SchemaValidationError);
  });

  it("rejects oversized schema", async () => {
    const { MAX_SCHEMA_BYTES } = await import("./parseSchema.js");
    const huge = "node X { y String }\n".repeat(Math.ceil(MAX_SCHEMA_BYTES / 20) + 10);
    expect(() => parseSchema(huge)).toThrow(SchemaValidationError);
  });

  it("rejects @index with @unique on the same field", () => {
    expect(() =>
      parseSchema(`
      node N {
        x String @unique @index
      }
    `),
    ).toThrow(SchemaValidationError);
  });

  it("allows @index on relationship properties", () => {
    const doc = parseSchema(`
      node A { id String @id }
      relationship R {
        type "T"
        from A
        to A
        meta String @index
      }
    `);
    expect(doc.declarations[1]).toMatchObject({ kind: "Relationship", name: "R" });
  });

  it("rejects duplicate @index on a relationship field", () => {
    expect(() =>
      parseSchema(`
      node A { id String @id }
      relationship R {
        type "T"
        from A
        to A
        x String @index @index
      }
    `),
    ).toThrow(SchemaValidationError);
  });

  it("rejects duplicate @index on the same field", () => {
    expect(() =>
      parseSchema(`
      node N {
        x String @index @index
      }
    `),
    ).toThrow(SchemaValidationError);
  });

  it("rejects @index with @unique on a relationship field", () => {
    expect(() =>
      parseSchema(`
      node A { id String @id }
      relationship R {
        type "T"
        from A
        to A
        x String @unique @index
      }
    `),
    ).toThrow(SchemaValidationError);
  });

  it("rejects duplicate @unique on a relationship field", () => {
    expect(() =>
      parseSchema(`
      node A { id String @id }
      relationship R {
        type "T"
        from A
        to A
        x String @unique @unique
      }
    `),
    ).toThrow(SchemaValidationError);
  });

  it("rejects @id on a relationship field", () => {
    expect(() =>
      parseSchema(`
      node A { id String @id }
      relationship R {
        type "T"
        from A
        to A
        x String @id
      }
    `),
    ).toThrow(SchemaValidationError);
  });

  it("allows @unique on relationship properties", () => {
    const doc = parseSchema(`
      node A { id String @id }
      relationship R {
        type "T"
        from A
        to A
        token String @unique
      }
    `);
    expect(doc.declarations[1]).toMatchObject({ kind: "Relationship", name: "R" });
  });
});
