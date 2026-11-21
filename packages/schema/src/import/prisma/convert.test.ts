import { describe, expect, it } from "vitest";
import { resolveSchema } from "../../model.js";
import { parseSchema } from "../../parseSchema.js";
import { printSchemaDocument } from "../../printSchema.js";
import type { ImportIssue } from "../print.js";
import { convertPrismaSchema } from "./convert.js";
import { mergePrismaImport } from "./index.js";
import { upperSnake } from "./mappings.js";
import { PrismaImportError, parsePrismaSchema } from "./parse.js";

/** Convert, check the result resolves, and return the printed schema and the issues. */
function convert(prisma: string): { schema: string; issues: readonly ImportIssue[] } {
  const result = convertPrismaSchema(prisma);
  const schema = printSchemaDocument(result.document);
  resolveSchema(parseSchema(schema));
  return { schema, issues: result.issues };
}

function issueAt(issues: readonly ImportIssue[], at: string, feature?: string) {
  return issues.find((i) => i.at === at && (feature === undefined || i.feature === feature));
}

describe("parsePrismaSchema", () => {
  it("reads blocks, fields, attributes, arrays, functions and comments", () => {
    const schema = parsePrismaSchema(`
      // comment
      datasource db {
        provider = "postgresql"
        url      = env("DATABASE_URL")
      }
      /// doc comment
      model A {
        id   String  @id @default(cuid()) // trailing
        tags String[]
        n    Int?    @db.SmallInt
        x    Unsupported("tsvector")?
        @@index([n(sort: Desc), id], type: BTree)
        @@map("a")
      }
      enum E {
        X
        Y @map("y")
      }
    `);
    const [ds, model, e] = schema.blocks;
    expect(ds).toMatchObject({ kind: "datasource", name: "db" });
    expect(model).toMatchObject({
      kind: "model",
      name: "A",
      fields: [
        {
          name: "id",
          type: "String",
          optional: false,
          list: false,
          attributes: [
            { name: "id", args: [] },
            { name: "default", args: [{ value: { kind: "ident", name: "cuid", args: [] } }] },
          ],
        },
        { name: "tags", list: true },
        { name: "n", optional: true, attributes: [{ name: "db.SmallInt" }] },
        { name: "x", type: "Unsupported", unsupported: "tsvector", optional: true },
      ],
      attributes: [{ name: "index" }, { name: "map" }],
    });
    expect(e).toMatchObject({ kind: "enum", values: [{ name: "X" }, { name: "Y" }] });
  });

  it("reports syntax errors with a position", () => {
    expect(() => parsePrismaSchema("model A {\n  id String @id(\n}", "x.prisma")).toThrow(
      PrismaImportError,
    );
    expect(() => parsePrismaSchema("foo A {}", "x.prisma")).toThrow(/x\.prisma:1:1: unknown block/);
  });

  it("rejects unknown types and duplicate blocks", () => {
    expect(() => convertPrismaSchema("model A { id String @id\n b Nope }")).toThrow(
      /unknown type "Nope"/,
    );
    expect(() =>
      convertPrismaSchema("model A { id String @id }\nmodel A { id String @id }"),
    ).toThrow(/defined more than once/);
  });
});

