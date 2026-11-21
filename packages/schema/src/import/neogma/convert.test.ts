import ts from "typescript";
import { describe, expect, it } from "vitest";
import { resolveSchema } from "../../model.js";
import { parseSchema } from "../../parseSchema.js";
import { printSchemaDocument } from "../../printSchema.js";
import type { ImportIssue } from "../print.js";
import { convertNeogmaModels, pascal } from "./convert.js";
import { mergeNeogmaImport, printNeogmaImport } from "./index.js";
import { NeogmaImportError, parseNeogmaSources } from "./parse.js";

/** Convert files, check the result resolves, and return the printed schema and the issues. */
function convert(...bodies: string[]): {
  schema: string;
  issues: readonly ImportIssue[];
  notes: ReadonlyMap<string, readonly string[]>;
} {
  const result = convertNeogmaModels(
    bodies.map((body, i) => ({ name: `m${i}.ts`, body })),
    { typescript: ts },
  );
  const schema = printSchemaDocument(result.document);
  resolveSchema(parseSchema(schema));
  return { schema, issues: result.issues, notes: result.notes };
}

/** One decorated property on a `User` node: its printed field line and the issues. */
function property(schema: string, field = "x!: unknown;") {
  const r = convert(`
    @Node({ label: "User" })
    class UserNode extends NodeEntity {
      @PrimaryKey(Type.String()) id!: string;
      @Property(${schema}) ${field}
    }
  `);
  const line = r.schema
    .split("\n")
    .find((l) => /^ {2}x /.test(l))
    ?.trim();
  return { line, issues: r.issues, schema: r.schema, notes: r.notes };
}

function features(issues: readonly ImportIssue[]) {
  return issues.map((i) => `${i.severity} ${i.at} ${i.feature}`);
}

describe("parseNeogmaSources", () => {
  it("reads decorator classes without running them", () => {
    const { models } = parseNeogmaSources(ts, [
      {
        name: "a.ts",
        body: `
          const name = Type.String({ minLength: 1 });
          @Node({ label: ["User", "Person"] })
          export class UserNode extends NodeEntity {
            @PrimaryKey() id!: string;
            @Property(name) name!: string;
            @Property() tags?: string[] | null;
            notStored = 1;
            @Relationship({ name: "PLACED", direction: "out", model: () => OrderNode })
            Orders!: Related<typeof OrderNode>;
            static find() {}
            static beforeCreate() {}
            greet() {}
          }
          throw new Error("never run");
        `,
      },
    ]);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      style: "decorators",
      id: "UserNode",
      labels: ["User", "Person"],
      primaryKey: "id",
      statics: ["find"],
      hooks: ["beforeCreate"],
      methods: ["greet"],
      members: [
        { kind: "property", name: "id", annotation: { type: "string", list: false } },
        { kind: "property", name: "name", schema: { kind: "call", callee: "String" } },
        {
          kind: "property",
          name: "tags",
          annotation: { type: "string", list: true, optional: true },
        },
        {
          kind: "relationship",
          alias: "Orders",
          type: { kind: "string", value: "PLACED" },
          direction: { kind: "string", value: "out" },
          target: "OrderNode",
        },
      ],
    });
  });

  it("reports syntax errors with a position", () => {
    expect(() =>
      parseNeogmaSources(ts, [{ name: "bad.ts", body: "class A {\n  x = ;\n}" }]),
    ).toThrow(/^bad\.ts:2:7: /);
  });

  it("throws when no file defines a model", () => {
    expect(() =>
      convertNeogmaModels([{ name: "a.ts", body: "export const x = 1;" }], { typescript: ts }),
    ).toThrow(NeogmaImportError);
  });
});

