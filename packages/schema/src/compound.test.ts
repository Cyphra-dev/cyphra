import { describe, expect, it } from "vitest";
import { SchemaValidationError } from "./errors.js";
import { formatSchema } from "./formatSchema.js";
import { getNodeModel, resolveSchema } from "./model.js";
import { parseSchema } from "./parseSchema.js";
import { printSchemaDocument } from "./printSchema.js";
import { renderCyphraGenSource } from "./renderCyphraGen.js";

const schema = `
node Account {
  id         String @id
  provider   String
  accountId  String
  tenant     String?
  createdAt  DateTime
  user       User   @relationship(type: "HAS_ACCOUNT", direction: IN)

  @@unique([provider, accountId])
  @@unique([tenant, accountId], name: "tenantAccount")
  @@index([provider, createdAt])
  @@index([tenant, createdAt], name: "byTenantDate")
}

node User {
  id       String    @id
  accounts Account[] @relationship(type: "HAS_ACCOUNT", direction: OUT)
}
`;

const badModel = (src: string) => () => resolveSchema(parseSchema(src));
const account = (body: string) =>
  `node Account {\n  id String @id\n  provider String\n  accountId String\n  tags String[]\n  data Json?\n  user User? @relationship(type: "HAS", direction: IN)\n  ${body}\n}\nnode User { id String @id\n accounts Account[] @relationship(type: "HAS", direction: OUT) }`;

describe("@@unique / @@index", () => {
  it("resolves composite constraints and indexes with default and custom names", () => {
    const n = getNodeModel(resolveSchema(parseSchema(schema)), "Account");
    expect(n.uniqueFields).toEqual(["id"]);
    expect(n.compoundUniques).toEqual([
      {
        name: "Account_provider_accountId_unique",
        key: "provider_accountId",
        fields: ["provider", "accountId"],
      },
      { name: "tenantAccount", key: "tenantAccount", fields: ["tenant", "accountId"] },
    ]);
    expect(n.compoundIndexes).toEqual([
      { name: "Account_provider_createdAt_idx", fields: ["provider", "createdAt"] },
      { name: "byTenantDate", fields: ["tenant", "createdAt"] },
    ]);
  });

  it("omits the keys for models without composite attributes", () => {
    const n = getNodeModel(resolveSchema(parseSchema(schema)), "User");
    expect(n).not.toHaveProperty("compoundUniques");
    expect(n).not.toHaveProperty("compoundIndexes");
  });

  it("round-trips through printSchemaDocument and formatSchema", () => {
    const printed = printSchemaDocument(parseSchema(schema));
    expect(printed).toContain("  @@unique([provider, accountId])\n");
    expect(printed).toContain('  @@unique([tenant, accountId], name: "tenantAccount")\n');
    expect(printed).toContain('  @@index([tenant, createdAt], name: "byTenantDate")\n');
    expect(resolveSchema(parseSchema(printed))).toEqual(resolveSchema(parseSchema(schema)));
    const formatted = formatSchema(
      "node A {\n  id String @id\n  a String\n  b Int // b\n  @@unique([a,b]) // pair\n}\n",
    );
    expect(formatted).toContain("@@unique([a, b]) // pair");
  });

  it("emits the compound keys in the generated type map", () => {
    const src = renderCyphraGenSource(parseSchema(schema));
    expect(src).toContain(
      '    compoundUniques: {\n      provider_accountId: "provider" | "accountId";\n      tenantAccount: "tenant" | "accountId";\n    };',
    );
  });

  it.each([
    ["@@unique([provider])", /at least two fields.*use @unique on the field/],
    ["@@index([provider])", /at least two fields.*use @index on the field/],
    ['@@unique(name: "x")', /at least two fields/],
    ["@@unique([provider, nope])", /@@unique field "nope" does not exist/],
    ["@@index([provider, provider])", /lists field "provider" twice/],
    ["@@unique([provider, user])", /field "user" is a relation/],
    ["@@unique([provider, tags])", /must be a single scalar value \(not String\[\]\)/],
    ["@@index([provider, data])", /must be a single scalar value \(not Json\)/],
    ['@@unique([provider, accountId], map: "x")', /unknown @@unique argument "map"/],
    ['@@unique([provider, accountId], name: "1x")', /name must be a string of letters/],
    [
      "@@unique([provider, accountId])\n  @@unique([accountId, provider])",
      /already covered by another @@unique/,
    ],
    [
      "@@unique([provider, accountId])\n  @@index([provider, accountId])",
      /already indexed by a @@unique/,
    ],
    ["@@index([provider, accountId])\n  @@index([provider, accountId])", /another @@index/],
    [
      '@@unique([provider, accountId], name: "x")\n  @@index([accountId, provider], name: "x")',
      /index name "x" is already used by @@unique on Account/,
    ],
    [
      '@@unique([provider, accountId], name: "Account_id_id")',
      /constraint name "Account_id_id" is already used by Account.id/,
    ],
    ['@@unique([provider, accountId], name: "tags")', /key "tags" is already a field/],
  ])("rejects %s", (attr, message) => {
    expect(badModel(account(attr))).toThrow(SchemaValidationError);
    expect(badModel(account(attr))).toThrow(message);
  });

  it("rejects composite attributes on relationship models", () => {
    expect(
      badModel(`node A { id String @id\n b A[] @relationship(type: "R", direction: OUT) }
relationship R { type "R" from A to A
  x String
  y String
  @@unique([x, y]) }`),
    ).toThrow(/composite uniqueness constraints are only supported on node models/);
  });

  it("accepts a reordered @@index next to a @@unique (a different index)", () => {
    const n = getNodeModel(
      resolveSchema(
        parseSchema(account("@@unique([provider, accountId])\n  @@index([accountId, provider])")),
      ),
      "Account",
    );
    expect(n.compoundIndexes).toEqual([
      { name: "Account_accountId_provider_idx", fields: ["accountId", "provider"] },
    ]);
  });
});