describe("convertPrismaSchema: scalars", () => {
  it("maps scalar types, optional fields and lists", () => {
    const { schema, issues } = convert(`
      model T {
        a String
        b Int?
        c Float
        d Boolean
        e DateTime?
        f BigInt
        g Json?
        h String[]
        i Int[]
      }
    `);
    expect(schema).toBe(`node T {
  a String
  b Int?
  c Float
  d Boolean
  e DateTime?
  f BigInt
  g Json?
  h String[]
  i Int[]
}
`);
    expect(issues).toEqual([]);
  });

  it("maps Decimal to Float and reports it", () => {
    const { schema, issues } = convert("model T { id String @id\n price Decimal }");
    expect(schema).toContain("price Float");
    expect(issueAt(issues, "T.price")).toMatchObject({ severity: "changed", feature: "Decimal" });
  });

  it("does not convert Bytes and Unsupported fields", () => {
    const result = convertPrismaSchema(
      'model T { id String @id\n data Bytes\n v Unsupported("tsvector")? }',
    );
    const schema = printSchemaDocument(result.document);
    expect(schema).not.toContain("data");
    expect(issueAt(result.issues, "T.data")).toMatchObject({ severity: "unsupported" });
    expect(issueAt(result.issues, "T.v")).toMatchObject({ severity: "unsupported" });
    expect(result.notes.get("T")).toEqual([
      "data Bytes (not converted: type not supported)",
      'v Unsupported("tsvector")? (not converted: type not supported)',
    ]);
  });

  it("maps Json[] to Json and composite types to Json", () => {
    const { schema, issues } = convert(`
      type Address { street String }
      model T { id String @id\n tags Json[]\n home Address?\n all Address[] }
    `);
    expect(schema).toContain("tags Json\n");
    expect(schema).toContain("home Json?\n");
    expect(schema).toContain("all Json\n");
    expect(issueAt(issues, "T.tags")).toMatchObject({ severity: "changed", feature: "Json[]" });
    expect(issueAt(issues, "T.home")).toMatchObject({ severity: "changed", feature: "type" });
  });

  it("applies native types: @db.Date, @db.Time, @db.VarChar, others ignored", () => {
    const { schema, issues } = convert(`
      model T {
        id   String   @id @db.Uuid
        day  DateTime @db.Date
        at   DateTime @db.Time(3)
        atz  DateTime? @db.Timetz
        name String   @db.VarChar(40)
        code String   @db.Char(3)
      }
    `);
    expect(schema).toContain("day Date\n");
    expect(schema).toContain("at LocalTime\n");
    expect(schema).toContain("atz Time?\n");
    expect(schema).toContain("name String @length(max: 40)\n");
    expect(schema).toContain("code String @length(max: 3)\n");
    expect(issueAt(issues, "T.id")).toMatchObject({ severity: "ignored", feature: "@db.Uuid" });
  });
});

describe("convertPrismaSchema: enums", () => {
  it("converts enums, their defaults and @map reports", () => {
    const { schema, issues } = convert(`
      enum Role {
        USER
        ADMIN @map("admin")
        @@map("roles")
      }
      model U { id String @id\n role Role @default(USER)\n roles Role[] }
    `);
    expect(schema).toBe(`enum Role {
  USER
  ADMIN
}

node U {
  id String @id
  role Role @default(USER)
  roles Role[]
}
`);
    expect(issueAt(issues, "Role.ADMIN")).toMatchObject({ severity: "changed", feature: "@map" });
    expect(issueAt(issues, "Role")).toMatchObject({ severity: "changed", feature: "@@map" });
  });

  it("maps an enum named like a built-in type to String", () => {
    const { schema, issues } = convert("enum Date { A }\nmodel U { id String @id\n d Date }");
    expect(schema).toContain("d String\n");
    expect(issueAt(issues, "Date")).toMatchObject({ severity: "changed", feature: "enum" });
  });
});

