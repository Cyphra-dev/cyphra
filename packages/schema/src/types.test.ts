import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { NodeDeclaration } from "./ast.js";
import { SchemaValidationError } from "./errors.js";
import { getNodeModel, resolveSchema } from "./model.js";
import { parseSchema } from "./parseSchema.js";
import { printSchemaDocument } from "./printSchema.js";
import { renderCyphraGenSource } from "./renderCyphraGen.js";
import { SCALAR_TYPE_NAMES } from "./validate.js";

const schema = `
enum Role {
  ADMIN
  USER
  GUEST
}

enum Status { DRAFT, PUBLISHED }

node Account {
  id      String  @id
  role    Role    @default(USER)
  roles   Role[]
  status  Status?
  data    Json?
  prefs   Json    @default("{\\"theme\\":\\"dark\\"}")
  big     BigInt  @default(9223372036854775807)
  small   BigInt? @default(-9223372036854775808)
  counter BigInt  @default(0) @index
  ids     BigInt[]
  members Account[] @relationship(type: "KNOWS", direction: OUT)
}

relationship Knows {
  type "KNOWS"
  from Account
  to   Account
  level Role @default(GUEST)
  meta  Json?
  since BigInt?
}
`;

const bad = (src: string) => () => resolveSchema(parseSchema(src));

describe("enum declarations", () => {
  it("parses enums and turns enum-typed fields into scalars", () => {
    const doc = parseSchema(schema);
    expect(doc.declarations[0]).toEqual({
      kind: "Enum",
      name: "Role",
      values: ["ADMIN", "USER", "GUEST"],
    });
    expect(doc.declarations[1]).toEqual({
      kind: "Enum",
      name: "Status",
      values: ["DRAFT", "PUBLISHED"],
    });
    const node = doc.declarations[2] as NodeDeclaration;
    expect(node.fields[1]).toEqual({
      kind: "Scalar",
      name: "role",
      type: { name: "Enum", optional: false, enum: "Role" },
      decorators: [
        { name: "default", args: [{ key: "value", value: { kind: "identifier", value: "USER" } }] },
      ],
    });
    expect(node.fields[2]).toMatchObject({
      kind: "Scalar",
      type: { name: "Enum", list: true, enum: "Role" },
    });
    expect(node.fields[3]).toMatchObject({
      kind: "Scalar",
      type: { name: "Enum", optional: true, enum: "Status" },
    });
    expect(node.fields[10]).toMatchObject({ kind: "Relational", target: "Account" });
  });

  it("resolves enums, enum fields (with their values) and enum defaults", () => {
    const model = resolveSchema(parseSchema(schema));
    expect(model.enums).toEqual([
      { name: "Role", values: ["ADMIN", "USER", "GUEST"] },
      { name: "Status", values: ["DRAFT", "PUBLISHED"] },
    ]);
    const a = getNodeModel(model, "Account");
    expect(a.fields.find((f) => f.name === "role")).toMatchObject({
      kind: "scalar",
      type: "Enum",
      enum: "Role",
      enumValues: ["ADMIN", "USER", "GUEST"],
      optional: false,
      list: false,
      default: { kind: "literal", value: "USER" },
    });
    expect(a.fields.find((f) => f.name === "roles")).toMatchObject({ type: "Enum", list: true });
    expect(model.relationships[0]!.properties[0]).toMatchObject({
      type: "Enum",
      enum: "Role",
      default: { kind: "literal", value: "GUEST" },
    });
  });

  it("omits `enums` from the model of a schema without enums", () => {
    expect(resolveSchema(parseSchema("node A { id String @id }"))).not.toHaveProperty("enums");
  });

  it("accepts a quoted enum default", () => {
    const m = resolveSchema(parseSchema(`enum R { A B }\nnode N { r R @default("B") }`));
    expect(m.nodes[0]!.fields[0]).toMatchObject({ default: { kind: "literal", value: "B" } });
  });

  it.each([
    [`enum R { }`, /at least one value/],
    [`enum R { A A }`, /duplicate value A/],
    [`enum String { A }`, /built-in type name/],
    [`enum R { A }\nnode R { id String @id }`, /Duplicate declaration "R"/],
    [`enum R { A B }\nnode N { r R @default(C) }`, /not a value of enum R/],
    [`enum R { A B }\nnode N { r R[] @default(A) }`, /unsupported @default/],
    [`node N { r Nope? }`, /unknown node "Nope"/],
    [
      `node N { id String @id }\nrelationship E { type "E"\n from N\n to N\n r Nope }`,
      /unknown type "Nope"/,
    ],
  ])("rejects %s", (src, message) => {
    expect(bad(src)).toThrow(SchemaValidationError);
    expect(bad(src)).toThrow(message);
  });
});

