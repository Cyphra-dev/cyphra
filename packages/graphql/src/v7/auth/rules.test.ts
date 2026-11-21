import { execute, parse } from "graphql";
import { describe, expect, it } from "vitest";
import { fakeDriver } from "../../../test/helpers.js";
import { CypherContext } from "../cypher/context.js";
import { makeSchema } from "../index.js";
import { readTypeDefs, UnsupportedTypeDefsError } from "../model.js";
import { checkAuthentication, jwtMatches, readPath, type AuthContext } from "./context.js";
import { AuthRules } from "./rules.js";

const typeDefs = /* GraphQL */ `
  type JWT @jwt {
    roles: [String!] @jwtClaim(path: "app.roles")
    org: String @jwtClaim(path: "https://example\\\\.com/org")
  }
  type Doc
    @node
    @authorization(
      filter: [
        { operations: [READ], where: { node: { ownerId: { eq: "$jwt.sub" } } } }
        {
          operations: [READ]
          requireAuthentication: false
          where: { node: { public: { eq: true } } }
        }
        {
          operations: [UPDATE]
          where: {
            OR: [{ node: { public: { eq: true } }, jwt: { roles: { includes: "editor" } } }]
          }
        }
      ]
      validate: [
        { operations: [READ], when: [BEFORE], where: { jwt: { roles: { includes: "reader" } } } }
        {
          operations: [UPDATE]
          when: [AFTER]
          where: { node: { org: { eq: "$context.tenant.id" } } }
        }
        { operations: [DELETE], where: { NOT: { jwt: { roles: { includes: "banned" } } } } }
      ]
    ) {
    id: ID!
    ownerId: String
    public: Boolean
    org: String
    secret: String
      @authorization(filter: [{ operations: [READ], where: { jwt: { roles_INCLUDES: "admin" } } }])
    pin: Int @authentication(operations: [READ], jwt: { roles: { includes: "admin" } })
  }
`;

const model = readTypeDefs(typeDefs);
const doc = model.node("Doc");

function auth(partial: Partial<AuthContext> = {}): AuthContext {
  return { isAuthenticated: true, jwt: {}, claims: undefined, context: {}, ...partial };
}

function compile(a: AuthContext) {
  const ctx = new CypherContext();
  return { rules: new AuthRules(model, ctx, a), ctx };
}

describe("model", () => {
  it("reads type, field and schema-level annotations, @jwtClaim paths", () => {
    const m = readTypeDefs(`
      extend schema @authentication(operations: [DELETE])
      type JWT @jwt { roles: [String!] @jwtClaim(path: "app.roles") }
      type T @node @authorization(validate: [{ where: { node: { id: { eq: "$jwt.sub" } } } }]) {
        id: ID! @authentication
      }
    `);
    expect([...m.authentication!.operations]).toEqual(["DELETE"]);
    expect(m.jwtClaims.get("roles")).toBe("app.roles");
    const t = m.node("T");
    // Defaults: every validate operation, BEFORE and AFTER, authentication required.
    expect(t.auth.authorization!.validate[0]).toMatchObject({
      when: ["BEFORE", "AFTER"],
      requireAuthentication: true,
    });
    expect(t.auth.authorization!.validate[0]!.operations).toContain("CREATE");
    expect([...t.attributes[0]!.auth!.authentication!.operations]).toContain("SUBSCRIBE");
  });

  it.each([
    [
      `@authorization(filter: [{ operations: [CREATE], where: { node: {} } }])`,
      /invalid operation CREATE/,
    ],
    [
      `@authorization(filter: [{ where: { node: {} }, when: [AFTER] }])`,
      /only applies to validate/,
    ],
    [`@authorization(validate: [{ where: { nodes: {} } }])`, /unknown key nodes/],
    [`@authorization(validate: [{ where: { node: {} }, when: [LATER] }])`, /invalid when LATER/],
    [`@authorization(other: [])`, /not supported/],
  ])("rejects invalid rules: %s", (directive, error) => {
    expect(() => readTypeDefs(`type T @node ${directive} { id: ID! }`)).toThrow(error);
  });

  it("rejects rules that do not fit the type when the schema is built", () => {
    const { driver } = fakeDriver();
    expect(() =>
      makeSchema({
        typeDefs: `type T @node @authorization(filter: [{ where: { node: { nope: { eq: 1 } } } }]) { id: ID! }`,
        driver,
      }),
    ).toThrow(UnsupportedTypeDefsError);
    expect(() =>
      makeSchema({
        typeDefs: `type T @node @authorization(filter: [{ where: { node: { id: "$jwt.sub" } } }]) { id: ID! }`,
        driver,
      }),
    ).toThrow(/invalid @authorization rule/);
  });

  it("rejects rules on relationship fields and relationship properties instead of ignoring them", () => {
    expect(() =>
      readTypeDefs(`
        type A @node { b: [B!]! @relationship(type: "R", direction: OUT) @authentication }
        type B @node { id: ID! }
      `),
    ).toThrow(/relationship field/);
    expect(() =>
      readTypeDefs(`
        type A @node { b: [B!]! @relationship(type: "R", direction: OUT, properties: "P") }
        type B @node { id: ID! }
        type P @relationshipProperties { since: Int @authorization(filter: [{ where: { jwt: {} } }]) }
      `),
    ).toThrow(/relationship properties/);
  });
});

