import { describe, expect, it } from "vitest";
import { readTypeDefs, UnsupportedTypeDefsError } from "./model.js";
import { buildV7Schema } from "./sdl.js";
import { pageLimit } from "./cypher/select.js";

const rejects = (typeDefs: string, message: RegExp) =>
  expect(() => readTypeDefs(typeDefs)).toThrow(message);

describe("schema configuration directives", () => {
  it("removes root mutations hidden by @mutation, and the Mutation type when none is left", () => {
    const schema = buildV7Schema(
      readTypeDefs(`
        type User @node @mutation(operations: []) { id: ID! }
        type Post @node @mutation(operations: [UPDATE]) { id: ID! }
      `),
    );
    const mutation = schema.getMutationType()!;
    expect(Object.keys(mutation.getFields())).toEqual(["updatePosts"]);
    const none = buildV7Schema(
      readTypeDefs(`type User @node @mutation(operations: []) { id: ID! }`),
    );
    expect(none.getMutationType()).toBeUndefined();
  });

  it("applies schema-level @query / @mutation to every type", () => {
    const model = readTypeDefs(`
      extend schema @mutation(operations: [CREATE]) @query(read: false)
      type User @node { id: ID! }
    `);
    expect(model.node("User").mutation).toEqual({ create: true, update: false, delete: false });
    expect(model.node("User").query).toEqual({ read: false, connection: false, aggregate: false });
  });

  it("uses v7 defaults once a field directive is applied", () => {
    const model = readTypeDefs(`
      type User @node {
        a: String @selectable
        b: String @filterable
        c: String @settable(onUpdate: false)
        d: String
      }
    `);
    const config = (name: string) =>
      model.node("User").attributes.find((a) => a.name === name)!.config;
    expect(config("a")).toMatchObject({ onRead: true, onAggregate: false });
    expect(config("b")).toMatchObject({ byValue: true, byAggregate: false });
    expect(config("c")).toMatchObject({ onCreate: true, onUpdate: false });
    expect(config("d")).toMatchObject({ onAggregate: true, byAggregate: true, sortable: true });
  });

  it("rejects invalid or unsupported usages instead of ignoring them", () => {
    rejects(
      `extend schema @query(read: false)
       type A @node @query(read: true) { id: ID }`,
      /either schema or type/,
    );
    rejects(
      `type A @node @limit(default: 10, max: 5) { id: ID }`,
      /Must be greater than limit.default/,
    );
    rejects(`type A @node @limit(default: 0) { id: ID }`, /Must be greater than 0/);
    rejects(`type A @node @query(read: null) { id: ID }`, /must be a Boolean/);
    rejects(`type A @node @mutation(operations: [READ]) { id: ID }`, /CREATE, UPDATE or DELETE/);
    rejects(`type A @node { id: ID @selectable(onRaed: false) }`, /not an argument/);
    rejects(
      `type A @node { b: B @relationship(type: "R", direction: OUT) @selectable(onRead: false) }
       type B @node { id: ID }`,
      /to-one relationship/,
    );
    rejects(
      `type A @node { b: [B!]! @relationship(type: "R", direction: OUT) @alias(property: "x") }
       type B @node { id: ID }`,
      /@alias on a relationship field/,
    );
    rejects(`type P @relationshipProperties @limit(max: 2) { id: ID }`, /cannot be used/);
    rejects(`type A @node { id: ID @unique }`, /@unique/);
    rejects(`type A @node { id: ID @coalesce(value: "x") }`, /@coalesce/);
    rejects(`enum E @deprecated { A } type A @node { e: E }`, /enum E/);
    rejects(`enum E { A @custom } type A @node { e: E }`, /@custom/);
    expect(() => readTypeDefs(`type A @node { id: ID @private }`)).toThrow(
      UnsupportedTypeDefsError,
    );
  });
});

describe("schema configuration with custom resolvers", () => {
  it("lets the application redefine a root field hidden by @query / @mutation", () => {
    const schema = buildV7Schema(
      readTypeDefs(`
        type User @node @mutation(operations: []) @query(read: false) { id: ID! }
        type Query { users: [User!]! }
        type Mutation { createUsers(id: ID!): User! }
      `),
    );
    expect(Object.keys(schema.getQueryType()!.getFields())).toEqual(["users"]);
    expect(Object.keys(schema.getMutationType()!.getFields())).toEqual(["createUsers"]);
  });

  it("still rejects a custom field that clashes with a generated one", () => {
    rejects(
      `type User @node @mutation(operations: [CREATE]) { id: ID! }
       type Mutation { createUsers(id: ID!): User! }`,
      /conflicts with a generated Mutation field/,
    );
  });

  it("hides fields returning plain types with @selectable, and rejects it on @customResolver", () => {
    const schema = buildV7Schema(
      readTypeDefs(`
        type User @node { id: ID! settings: Settings @selectable(onRead: false) }
        type Settings { theme: String }
      `),
    );
    expect(
      Object.keys((schema.getType("User") as never as { getFields(): object }).getFields()),
    ).toEqual(["id"]);
    rejects(
      `type User @node { name: String @customResolver(requires: "id") @selectable(onRead: false) id: ID! }`,
      /@customResolver cannot be used in combination with @selectable/,
    );
    rejects(
      `type User @node { name: String @sortable @customResolver(requires: "id") id: ID! }`,
      /@sortable cannot be used in combination with @customResolver/,
    );
  });
});

describe("pageLimit", () => {
  const node = (limit?: { default?: number; max?: number }) =>
    ({ limit }) as unknown as Parameters<typeof pageLimit>[0];
  it("follows v7: requested, else default, else max, capped by max", () => {
    expect(pageLimit(node({ default: 2, max: 3 }), undefined)).toBe(2);
    expect(pageLimit(node({ default: 2, max: 3 }), 10)).toBe(3);
    expect(pageLimit(node({ default: 2, max: 3 }), 1)).toBe(1);
    expect(pageLimit(node({ max: 3 }), undefined)).toBe(3);
    expect(pageLimit(node({ default: 2 }), 10)).toBe(10);
    expect(pageLimit(node(), 7)).toBe(7);
  });
  it("does not let 0 bypass max (deliberately unlike v7)", () => {
    expect(pageLimit(node({ default: 2, max: 3 }), 0)).toBe(2);
    expect(pageLimit(node({ max: 3 }), 0)).toBe(3);
    expect(pageLimit(node(), 0)).toBe(0);
  });
});