describe("convertPrismaSchema: field attributes and defaults", () => {
  it.each([
    ["cuid()", "@default(cuid())", undefined],
    ["uuid()", "@default(uuid())", undefined],
    ["uuid(4)", "@default(uuid())", undefined],
    ["uuid(7)", "@default(uuid())", "changed"],
    ["cuid(2)", "@default(cuid())", "changed"],
    ["ulid()", "@default(cuid())", "changed"],
    ["nanoid()", "@default(cuid())", "changed"],
    ["auto()", "@default(cuid())", "changed"],
    ['dbgenerated("gen_random_uuid()")', "@default(uuid())", "changed"],
    ['dbgenerated("lower(name)")', "", "unsupported"],
  ])("@default(%s) on a String id", (fn, cyphra, severity) => {
    const { schema, issues } = convert(`model T { id String @id @default(${fn}) }`);
    expect(schema).toContain(`id String @id${cyphra ? ` ${cyphra}` : ""}\n`);
    expect(issueAt(issues, "T.id")?.severity).toBe(severity);
  });

  it("keeps an autoincrement id without its default and reports it", () => {
    const { schema, issues } = convert("model T { id Int @id @default(autoincrement()) }");
    expect(schema).toContain("id Int @id\n");
    expect(issueAt(issues, "T.id")).toMatchObject({
      severity: "unsupported",
      feature: "@default(autoincrement())",
    });
  });

  it("converts literal defaults", () => {
    const { schema, issues } = convert(`
      model T {
        id String @id
        s  String  @default("x")
        i  Int     @default(-3)
        f  Float   @default(1.5)
        b  Boolean @default(true)
        g  BigInt  @default(9223372036854775807)
        j  Json    @default("{}")
        l  String[] @default([])
        d  DateTime @default(now())
        x  DateTime @default("2020-01-01T00:00:00Z")
      }
    `);
    expect(schema).toContain('s String @default("x")');
    expect(schema).toContain("i Int @default(-3)");
    expect(schema).toContain("f Float @default(1.5)");
    expect(schema).toContain("b Boolean @default(true)");
    expect(schema).toContain("g BigInt @default(9223372036854775807)");
    expect(schema).toContain('j Json @default("{}")');
    expect(schema).toContain("l String[]\n");
    expect(schema).toContain("d DateTime @default(now())");
    expect(schema).toContain("x DateTime\n");
    expect(issueAt(issues, "T.l")).toMatchObject({ severity: "ignored", feature: "@default([])" });
    expect(issueAt(issues, "T.x")).toMatchObject({ severity: "unsupported" });
  });

  it("@updatedAt becomes @default(now()) and is reported", () => {
    const { schema, issues } = convert("model T { id String @id\n at DateTime @updatedAt }");
    expect(schema).toContain("at DateTime @default(now())");
    expect(issueAt(issues, "T.at")).toMatchObject({ severity: "changed", feature: "@updatedAt" });
  });

  it("@unique is kept, @map reported, @ignore fields dropped", () => {
    const result = convertPrismaSchema(`
      model T {
        id    String @id @unique
        email String @unique(map: "t_email") @map("e_mail")
        tmp   String @ignore
        meta  Json   @unique
      }
    `);
    const schema = printSchemaDocument(result.document);
    expect(schema).toContain("id String @id\n");
    expect(schema).toContain("email String @unique\n");
    expect(schema).toContain("meta Json\n");
    expect(schema).not.toContain("tmp");
    expect(issueAt(result.issues, "T.email", "@map")).toMatchObject({ severity: "changed" });
    expect(issueAt(result.issues, "T.tmp")).toMatchObject({
      severity: "ignored",
      feature: "@ignore",
    });
    expect(issueAt(result.issues, "T.meta")).toMatchObject({ severity: "unsupported" });
  });

  it("reports unknown attributes", () => {
    const { issues } = convert("model T { id String @id @shardKey }");
    expect(issueAt(issues, "T.id")).toMatchObject({
      severity: "unsupported",
      feature: "@shardKey",
    });
  });
});