describe("TypeBox types", () => {
  it.each([
    ["Type.String()", "x String"],
    ["Type.Number()", "x Float"],
    ["Type.Boolean()", "x Boolean"],
    ["Type.BigInt()", "x BigInt"],
    ["Type.Optional(Type.String())", "x String?"],
    ["Type.Union([Type.String(), Type.Null()])", "x String?"],
    ["Type.Array(Type.Number())", "x Float[]"],
    ["Type.Array(Type.Boolean(), { minItems: 1, maxItems: 3 })", "x Boolean[] @size(1, 3)"],
    ["Type.Integer()", "x Int"],
    ['Type.String({ format: "date-time" })', "x DateTime"],
    ['Type.String({ format: "date" })', "x Date"],
    ["Type.Object({ a: Type.String() })", "x Json"],
    ["Type.Record(Type.String(), Type.Number())", "x Json"],
  ])("%s becomes %s", (schema, line) => {
    expect(property(schema).line).toBe(line);
  });

  it("reports the types that change", () => {
    expect(features(property("Type.Integer()").issues)).toEqual(["changed User.x Integer"]);
    expect(features(property('Type.String({ format: "date-time" })').issues)).toEqual([
      'changed User.x format: "date-time"',
    ]);
    expect(features(property("Type.Optional(Type.Array(Type.String()))").issues)).toEqual([
      "changed User.x Optional",
    ]);
    expect(features(property("Type.Object({})").issues)).toEqual(["changed User.x Type.Object"]);
  });

  it("turns a union of string literals into an enum", () => {
    const r = property('Type.Union([Type.Literal("a"), Type.Literal("b")], { default: "b" })');
    expect(r.line).toBe("x UserX @default(b)");
    expect(r.schema).toContain("enum UserX {\n  a\n  b\n}");
    expect(property('Type.Enum(["on", "off"])').line).toBe("x UserX");
    expect(property('Type.Optional(Type.Literal("only"))').line).toBe("x UserX?");
  });

  it("checks values that cannot be enum values with a regex", () => {
    const r = property('Type.Union([Type.Literal("in-progress"), Type.Literal("a.b")])');
    expect(r.line).toBe('x String @regex("^(?:in-progress|a\\\\.b)$")');
    expect(features(r.issues)).toEqual(["changed User.x enum"]);
  });

  it("uses the type annotation when there is no schema", () => {
    expect(property("", "x?: number;").line).toBe("x Float?");
    expect(property("", "x!: string[];").line).toBe("x String[]");
    expect(property("Type.Any()", "x!: boolean;").line).toBe("x Boolean");
    const r = property("", "x!: Date;");
    expect(r.line).toBeUndefined();
    expect(features(r.issues)).toEqual(["unsupported User.x type"]);
    expect(r.notes.get("User")).toEqual(["x (not converted: type)"]);
  });

  it("does not convert unions of different types or unknown types", () => {
    expect(features(property("Type.Union([Type.String(), Type.Number()])").issues)).toEqual([
      "unsupported User.x Type.Union",
    ]);
    expect(features(property("Type.Function([], Type.Void())").issues)).toEqual([
      "unsupported User.x Type.Function",
    ]);
    expect(features(property("someSchema").issues)).toEqual(["unsupported User.x schema"]);
  });
});

describe("validation keywords", () => {
  it.each([
    ["Type.String({ minLength: 2, maxLength: 9 })", "x String @length(2, 9)"],
    ["Type.String({ maxLength: 9 })", "x String @length(max: 9)"],
    ["Type.Number({ minimum: 0, maximum: 1.5 })", "x Float @min(0) @max(1.5)"],
    ["Type.Integer({ exclusiveMinimum: 0, exclusiveMaximum: 10 })", "x Int @min(1) @max(9)"],
    ['Type.String({ format: "email" })', "x String @email"],
    ['Type.String({ format: "url" })', "x String @url"],
    ['Type.String({ format: "uri" })', "x String @url"],
    ['Type.String({ pattern: "^a+$" })', 'x String @regex("^a+$")'],
    ["Type.Array(Type.String(), { minItems: 2 })", "x String[] @size(2)"],
    ['Type.String({ default: "hi" })', 'x String @default("hi")'],
    ["Type.Integer({ default: 3 })", "x Int @default(3)"],
    ["Type.Boolean({ default: true })", "x Boolean @default(true)"],
    [
      'Type.String({ format: "uuid" })',
      'x String @regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")',
    ],
    ['Type.String({ title: "X", description: "y" })', "x String"],
  ])("%s becomes %s", (schema, line) => {
    expect(property(schema).line).toBe(line);
  });

  it("reports what has no Cyphra rule", () => {
    expect(features(property("Type.Number({ multipleOf: 5 })").issues)).toEqual([
      "unsupported User.x multipleOf",
    ]);
    expect(features(property("Type.Number({ exclusiveMinimum: 0 })").issues)).toEqual([
      "unsupported User.x exclusiveMinimum",
    ]);
    expect(features(property('Type.String({ format: "ipv4" })').issues)).toEqual([
      "unsupported User.x format",
    ]);
    expect(features(property("Type.Array(Type.String({ minLength: 1 }))").issues)).toEqual([
      "unsupported User.x items",
    ]);
    expect(features(property("Type.Array(Type.Number(), { uniqueItems: true })").issues)).toEqual([
      "unsupported User.x uniqueItems",
    ]);
    expect(features(property('Type.String({ default: "a" })').issues)).toEqual([
      "changed User.x default",
    ]);
  });

  it("reports custom validators", () => {
    const r = property("Type.Refine(Type.String({ minLength: 1 }), (s) => s !== 'x')");
    expect(r.line).toBe("x String @length(1)");
    expect(features(r.issues)).toEqual(["unsupported User.x Type.Refine"]);
  });
});

