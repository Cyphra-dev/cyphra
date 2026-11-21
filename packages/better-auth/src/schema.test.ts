import { describe, expect, it } from "vitest";
import { printSchemaDocument } from "@cyphra/schema";
import { organization } from "better-auth/plugins";
import type { BetterAuthDBSchema } from "better-auth/db";
import { authSchema, deriveAuthGraph, type NumberFields } from "./index.js";
import { edgeType, pascalCase, plural, relationFieldName } from "./naming.js";

describe("naming", () => {
  it("converts model names to PascalCase labels and edge types", () => {
    expect(pascalCase("user")).toBe("User");
    expect(pascalCase("user_custom")).toBe("UserCustom");
    expect(pascalCase("twoFactor")).toBe("TwoFactor");
    expect(pascalCase("users")).toBe("Users");
    expect(edgeType("Session")).toBe("HAS_SESSION");
    expect(edgeType("TwoFactor")).toBe("HAS_TWO_FACTOR");
    expect(edgeType("Invitation", "inviter")).toBe("HAS_INVITATION_INVITER");
  });

  it("names relation fields after the foreign key", () => {
    expect(relationFieldName("userId")).toBe("user");
    expect(relationFieldName("organization_id")).toBe("organization");
    expect(relationFieldName("oneToOne")).toBe("oneToOne");
    expect(plural("session")).toBe("sessions");
    expect(plural("policy")).toBe("policies");
    expect(plural("address")).toBe("addresses");
  });
});