describe("convertPrismaSchema: block attributes", () => {
  it("converts @@unique, @@index and @@fulltext; single fields become field decorators", () => {
    const { schema } = convert(`
      model T {
        id    String @id
        a     String
        b     Int
        c     String
        @@unique([a, b], name: "ab")
        @@index([b, c])
        @@index([c])
        @@unique([b])
        @@fulltext([a, c])
      }
    `);
    expect(schema).toBe(`node T {
  id String @id
  a String
  b Int @unique
  c String @index

  @@unique([a, b], name: "ab")
  @@index([b, c])
  @@fulltext([a, c])
}
`);
  });

  it("turns a composite @@id into @@unique and reports it", () => {
    const { schema, issues } = convert("model T { a String\n b String\n @@id([a, b]) }");
    expect(schema).toContain("@@unique([a, b])");
    expect(issueAt(issues, "T", "@@id")).toMatchObject({ severity: "changed" });
  });

  it("turns @@id over one field into @id", () => {
    const { schema } = convert("model T { a String\n @@id([a]) }");
    expect(schema).toContain("a String @id\n");
  });

  it("reports @@map, @@schema and @@ignore", () => {
    const { schema, issues } = convert(`
      model T { id String @id\n @@map("t")\n @@schema("app") }
      model Old { id String @id\n @@ignore }
    `);
    expect(schema).not.toContain("Old");
    expect(issueAt(issues, "T", "@@map")?.severity).toBe("changed");
    expect(issueAt(issues, "T", "@@schema")?.severity).toBe("ignored");
    expect(issueAt(issues, "Old", "@@ignore")?.severity).toBe("ignored");
  });

  it("reports views", () => {
    const { schema, issues } = convert("view V { id String @unique }\nmodel T { id String @id }");
    expect(schema).not.toContain("V");
    expect(issueAt(issues, "V")).toMatchObject({ severity: "unsupported", feature: "view" });
  });
});