describe("primary keys", () => {
  it("adds @id, and @default(uuid()) for a uuid key", () => {
    const r = convert(`
      @Node({ label: "A" }) class A extends NodeEntity {
        @PrimaryKey(Type.String({ format: "uuid" })) id!: string;
      }
      @Node({ label: "B" }) class B extends NodeEntity {
        @PrimaryKey(Type.Optional(Type.Integer())) key?: number;
      }
    `);
    expect(r.schema).toContain("  id String @id @default(uuid()) @regex(");
    expect(r.schema).toContain("  key Int @id\n");
    expect(features(r.issues)).toEqual([
      'changed A.id format: "uuid"',
      "changed B.key Integer",
      "changed B.key primary key",
    ]);
  });
});

describe("revalidator schemas (ModelFactory)", () => {
  function factory(schema: string) {
    const r = convert(`
      const Users = ModelFactory({ label: "User", schema: { x: ${schema} }, primaryKeyField: "x" }, neogma);
    `);
    return {
      line: r.schema
        .split("\n")
        .find((l) => /^ {2}x /.test(l))
        ?.trim(),
      issues: r.issues,
    };
  }

  it.each([
    ["{ type: 'string', required: true }", "x String @id"],
    ["{ type: 'number', required: true, minimum: 1, maximum: 2 }", "x Float @id @min(1) @max(2)"],
    ["{ type: 'integer', required: true }", "x Int @id"],
    ["{ type: 'boolean', required: true }", "x Boolean @id"],
    [
      "{ type: 'string', required: true, minLength: 1, maxLength: 4 }",
      "x String @id @length(1, 4)",
    ],
    ["{ type: 'string', required: true, allowEmpty: false }", "x String @id @length(1)"],
    ["{ type: 'string', required: true, format: 'email' }", "x String @id @email"],
    ["{ type: 'string', required: true, format: 'url' }", "x String @id @url"],
    [
      "{ type: 'string', required: true, pattern: /^a$/gi }",
      'x String @id @regex("^a$", flags: "i")',
    ],
    ["{ type: 'string', required: true, pattern: '^a$' }", 'x String @id @regex("^a$")'],
    ["{ type: 'string', required: true, format: 'date-time' }", "x DateTime @id"],
    ["{ type: ['string', 'null'], required: true }", "x String @id"],
  ])("%s becomes %s", (schema, line) => {
    expect(factory(schema).line).toBe(line);
  });

  it("makes fields optional unless required: true", () => {
    const r = convert(`
      const Users = ModelFactory({
        label: "User",
        schema: {
          id: { type: "string", required: true },
          a: { type: "string" },
          b: { type: "array", items: { type: "integer" }, maxItems: 2 },
          c: { type: "string", enum: ["x", "y"], required: true },
          d: { type: "object" },
        },
        primaryKeyField: "id",
      }, neogma);
    `);
    expect(r.schema).toContain("  a String?\n  b Int[] @size(max: 2)\n  c UserC\n  d Json?\n");
  });

  it("reports conform validators and custom messages", () => {
    expect(
      features(
        factory("{ type: 'string', required: true, conform: (v) => !!v, messages: {} }").issues,
      ),
    ).toEqual(["unsupported User.x conform", "ignored User.x messages"]);
  });
});