describe("filter rules", () => {
  it("ORs the rules of an annotation, ANDs the field annotations, guards $jwt values", () => {
    const { rules, ctx } = compile(auth({ jwt: { sub: "u1", roles: ["admin"] } }));
    const secret = doc.attributes.find((a) => a.name === "secret")!;
    const f = rules.filter("n", doc, "READ", [secret]);
    expect(f).toBe(
      "((($p0 = true) AND (($p1 IS NOT NULL AND n.`ownerId` = $p1))) OR (n.`public` = $p2)) AND (($p0 = true) AND (($p3 IS NOT NULL AND $p4 IN $p3)))",
    );
    expect(ctx.params).toEqual({ p0: true, p1: "u1", p2: true, p3: ["admin"], p4: "admin" });
  });

  it("only applies the rules of the operation", () => {
    const { rules } = compile(auth());
    expect(rules.filter("n", doc, "AGGREGATE")).toBeUndefined();
    expect(rules.filter("n", doc, "DELETE")).toBeUndefined();
  });

  it("combines node and jwt of one OR element with AND (stricter than v7, which ORs them)", () => {
    const { rules } = compile(auth({ jwt: { roles: ["editor"] } }));
    expect(rules.filter("n", doc, "UPDATE")).toBe(
      "($p0 = true) AND ((n.`public` = $p1) AND (($p2 IS NOT NULL AND $p3 IN $p2)))",
    );
  });

  it("a missing claim is null and never matches", () => {
    const { rules, ctx } = compile(auth({ jwt: {} }));
    rules.filter("n", doc, "READ");
    expect(ctx.params.p1).toBeNull();
  });

  it("never inlines claim or context values into the Cypher text", () => {
    const evil = "x` }) MATCH (m) DETACH DELETE m //'\" $p0";
    const { rules, ctx } = compile(
      auth({
        jwt: { sub: evil, roles: [evil] },
        context: { tenant: { id: evil } },
      }),
    );
    const cypher = [
      rules.filter("n", doc, "READ"),
      rules.filter("n", doc, "UPDATE"),
      ...rules.validations("n", doc, "UPDATE", "AFTER"),
    ].join("\n");
    expect(cypher).not.toContain("DETACH");
    expect(cypher).not.toContain("x`");
    expect(Object.values(ctx.params)).toContain(evil);
  });

  it("applies @jwtClaim mappings only to tokens the library verified", () => {
    const jwt = { roles: ["editor"], app: { roles: ["admin"] } };
    const trusted = compile(auth({ jwt }));
    trusted.rules.filter("n", doc, "UPDATE");
    expect(trusted.ctx.params.p2).toEqual(["editor"]);
    const verified = compile(auth({ jwt, claims: model.jwtClaims }));
    verified.rules.filter("n", doc, "UPDATE");
    expect(verified.ctx.params.p2).toEqual(["admin"]);
  });
});

describe("validate rules", () => {
  it("keeps the rules of `when`, and fails on false or null", () => {
    const { rules } = compile(auth({ jwt: { roles: [] } }));
    expect(rules.validations("n", doc, "READ", "AFTER")).toEqual([]);
    expect(rules.fails("n", doc, "READ", "BEFORE")).toBe(
      "NOT coalesce(($p0 = true) AND (($p1 IS NOT NULL AND $p2 IN $p1)), false)",
    );
  });

  it("supports NOT at the top of a rule", () => {
    const { rules } = compile(auth({ jwt: { roles: ["banned"] } }));
    expect(rules.validations("n", doc, "DELETE", "BEFORE")).toEqual([
      "($p0 = true) AND (NOT (($p1 IS NOT NULL AND $p2 IN $p1)))",
    ]);
  });

  it("resolves $context paths through own properties only", () => {
    const { rules, ctx } = compile(auth({ context: { tenant: { id: "acme" } } }));
    rules.validations("n", doc, "UPDATE", "AFTER");
    expect(Object.values(ctx.params)).toContain("acme");
  });
});