describe("authSchema", () => {
  it("derives nodes, scalar types and constraints from the core models", () => {
    const { schema } = authSchema({});
    expect(schema.nodes.map((n) => n.name)).toEqual(["User", "Session", "Account", "Verification"]);
    const user = schema.nodes.find((n) => n.name === "User")!;
    expect(user.idField).toBe("id");
    expect(user.uniqueFields).toEqual(["id", "email"]);
    const field = (name: string) => user.fields.find((f) => f.name === name);
    expect(field("emailVerified")).toMatchObject({
      kind: "scalar",
      type: "Boolean",
      optional: false,
    });
    expect(field("image")).toMatchObject({ kind: "scalar", type: "String", optional: true });
    expect(field("createdAt")).toMatchObject({ kind: "scalar", type: "DateTime" });
    const verification = schema.nodes.find((n) => n.name === "Verification")!;
    expect(verification.fields.find((f) => f.name === "identifier")).toMatchObject({ index: true });
  });

  it("turns foreign keys into edges, not properties", () => {
    const graph = authSchema({});
    const session = graph.schema.nodes.find((n) => n.name === "Session")!;
    expect(session.fields.some((f) => f.name === "userId")).toBe(false);
    expect(session.fields.find((f) => f.name === "user")).toEqual({
      kind: "relation",
      name: "user",
      target: "User",
      relType: "HAS_SESSION",
      direction: "IN",
      many: false,
      optional: false,
    });
    const user = graph.schema.nodes.find((n) => n.name === "User")!;
    expect(user.fields.find((f) => f.name === "sessions")).toMatchObject({
      kind: "relation",
      target: "Session",
      relType: "HAS_SESSION",
      direction: "OUT",
      many: true,
    });
    expect(graph.models.get("session")!.fields.get("userId")).toMatchObject({
      kind: "fk",
      relation: "user",
      parentKey: "user",
      refField: "id",
      inverse: "sessions",
      onDelete: "cascade",
    });
  });

  it("follows Better Auth's model and field names (custom names, usePlural)", () => {
    const graph = authSchema({
      user: { modelName: "user_custom", fields: { email: "email_address" } },
      session: { fields: { userId: "owner_id" } },
    });
    const user = graph.models.get("user")!;
    expect(user).toMatchObject({
      dbName: "user_custom",
      node: "UserCustom",
      delegate: "userCustom",
    });
    expect(user.fields.has("email_address")).toBe(true);
    expect(graph.models.get("session")!.fields.get("owner_id")).toMatchObject({
      relation: "owner",
      relType: "HAS_SESSION",
    });
    expect(authSchema({}, { usePlural: true }).models.get("session")!.node).toBe("Sessions");
  });

  it("covers plugin models (organization) with one edge per foreign key", () => {
    const text = printSchemaDocument(authSchema({ plugins: [organization()] }).document);
    expect(text).toContain(
      'organization Organization @relationship(type: "HAS_MEMBER", direction: IN)',
    );
    expect(text).toContain('inviter User @relationship(type: "HAS_INVITATION", direction: IN)');
    expect(text).toContain('members Member[] @relationship(type: "HAS_MEMBER", direction: OUT)');
  });

  it("gives distinct edge types and names when a model references the same parent twice", () => {
    const tables: BetterAuthDBSchema = {
      user: { modelName: "user", fields: { name: { type: "string" } } },
      transfer: {
        modelName: "transfer",
        fields: {
          fromId: { type: "string", references: { model: "user", field: "id" }, required: true },
          toId: { type: "string", references: { model: "user", field: "id" } },
          from: { type: "string" },
        },
      },
    };
    const graph = deriveAuthGraph({
      schema: tables,
      getModelName: (m) => tables[m]?.modelName ?? m,
      getFieldName: ({ field }) => field,
    });
    const transfer = graph.models.get("transfer")!;
    // `from` is taken by a scalar, so the relation keeps the foreign-key name.
    expect(transfer.fields.get("fromId")).toMatchObject({
      relation: "fromId",
      relType: "HAS_TRANSFER_FROM_ID",
      inverse: "fromIdTransfers",
    });
    expect(transfer.fields.get("toId")).toMatchObject({
      relation: "to",
      relType: "HAS_TRANSFER_TO",
      inverse: "toTransfers",
      required: false,
    });
  });

  it("rejects names that are not Cyphra identifiers", () => {
    const tables: BetterAuthDBSchema = {
      user: { modelName: "user", fields: { "first-name": { type: "string" } } },
    };
    expect(() =>
      deriveAuthGraph({
        schema: tables,
        getModelName: () => "user",
        getFieldName: ({ field }) => field,
      }),
    ).toThrow(/not a valid Cyphra identifier/);
  });

  it("maps every Better Auth field type", () => {
    const tables: BetterAuthDBSchema = {
      thing: {
        modelName: "thing",
        fields: {
          s: { type: "string", required: true },
          n: { type: "number" },
          b: { type: "boolean" },
          d: { type: "date" },
          j: { type: "json" },
          ss: { type: "string[]" },
          ns: { type: "number[]" },
          e: { type: ["a", "b"] },
        },
      },
    };
    const graph = deriveAuthGraph({
      schema: tables,
      getModelName: () => "thing",
      getFieldName: ({ field }) => field,
    });
    expect(printSchemaDocument(graph.document)).toBe(
      [
        "node Thing {",
        "  id String @id @default(cuid())",
        "  s String",
        "  n Int?",
        "  b Boolean?",
        "  d DateTime?",
        "  j String?",
        "  ss String[]",
        "  ns Int[]",
        "  e String?",
        "}",
        "",
      ].join("\n"),
    );
  });

  describe("numberFields", () => {
    const tables: BetterAuthDBSchema = {
      wallet: {
        modelName: "wallets",
        fields: {
          balance: { type: "number", required: true, fieldName: "balance_amount" },
          rates: { type: "number[]" },
          count: { type: "number" },
          label: { type: "string" },
          userId: { type: "string", references: { model: "wallet", field: "id" } },
        },
      },
    };
    const derive = (numberFields: NumberFields) =>
      deriveAuthGraph(
        {
          schema: tables,
          getModelName: (m) => tables[m]?.modelName ?? m,
          getFieldName: ({ model, field }) => tables[model]?.fields[field]?.fieldName ?? field,
        },
        { numberFields },
      );

    it("stores the listed number fields as Float, by schema key or database name", () => {
      const configs: NumberFields[] = [
        { wallet: { balance: "float", rates: "float" } },
        { wallets: { balance_amount: "float", rates: "float", count: "int" } },
      ];
      for (const config of configs) {
        const graph = derive(config);
        const text = printSchemaDocument(graph.document);
        expect(text).toContain("  balance_amount Float\n");
        expect(text).toContain("  rates Float[]\n");
        expect(text).toContain("  count Int?\n");
        expect(graph.models.get("wallet")!.fields.get("balance_amount")).toMatchObject({
          type: "Float",
        });
      }
      expect(printSchemaDocument(derive({}).document)).toContain("  balance_amount Int\n");
    });

    it("rejects unknown models, unknown fields and fields that are not numbers", () => {
      expect(() => derive({ purse: { balance: "float" } })).toThrow(/unknown model "purse"/);
      expect(() => derive({ wallet: { nope: "float" } })).toThrow(/unknown field "wallet.nope"/);
      expect(() => derive({ wallet: { label: "float" } })).toThrow(/not a number field/);
      expect(() => derive({ wallet: { userId: "float" } })).toThrow(/not a number field/);
      expect(() => derive({ wallet: { balance: "double" as "float" } })).toThrow(
        /must be "int" or "float"/,
      );
    });

    it("is passed through by authSchema", () => {
      const plugin = {
        id: "wallet",
        schema: { wallet: { fields: { balance: { type: "number", required: true } } } },
      } as const;
      const { schema } = authSchema(
        { plugins: [plugin] },
        { numberFields: { wallet: { balance: "float" } } },
      );
      const wallet = schema.nodes.find((n) => n.name === "Wallet")!;
      expect(wallet.fields.find((f) => f.name === "balance")).toMatchObject({ type: "Float" });
    });
  });
});
