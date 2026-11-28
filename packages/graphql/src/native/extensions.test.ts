import { readFileSync } from "node:fs";
import { buildSchema, graphql, validateSchema } from "graphql";
import { createOrm, type TypeMap } from "@cyphra/runtime";
import { parseSchema, resolveSchema, type SchemaModel } from "@cyphra/schema";
import { describe, expect, it } from "vitest";
import { cypher, defineGraphQL, makeSchema, NativeSchemaError, printSchema } from "./index.js";

const blog: SchemaModel = resolveSchema(
  parseSchema(readFileSync(new URL("./__fixtures__/blog.cyphra", import.meta.url), "utf8")),
);

function valid(sdl: string): void {
  expect(validateSchema(buildSchema(sdl))).toEqual([]);
}

const followers = cypher`COUNT { ()-[:FOLLOWS]->() }`;

describe("extension points: printed contract", () => {
  const config = defineGraphQL({
    computed: {
      User: {
        label: "String!",
        secret: { type: "Role", read: () => false, description: "Hidden." },
      },
    },
    cypherFields: {
      User: {
        followerCount: { type: "Int!", cypher: () => followers },
        followersSince: { type: "Int!", args: { since: "DateTime!" }, cypher: () => followers },
        related: {
          type: "[Post!]!",
          args: { first: { type: "Int", default: 5 } },
          cypher: () => followers,
        },
        rank: { type: "Float", filter: false, cypher: () => followers },
      },
    },
    extend: {
      typeDefs: `
        type Dashboard { users: Int! top: [User!]! }
        extend type Query { dashboard: Dashboard! }
        extend type Mutation { ping(id: ID!): Post }
        extend type User { greeting: String! }
      `,
      resolvers: { User: { greeting: () => "hi" } },
    },
  });

  it("prints computed and Cypher-backed fields, their filters and sort keys, and the SDL", () => {
    const sdl = printSchema(blog, config);
    valid(sdl);
    expect(sdl).toMatch(/type User \{[^}]*\n {2}label: String!\n/);
    expect(sdl).toMatch(/type User \{[^}]*\n {2}secret: Role\n/);
    expect(sdl).toMatch(/type User \{[^}]*\n {2}followerCount: Int!\n/);
    expect(sdl).toMatch(/type User \{[^}]*\n {2}followersSince\(since: DateTime!\): Int!\n/);
    expect(sdl).toMatch(/type User \{[^}]*\n {2}related\(first: Int = 5\): \[Post!\]!\n/);
    expect(sdl).toMatch(/type User \{[^}]*\n {2}greeting: String!\n/);
    expect(sdl).toMatch(/input UserWhere \{[^}]*\n {2}followerCount: IntFilter\n/);
    expect(sdl).not.toMatch(/input UserWhere \{[^}]*\n {2}(followersSince|related|label|rank):/);
    expect(sdl).toMatch(/input UserOrderBy \{[^}]*\n {2}rank: SortOrder\n/);
    expect(sdl).not.toMatch(/input UserOrderBy \{[^}]*\n {2}(followersSince|label):/);
    expect(sdl).toContain("type Dashboard {");
    expect(sdl).toMatch(/type Query \{[^}]*\n {2}dashboard: Dashboard!\n/);
    // No generated mutation: `extend type Mutation` becomes the mutation root.
    expect(sdl).toContain("type Mutation {\n  ping(id: ID!): Post\n}");
  });
});

