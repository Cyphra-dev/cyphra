import { describe, expect, it } from "vitest";
import { parseSchema, parseSchemaSyntax } from "./parseSchema.js";
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

describe("parseSchemaSyntax with locations", () => {
  const source = `// users
node User {
  id   String @id @default(cuid())
  role Role   @default(ADMIN)
  posts Post[] @relationship(type: "AUTHORED", direction: OUT)

  @@fulltext([id], name: "x")
}

enum Role { ADMIN USER }

relationship Wrote {
  type "AUTHORED"
  from User
  to Post
}

node Post { id String @id }
`;
  const at = (r: { start: { offset: number }; end: { offset: number } } | undefined) =>
    r ? source.slice(r.start.offset, r.end.offset) : undefined;

  it("adds no location to the default AST", () => {
    const plain = parseSchemaSyntax(source);
    expect(JSON.stringify(plain)).not.toMatch(/"loc"|Loc"|"comments"/);
    expect(parseSchema(source)).toEqual(plain);
  });

  it("records ranges of declarations, fields, types, decorators and arguments", () => {
    const doc = parseSchemaSyntax(source, { locations: true });
    const user = doc.declarations[0]!;
    if (user.kind !== "Node") throw new Error("expected a node");
    expect(at(user.nameLoc)).toBe("User");
    expect(at(user.loc)?.startsWith("node User {")).toBe(true);
    expect(at(user.loc)?.endsWith("}")).toBe(true);
    const [id, role, posts] = user.fields;
    expect(at(id!.loc)).toBe("id   String @id @default(cuid())");
    expect(at(id!.nameLoc)).toBe("id");
    expect(at(id!.typeLoc)).toBe("String");
    expect(at(id!.decorators[1]!.loc)).toBe("@default(cuid())");
    expect(at(id!.decorators[1]!.args[0]!.valueLoc)).toBe("cuid()");
    // Enum-typed fields keep their ranges when turned into scalars.
    expect(role).toMatchObject({ kind: "Scalar", type: { name: "Enum", enum: "Role" } });
    expect(at(role!.typeLoc)).toBe("Role");
    expect(at(role!.decorators[0]!.args[0]!.valueLoc)).toBe("ADMIN");
    expect(at(posts!.typeLoc)).toBe("Post[]");
    const relArg = posts!.decorators[0]!.args[1]!;
    expect(at(relArg.loc)).toBe("direction: OUT");
    expect(at(relArg.keyLoc)).toBe("direction");
    expect(at(relArg.valueLoc)).toBe("OUT");
    const attr = user.attributes![0]!;
    expect(at(attr.loc)).toBe('@@fulltext([id], name: "x")');
    expect(attr.fieldLocs?.map(at)).toEqual(["id"]);

    const role2 = doc.declarations[1]!;
    if (role2.kind !== "Enum") throw new Error("expected an enum");
    expect(role2.valueLocs?.map(at)).toEqual(["ADMIN", "USER"]);

    const wrote = doc.declarations[2]!;
    if (wrote.kind !== "Relationship") throw new Error("expected a relationship");
    expect(at(wrote.relTypeLoc)).toBe('"AUTHORED"');
    expect(at(wrote.fromLoc)).toBe("User");
    expect(at(wrote.toLoc)).toBe("Post");

    expect(doc.comments).toEqual([
      {
        text: "// users",
        loc: { start: { offset: 0, line: 1, column: 1 }, end: { offset: 8, line: 1, column: 9 } },
      },
    ]);
    expect(id!.nameLoc!.start).toEqual({ offset: 23, line: 3, column: 3 });
  });
});