describe("relationships", () => {
  it("maps directions and keeps both sides as inverse fields", () => {
    const r = convert(`
      @Node({ label: "User" }) class UserNode extends NodeEntity {
        @PrimaryKey() id!: string;
        @Relationship({ name: "PLACED", direction: "out", model: () => OrderNode }) Orders!: unknown;
        @Relationship({ name: "KNOWS", direction: "none", model: "self" }) Friends!: unknown;
      }
      @Node({ label: "Order" }) class OrderNode extends NodeEntity {
        @PrimaryKey() id!: string;
        @Relationship({ name: "PLACED", direction: "in", model: () => UserNode }) Buyer!: unknown;
      }
    `);
    expect(r.schema).toContain('  Orders Order[] @relationship(type: "PLACED", direction: OUT)\n');
    expect(r.schema).toContain('  Friends User[] @relationship(type: "KNOWS", direction: OUT)\n');
    expect(r.schema).toContain('  Buyer User[] @relationship(type: "PLACED", direction: IN)\n');
    expect(features(r.issues)).toEqual(["changed User.Friends direction: 'none'"]);
  });

  it("puts properties from either side in one relationship model", () => {
    const r = convert(
      `
      export const rated = defineRelationshipProperties({
        Score: { property: "score", schema: Type.Integer({ minimum: 1, maximum: 5 }) },
      });
      @Node({ label: "User" }) export class UserNode extends NodeEntity {
        @PrimaryKey() id!: string;
        static readonly extra = { note: Type.Optional(Type.String()) };
        @Relationship({ name: "RATED", direction: "out", model: () => Movie, properties: { ...rated, ...UserNode.extra } })
        Rated!: unknown;
      }
      `,
      `
      @Node() export class Movie extends NodeEntity {
        @PrimaryKey() id!: string;
        @Relationship({ name: "RATED", direction: "in", model: () => UserNode, properties: () => rated })
        RatedBy!: unknown;
        @Relationship({ name: "RATED", direction: "in", model: () => UserNode, properties: [
          { alias: "score", property: "score", schema: Type.Number() },
        ] })
        Other!: unknown;
      }
      `,
    );
    expect(r.schema).toContain(
      'relationship Rated {\n  type "RATED"\n  from User\n  to Movie\n  score Int @min(1) @max(5)\n  note String?\n}',
    );
    expect(features(r.issues)).toEqual([
      "changed Rated.score Integer",
      "changed Rated.score alias",
      "changed Rated.score properties",
    ]);
  });

  it("names relationship models after the type, avoiding taken names", () => {
    expect(pascal("HAS_ORDER")).toBe("HasOrder");
    expect(pascal("follows")).toBe("Follows");
    const r = convert(`
      @Node({ label: "Likes" }) class A extends NodeEntity {
        @PrimaryKey() id!: string;
        @Relationship({ name: "LIKES", direction: "out", model: "self", properties: { n: Type.Number() } }) L!: unknown;
      }
    `);
    expect(r.schema).toContain("relationship LikesLikesLikes {");
  });

  it("reports relationships it cannot resolve", () => {
    const r = convert(`
      @Node({ label: "User" }) class UserNode extends NodeEntity {
        @PrimaryKey() id!: string;
        @Relationship({ name: "PLACED", direction: "out", model: () => Elsewhere }) Orders!: unknown;
        @Relationship({ name: TYPES.x, direction: "out", model: "self" }) Other!: unknown;
      }
    `);
    expect(features(r.issues)).toEqual([
      "unsupported User.Orders model",
      "unsupported User.Other name",
    ]);
    expect(r.notes.get("User")).toEqual([
      "Orders (not converted: relationship)",
      "Other (not converted: relationship)",
    ]);
  });
});

describe("models", () => {
  it("uses the class name without a label, and interfaces for extra labels", () => {
    const r = convert(`
      @Node() class Person extends NodeEntity { @PrimaryKey() id!: string; }
      @Node({ label: ["Admin", "Staff"] }) class AdminNode extends NodeEntity { @PrimaryKey() id!: string; }
      @Node({ label: ["Boss", "Person"] }) class BossNode extends NodeEntity { @PrimaryKey() id!: string; }
    `);
    expect(r.schema).toContain("interface Staff {\n}");
    expect(r.schema).toContain("node Admin implements Staff {");
    expect(r.schema).toContain("node Person {");
    expect(r.schema).toContain("node Boss {");
    expect(features(r.issues)).toEqual(["unsupported Boss label"]);
  });

  it("reports hooks, statics and methods of ModelFactory models", () => {
    const r = convert(`
      export const Users = ModelFactory({
        label: "User",
        schema: { id: { type: "string", required: true } },
        primaryKeyField: "id",
        statics: { byName() {} },
        methods: { greet: function () {} },
      }, neogma);
      Users.beforeDelete = async () => {};
      Users.extra = () => 1;
      Users.prototype.other = function () {};
    `);
    expect(features(r.issues)).toEqual([
      "unsupported User beforeDelete",
      "unsupported User static byName",
      "unsupported User static extra",
      "unsupported User method greet",
      "unsupported User method other",
    ]);
  });

  it("reports a model without a static label and a missing primary key field", () => {
    const r = convert(`
      @Node({ label: LABEL }) class X extends NodeEntity {}
      const Users = ModelFactory({ label: "User", schema: { a: Type.String() }, primaryKeyField: "id" }, neogma);
    `);
    expect(features(r.issues)).toEqual(["unsupported X label", "unsupported User primaryKeyField"]);
  });
});

describe("printNeogmaImport / mergeNeogmaImport", () => {
  const body = `
    @Node({ label: "User" }) class UserNode extends NodeEntity {
      @PrimaryKey() id!: string;
      @Property(Type.String({ format: "email" })) email!: string;
    }
  `;

  it("prints a header and the review list", () => {
    const result = convertNeogmaModels([{ name: "a.ts", body }], { typescript: ts });
    expect(printNeogmaImport(result)).toBe(
      "// Imported from neogma models with `cyphra import neogma`.\n\nnode User {\n  id String @id\n  email String @email\n}\n",
    );
  });

  it("adds missing fields to an existing schema", () => {
    const result = convertNeogmaModels([{ name: "a.ts", body }], { typescript: ts });
    const { source } = mergeNeogmaImport("node User {\n  id String @id\n}\n", result);
    expect(source).toBe("node User {\n  id String @id\n  email String @email\n}\n");
  });
});