describe("readPath", () => {
  it("does not read through the prototype chain or dot-prop's disallowed keys", () => {
    expect(readPath({ a: { b: 1 } }, ["a", "b"])).toBe(1);
    expect(readPath({}, ["constructor"])).toBeUndefined();
    expect(readPath({}, ["toString"])).toBeUndefined();
    expect(readPath({ a: {} }, ["a", "__proto__"])).toBeUndefined();
    expect(readPath(JSON.parse('{"__proto__": {"x": 1}}'), ["__proto__", "x"])).toBeUndefined();
    expect(readPath({ a: "s" }, ["a", "length"])).toBeUndefined();
  });
});

describe("@authentication", () => {
  const anonymous = auth({ isAuthenticated: false, jwt: undefined });

  it("throws Unauthenticated for anonymous requests and for JWTs that do not match", () => {
    expect(() => checkAuthentication(model, anonymous, doc, ["READ"], "pin")).toThrow(
      "Unauthenticated",
    );
    expect(() =>
      checkAuthentication(model, auth({ jwt: { roles: ["user"] } }), doc, ["READ"], "pin"),
    ).toThrow("Unauthenticated");
    expect(() =>
      checkAuthentication(model, auth({ jwt: { roles: ["admin"] } }), doc, ["READ"], "pin"),
    ).not.toThrow();
    // Other operations and fields are not covered.
    expect(() => checkAuthentication(model, anonymous, doc, ["UPDATE"], "pin")).not.toThrow();
    expect(() => checkAuthentication(model, anonymous, doc, ["READ"], "id")).not.toThrow();
  });

  it("matches the jwt filter like v7 filterByValues", () => {
    const a = (jwt: Record<string, unknown>) => auth({ jwt });
    expect(jwtMatches({ roles: { includes: "admin" } }, a({ roles: ["admin"] }))).toBe(true);
    expect(jwtMatches({ roles_INCLUDES: "admin" }, a({ roles: ["user"] }))).toBe(false);
    expect(jwtMatches({ roles: { includes: "admin" } }, a({ roles: "admin" }))).toBe(false);
    expect(jwtMatches({ level: { gte: 3 } }, a({ level: 5 }))).toBe(true);
    expect(jwtMatches({ OR: [{ a: { eq: 1 } }, { b: { eq: 2 } }] }, a({ b: 2 }))).toBe(true);
    expect(jwtMatches({ NOT: { a: { eq: 1 } } }, a({ a: 1 }))).toBe(false);
    // Arrays are not loosely equal to strings (v7 `==` would match).
    expect(jwtMatches({ role: { eq: "admin" } }, a({ role: ["admin"] }))).toBe(false);
    // A missing claim never matches.
    expect(jwtMatches({ sub: { eq: "x" } }, a({}))).toBe(false);
  });

  it("checks the schema-level annotation for every type", async () => {
    const { driver, statements } = fakeDriver();
    const schema = makeSchema({
      typeDefs: `extend schema @authentication(operations: [READ]) type T @node { id: ID! }`,
      driver,
    });
    const result = await execute({ schema, document: parse(`{ ts { id } }`) });
    expect(result.errors?.[0]?.message).toBe("Unauthenticated");
    expect(statements).toHaveLength(0);
  });
});

describe("reads", () => {
  it("replaces a selection that fails validation by a marker and answers Forbidden", async () => {
    const { driver, statements } = fakeDriver(() => [[{ "cyphra:forbidden": true }]]);
    const schema = makeSchema({ typeDefs, driver });
    const result = await execute({
      schema,
      document: parse(`{ docs { id } }`),
      contextValue: { jwt: { sub: "u1", roles: [] } },
    });
    expect(result.errors?.[0]?.message).toBe("Forbidden");
    expect(result.data).toBeNull();
    expect(statements[0]!.cypher).toMatch(
      /^RETURN CASE WHEN EXISTS \{ MATCH \(this0:`Doc`\) WHERE .* THEN \[\{ `cyphra:forbidden`: true \}\] ELSE COLLECT \{ MATCH \(this0:`Doc`\) WHERE .* RETURN CASE WHEN NOT coalesce\(.*\) THEN \{ `cyphra:forbidden`: true \} ELSE \{ `id`: this0.`id` \} END \} END AS this$/,
    );
  });

  it("an alias cannot produce the marker", () => {
    // Aliases are GraphQL names: `cyphra:forbidden` is not one.
    expect(() => parse(`{ ts { cyphra:forbidden: id } }`)).toThrow(/Syntax Error/);
  });
});