describe("convertPrismaSchema: relations", () => {
  const ONE_TO_MANY = (onDelete: string, optional = false) => `
    model User { id String @id\n posts Post[] }
    model Post {
      id       String @id
      author   User${optional ? "?" : ""} @relation(fields: [authorId], references: [id]${onDelete ? `, onDelete: ${onDelete}` : ""})
      authorId String${optional ? "?" : ""}
      @@index([authorId])
    }
  `;

  it("turns a foreign key into an edge from the referenced model and drops the key", () => {
    const result = convertPrismaSchema(ONE_TO_MANY("Cascade"));
    const schema = printSchemaDocument(result.document);
    expect(schema).toBe(`node User {
  id String @id
  posts Post[] @relationship(type: "HAS_POSTS", direction: OUT, onDelete: Cascade)
}

node Post {
  id String @id
  author User @relationship(type: "HAS_POSTS", direction: IN)
}
`);
    expect(issueAt(result.issues, "Post.authorId")).toMatchObject({
      severity: "changed",
      feature: "foreign key",
    });
    expect(issueAt(result.issues, "Post", "@@index")?.severity).toBe("ignored");
    expect(result.notes.get("Post")).toEqual([
      "authorId String (foreign key of author: replaced by the edge)",
    ]);
  });

  it.each([
    ["Cascade", false, "onDelete: Cascade", undefined],
    ["Restrict", false, "onDelete: Restrict", undefined],
    ["NoAction", false, "onDelete: Restrict", "changed"],
    ["SetNull", true, "", undefined],
    ["SetDefault", true, "", "changed"],
    // Prisma's defaults: Restrict for a required key, SetNull for an optional one.
    ["", false, "onDelete: Restrict", undefined],
    ["", true, "", undefined],
  ])("onDelete %s (optional key: %s)", (action, optional, rule, severity) => {
    const result = convertPrismaSchema(ONE_TO_MANY(action, optional));
    const schema = printSchemaDocument(result.document);
    expect(schema).toContain(
      `posts Post[] @relationship(type: "HAS_POSTS", direction: OUT${rule ? `, ${rule}` : ""})`,
    );
    expect(issueAt(result.issues, "Post.author")?.severity).toBe(severity);
  });

  it("names edges after @relation names in upper snake case", () => {
    const { schema } = convert(`
      model User {
        id      String @id
        written Post[] @relation("WrittenPosts")
        edited  Post[] @relation("EditedPosts")
      }
      model Post {
        id       String @id
        author   User   @relation("WrittenPosts", fields: [authorId], references: [id])
        authorId String
        editor   User?  @relation(name: "EditedPosts", fields: [editorId], references: [id])
        editorId String?
      }
    `);
    expect(schema).toContain('written Post[] @relationship(type: "WRITTEN_POSTS", direction: OUT');
    expect(schema).toContain('edited Post[] @relationship(type: "EDITED_POSTS", direction: OUT)');
    expect(schema).toContain('author User @relationship(type: "WRITTEN_POSTS", direction: IN)');
    expect(schema).toContain('editor User? @relationship(type: "EDITED_POSTS", direction: IN)');
  });

  it("converts one-to-one relations and reports them", () => {
    const { schema, issues } = convert(`
      model User { id String @id\n profile Profile? }
      model Profile {
        id     String @id
        user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
        userId String @unique
      }
    `);
    expect(schema).toContain(
      'profile Profile? @relationship(type: "HAS_PROFILE", direction: OUT, onDelete: Cascade)',
    );
    expect(schema).toContain('user User @relationship(type: "HAS_PROFILE", direction: IN)');
    expect(schema).not.toContain("userId");
    expect(issueAt(issues, "User.profile")).toMatchObject({ feature: "one-to-one" });
  });

  it("converts self relations", () => {
    const { schema } = convert(`
      model Category {
        id       String     @id
        parent   Category?  @relation("Tree", fields: [parentId], references: [id])
        parentId String?
        children Category[] @relation("Tree")
      }
    `);
    expect(schema).toContain('parent Category? @relationship(type: "TREE", direction: IN)');
    expect(schema).toContain('children Category[] @relationship(type: "TREE", direction: OUT)');
  });

  it("turns an implicit many-to-many into one edge type, from the model that sorts first", () => {
    const { schema, issues } = convert(`
      model Tag { id String @id\n posts Post[] }
      model Post { id String @id\n tags Tag[] }
    `);
    expect(schema).toContain('posts Post[] @relationship(type: "HAS_TAGS", direction: IN)');
    expect(schema).toContain('tags Tag[] @relationship(type: "HAS_TAGS", direction: OUT)');
    expect(issues).toEqual([]);
  });

  it("reports the direction of a self many-to-many", () => {
    const { schema, issues } = convert(`
      model User {
        id        String @id
        following User[] @relation("Follows")
        followers User[] @relation("Follows")
      }
    `);
    expect(schema).toContain('followers User[] @relationship(type: "FOLLOWS", direction: OUT)');
    expect(schema).toContain('following User[] @relationship(type: "FOLLOWS", direction: IN)');
    expect(issueAt(issues, "User.followers")).toMatchObject({ feature: "many-to-many" });
  });

  it("turns an explicit join model into a relationship model with edge properties", () => {
    const result = convertPrismaSchema(`
      model Order { id String @id\n items OrderItem[] }
      model Product { id String @id\n orderItems OrderItem[] }
      model OrderItem {
        order     Order   @relation(fields: [orderId], references: [id], onDelete: Cascade)
        orderId   String
        product   Product @relation(fields: [productId], references: [id])
        productId String
        quantity  Int     @default(1)
        note      String? @db.VarChar(100)
        @@id([orderId, productId])
        @@index([productId])
      }
    `);
    const schema = printSchemaDocument(result.document);
    resolveSchema(parseSchema(schema));
    expect(schema).toBe(`node Order {
  id String @id
  items Product[] @relationship(type: "ORDER_ITEM", direction: OUT)
}

node Product {
  id String @id
  orderItems Order[] @relationship(type: "ORDER_ITEM", direction: IN, onDelete: Restrict)
}

relationship OrderItem {
  type "ORDER_ITEM"
  from Order
  to Product
  quantity Int @default(1)
  note String? @length(max: 100)
}
`);
    expect(issueAt(result.issues, "OrderItem", "join model")?.severity).toBe("changed");
    expect(issueAt(result.issues, "OrderItem", "@@id")?.severity).toBe("changed");
  });

  it("turns a self join model (follows) into a relationship model", () => {
    const { schema } = convert(`
      model User {
        id        String   @id
        following Follow[] @relation("follower")
        followers Follow[] @relation("following")
      }
      model Follow {
        follower    User     @relation("follower", fields: [followerId], references: [id], onDelete: Cascade)
        followerId  String
        following   User     @relation("following", fields: [followingId], references: [id], onDelete: Cascade)
        followingId String
        since       DateTime @default(now())
        @@unique([followerId, followingId])
      }
    `);
    expect(schema).toContain('following User[] @relationship(type: "FOLLOW", direction: OUT)');
    expect(schema).toContain('followers User[] @relationship(type: "FOLLOW", direction: IN)');
    expect(schema).toContain('relationship Follow {\n  type "FOLLOW"\n  from User\n  to User\n');
  });

  it("keeps a model with extra relations as a node, reporting constraints over keys", () => {
    const { schema, issues } = convert(`
      model A { id String @id\n links Link[] }
      model B { id String @id\n links Link[] }
      model C { id String @id\n links Link[] }
      model Link {
        a   A @relation(fields: [aId], references: [id])
        aId String
        b   B @relation(fields: [bId], references: [id])
        bId String
        c   C @relation(fields: [cId], references: [id])
        cId String
        @@id([aId, bId])
      }
    `);
    expect(schema).toContain("node Link {");
    expect(issueAt(issues, "Link", "@@id")).toMatchObject({ severity: "unsupported" });
  });

  it("drops key fields from a composite @@index and keeps the rest", () => {
    const { schema, issues } = convert(`
      model Org { id String @id\n projects Project[] }
      model Project {
        id String @id
        org Org @relation(fields: [orgId], references: [id])
        orgId String
        createdAt DateTime
        name String
        @@index([orgId, createdAt])
        @@index([orgId, name, createdAt])
      }
    `);
    expect(schema).toContain("createdAt DateTime @index");
    expect(schema).toContain("@@index([name, createdAt])");
    expect(issueAt(issues, "Project", "@@index")?.severity).toBe("changed");
  });

  it("makes edge types unique per pair of models", () => {
    const { schema, issues } = convert(`
      model User {
        id    String @id
        posts Post[]
        other Post[] @relation("HasPosts")
      }
      model Post {
        id String @id
        a  User @relation(fields: [aId], references: [id])
        aId String
        b  User @relation("HasPosts", fields: [bId], references: [id])
        bId String
      }
    `);
    expect(schema).toContain('"HAS_POSTS"');
    expect(schema).toContain('"HAS_POSTS_2"');
    expect(issues.some((i) => i.message.includes("HAS_POSTS_2"))).toBe(true);
  });

  it("does not convert relations to views or ignored models", () => {
    const result = convertPrismaSchema(`
      model User { id String @id\n legacy Legacy[] }
      model Legacy { id String @id\n user User @relation(fields: [userId], references: [id])\n userId String\n @@ignore }
    `);
    const schema = printSchemaDocument(result.document);
    expect(schema).toBe("node User {\n  id String @id\n}\n");
    expect(issueAt(result.issues, "User.legacy")).toMatchObject({ severity: "unsupported" });
  });
});