describe("Json type", () => {
  it("resolves Json fields and normalizes a JSON-text default", () => {
    const a = getNodeModel(resolveSchema(parseSchema(schema)), "Account");
    expect(a.fields.find((f) => f.name === "data")).toMatchObject({
      type: "Json",
      optional: true,
    });
    expect(a.fields.find((f) => f.name === "prefs")).toMatchObject({
      type: "Json",
      default: { kind: "literal", value: '{"theme":"dark"}' },
    });
    const m = resolveSchema(parseSchema(`node N { j Json @default("[ 1, 2 ]") }`));
    expect(m.nodes[0]!.fields[0]).toMatchObject({ default: { kind: "literal", value: "[1,2]" } });
  });

  it.each([
    [`node N { j Json[] }`, /Json\[\] is not supported/],
    [`node N { j Json @id }`, /@id is not valid on a Json field/],
    [`node N { j Json @unique }`, /@unique is not valid on a Json field/],
    [`node N { j Json @index }`, /@index is not valid on a Json field/],
    [`node N { j Json @default("{oops") }`, /must be a string holding JSON text/],
    [`node N { j Json @default(1) }`, /does not match type Json/],
  ])("rejects %s", (src, message) => {
    expect(bad(src)).toThrow(message);
  });
});

describe("BigInt type", () => {
  it("resolves BigInt fields; defaults keep every digit (as a decimal string)", () => {
    const a = getNodeModel(resolveSchema(parseSchema(schema)), "Account");
    const field = (n: string) => a.fields.find((f) => f.name === n);
    expect(field("big")).toMatchObject({
      type: "BigInt",
      default: { kind: "literal", value: "9223372036854775807" },
    });
    expect(field("small")).toMatchObject({
      default: { kind: "literal", value: "-9223372036854775808" },
    });
    expect(field("counter")).toMatchObject({ index: true, default: { value: "0" } });
    expect(field("ids")).toMatchObject({ type: "BigInt", list: true });
  });

  it.each([
    [`node N { b BigInt @default(9223372036854775808) }`, /not a 64-bit integer/],
    [`node N { b BigInt @default(-9223372036854775809) }`, /not a 64-bit integer/],
    [`node N { b BigInt @default(1.5) }`, /not a 64-bit integer/],
    [`node N { b BigInt @default("1") }`, /does not match type BigInt/],
    [`node N { b BigInt @default(now()) }`, /not valid for type BigInt/],
  ])("rejects %s", (src, message) => {
    expect(bad(src)).toThrow(message);
  });
});

describe("printing and codegen", () => {
  it("round-trips enums, Json and BigInt through the printer", () => {
    const doc = parseSchema(schema);
    const printed = printSchemaDocument(doc);
    expect(printed).toContain("enum Role {\n  ADMIN\n  USER\n  GUEST\n}");
    expect(printed).toContain("  role Role @default(USER)");
    expect(printed).toContain("  roles Role[]");
    expect(printed).toContain("  big BigInt @default(9223372036854775807)");
    expect(printed).toContain('  prefs Json @default("{\\"theme\\":\\"dark\\"}")');
    expect(parseSchema(printed)).toEqual(doc);
  });

  it("emits enum consts and union types, bigint and JsonValue fields", () => {
    const src = renderCyphraGenSource(parseSchema(schema));
    expect(src).toContain(
      'import { createOrm, type JsonValue, type OrmClient, type OrmOptions, type SchemaModel } from "cyphra";',
    );
    expect(src).toContain(
      'export const Role = {\n  ADMIN: "ADMIN",\n  USER: "USER",\n  GUEST: "GUEST",\n} as const;',
    );
    expect(src).toContain("export type Role = (typeof Role)[keyof typeof Role];");
    expect(src).toContain("  role: Role;\n  roles: Role[];\n  status: Status | null;");
    expect(src).toContain("  data: JsonValue | null;\n  prefs: JsonValue;");
    expect(src).toContain(
      "  big: bigint;\n  small: bigint | null;\n  counter: bigint;\n  ids: bigint[];",
    );
    expect(src).toContain('createRequired: "id";');
  });

  it("does not import JsonValue when no field uses Json", () => {
    const src = renderCyphraGenSource(parseSchema("node A { id String @id }"));
    expect(src).not.toContain("JsonValue");
  });
});

describe("SCALAR_TYPE_NAMES", () => {
  it("lists exactly the scalar type names of the grammar", () => {
    const grammar = readFileSync(new URL("../grammar.peggy", import.meta.url), "utf8");
    const rule = /^scalarTypeName\n\s*=\s*n:\(([^)]*)\)/m.exec(grammar)?.[1] ?? "";
    const names = [...rule.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    expect([...SCALAR_TYPE_NAMES].sort()).toEqual([...names].sort());
  });

  it("parses every listed type", () => {
    for (const t of SCALAR_TYPE_NAMES) {
      expect(() => parseSchema(`node N { x ${t}? }`)).not.toThrow();
    }
  });
});