describe("extension points: startup checks", () => {
  const check = (config: unknown) => () => printSchema(blog, config as never);

  it("refuses unknown and abstract models, taken names and unknown types", () => {
    expect(check({ computed: { Nope: { x: "Int" } } })).toThrow(/unknown model "Nope"/);
    expect(check({ computed: { User: { email: "String" } } })).toThrow(
      /already has a field "email"/,
    );
    expect(
      check({
        computed: { User: { x: "Int" } },
        cypherFields: { User: { x: { type: "Int", cypher: () => followers } } },
      }),
    ).toThrow(/already has a field "x"/);
    expect(check({ computed: { User: { x: "Foo" } } })).toThrow(/"Foo" is not a scalar or an enum/);
    expect(check({ computed: { User: { x: "Post" } } })).toThrow(/is not a scalar or an enum/);
    expect(check({ computed: { User: { x: "[[Int]]" } } })).toThrow(/lists of lists/);
    expect(check({ cypherFields: { User: { x: { type: "Int" } } } })).toThrow(
      /cypher must be a function/,
    );
    expect(
      check({
        cypherFields: {
          User: { x: { type: "Int", args: { a: "Post" }, cypher: () => followers } },
        },
      }),
    ).toThrow(/is not a scalar or an enum/);
  });

  it("only takes filter / sort on a comparable scalar without arguments", () => {
    expect(
      check({
        cypherFields: {
          User: { x: { type: "Int", args: { a: "Int" }, filter: true, cypher: () => followers } },
        },
      }),
    ).toThrow(/can be filtered on/);
    expect(
      check({
        cypherFields: { User: { x: { type: "[Int!]!", sort: true, cypher: () => followers } } },
      }),
    ).toThrow(/can be sorted on/);
  });

  it("validates the extension SDL against the generated schema", () => {
    expect(check({ extend: { typeDefs: "extend type User { email: String }" } })).toThrow(
      /config\.extend\.typeDefs: .*User\.email/,
    );
    expect(check({ extend: { typeDefs: "type {" } })).toThrow(
      /config\.extend\.typeDefs: Syntax Error/,
    );
    expect(check({ extend: { typeDefs: "extend type User { x: Int }" } })).toThrow(
      /User\.x is added to a generated type and needs a resolver/,
    );
    expect(
      check({
        extend: { typeDefs: "extend type Query { x: Int }", resolvers: { Query: { y: () => 1 } } },
      }),
    ).toThrow(/Query has no field "y"/);
    expect(
      check({
        extend: {
          typeDefs: "extend type Query { x: Int }",
          resolvers: { Query: { userFindMany: () => 1 } },
        },
      }),
    ).toThrow(/is generated; only fields of config.extend.typeDefs take resolvers/);
    expect(check({ extend: { typeDefs: "query { x }" } })).toThrow(/not operations/);
  });

  it("checks computed fields against the client", () => {
    const db = createOrm<TypeMap>(blog, { driver: {} as never });
    expect(() =>
      makeSchema({ client: db, config: { computed: { User: { label: "String" } } } }),
    ).toThrow(NativeSchemaError);
    const extended = (db as unknown as { $extends(e: unknown): object }).$extends({
      result: {
        user: { label: { needs: { name: true }, compute: (u: { name: string }) => u.name } },
      },
    });
    expect(() =>
      makeSchema({ client: extended, config: { computed: { User: { label: "String" } } } }),
    ).not.toThrow();
  });
});

describe("extension points: an API served only by extend (#307)", () => {
  const config = {
    defaults: { operations: { read: false } },
    extend: {
      typeDefs: "extend type Query { status: String! }",
      resolvers: { Query: { status: () => "up" } },
    },
  };

  it("builds when every generated read is off and extend type Query adds the root fields", async () => {
    const sdl = printSchema(blog, config as never);
    valid(sdl);
    expect(sdl).toContain("type Query {\n  status: String!\n}");
    const db = createOrm<TypeMap>(blog, { driver: {} as never });
    const schema = makeSchema({ client: db, config: config as never });
    expect(validateSchema(schema)).toEqual([]);
    const res = await graphql({ schema, source: "{ status }", contextValue: {} });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ status: "up" });
  });

  it("still refuses an API with no root field at all", () => {
    expect(() =>
      printSchema(blog, {
        defaults: { operations: { read: false } },
        extend: { typeDefs: "type Extra { x: Int }" },
      } as never),
    ).toThrow(/has no root field/);
  });
});

describe("extension points: resolvers", () => {
  it("runs custom root fields with ctx.cyphra and refuses selection(info) on non-node fields", async () => {
    const db = createOrm<TypeMap>(blog, { driver: {} as never });
    const schema = makeSchema({
      client: db,
      config: {
        extend: {
          typeDefs: "extend type Query { hello: String! bad: String }",
          resolvers: {
            Query: {
              hello: (_: unknown, __: unknown, ctx) =>
                typeof ctx.cyphra.user === "object" ? "ok" : "no",
              bad: (_: unknown, __: unknown, ctx, info) =>
                JSON.stringify(ctx.cyphra.selection(info)),
            },
          },
        },
      },
    });
    const res = await graphql({ schema, source: "{ hello bad }", contextValue: {} });
    expect(res.data).toEqual({ hello: "ok", bad: null });
    expect(res.errors?.[0]?.message).toMatch(/does not return a generated type/);
    expect(res.errors?.[0]?.extensions?.code).toBe("BAD_USER_INPUT");
  });
});