describe("upperSnake", () => {
  it.each([
    ["PostAuthor", "POST_AUTHOR"],
    ["post_author", "POST_AUTHOR"],
    ["userPosts", "USER_POSTS"],
    ["HTTPRequest", "HTTP_REQUEST"],
    ["apiKeys", "API_KEYS"],
    ["v2Items", "V2_ITEMS"],
  ])("%s → %s", (name, expected) => {
    expect(upperSnake(name)).toBe(expected);
  });
});

describe("mergePrismaImport", () => {
  it("adds missing fields and models to an existing schema", () => {
    const existing = `// mine
node User {
  id String @id @default(cuid()) // keep
  nickname String?
}
`;
    const result = convertPrismaSchema(`
      model User { id String @id @default(uuid())\n email String @unique\n posts Post[] }
      model Post { id String @id\n author User @relation(fields: [authorId], references: [id])\n authorId String }
    `);
    const { source, issues } = mergePrismaImport(existing, result);
    expect(source).toContain("  id String @id @default(cuid()) // keep\n");
    expect(source).toContain("  email String @unique\n");
    expect(source).toContain("// Imported from a Prisma schema with `cyphra import prisma`.");
    expect(source).toContain("node Post {");
    expect(issues.map((i) => i.at)).toEqual(["User.id"]);
    resolveSchema(parseSchema(source));
  });
});
