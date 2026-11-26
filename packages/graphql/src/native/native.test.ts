import { readFileSync } from "node:fs";
import { buildSchema, validateSchema } from "graphql";
import { parseSchema, resolveSchema, type SchemaModel } from "@cyphra/schema";
import { describe, expect, it } from "vitest";
import {
  defineGraphQL,
  fromGlobalId,
  makeSchema,
  NativeSchemaError,
  printSchema,
  toGlobalId,
} from "./index.js";

function model(file: string | URL): SchemaModel {
  return resolveSchema(parseSchema(readFileSync(file, "utf8")));
}
const fromSource = (src: string) => resolveSchema(parseSchema(src));
const blog = model(new URL("./__fixtures__/blog.cyphra", import.meta.url));
const runtimeFixture = (name: string) =>
  model(new URL(`../../../runtime/src/orm/__fixtures__/${name}.cyphra`, import.meta.url));

/** The printed SDL is a valid schema (round-trips through graphql-js). */
function valid(sdl: string): void {
  expect(validateSchema(buildSchema(sdl))).toEqual([]);
}

describe("native.printSchema", () => {
  it("prints the running example of the design note", () => {
    const sdl = printSchema(blog, { models: { User: { fields: { passwordHash: false } } } });
    valid(sdl);
    expect(sdl).toContain("postFindMany(");
    expect(sdl).toContain("type PostList {\n  nodes: [Post!]!\n  pageInfo: PageInfo!");
    expect(sdl).toContain("_edge: Follows");
    expect(sdl).toContain("input UserScalarOrderBy {");
    expect(sdl).not.toContain("passwordHash");
    // Deterministic.
    expect(printSchema(blog)).toBe(printSchema(blog));
  });

  it("serves interfaces as GraphQL interfaces, fieldless ones as unions", () => {
    const sdl = printSchema(runtimeFixture("interfaces"));
    valid(sdl);
    expect(sdl).toContain("interface Person {");
    expect(sdl).toContain("type Employee implements Person {");
    expect(sdl).toContain("union Archivable = Employee");
    expect(sdl).toContain("interface PersonCount {");
    expect(sdl).toContain("type EmployeeCount implements PersonCount {");
    expect(sdl).toContain("input PersonOnWhere {");
    expect(sdl).toContain("enum PersonTypename {\n  Customer\n  Employee\n}");
  });

  it("serves unions, with _edge as a union when several edge models reach a node", () => {
    const sdl = printSchema(runtimeFixture("unions"));
    valid(sdl);
    expect(sdl).toContain("union SearchHit = Editor | Story | Writer");
    expect(sdl).toContain("searchHitFindMany(");
    expect(sdl).not.toContain("searchHitFindUnique");
    // Writer is reached through Pick (Shelf.picks) and Seat (Desk.seated, through Party).
    expect(sdl).toMatch(/union \w+Edge = Pick \| Seat/);
  });

  it("serves every scalar type of the client", () => {
    for (const f of ["types", "geo", "vector", "labels", "compound"])
      valid(printSchema(runtimeFixture(f)));
  });

  it("applies operation toggles, naming and field toggles", () => {
    const sdl = printSchema(blog, {
      defaults: { operations: { read: ["findMany"] } },
      models: {
        Tag: { operations: { read: false } },
        User: { fields: { email: { filter: false, sort: false }, posts: false } },
      },
      naming: { Post: { findMany: "posts" } },
    });
    valid(sdl);
    expect(sdl).toContain("  posts(");
    expect(sdl).not.toContain("postFindMany");
    expect(sdl).not.toContain("userCount");
    expect(sdl).not.toContain("tagFindMany");
    expect(sdl).toMatch(/type User \{[^}]*email: String!/);
    expect(sdl).not.toMatch(/input UserWhere \{[^}]*email/);
    expect(sdl).not.toMatch(/input UserOrderBy \{[^}]*email/);
    expect(sdl).not.toMatch(/type User \{[^}]*posts/);
  });

  it("serves no mutation unless writes are turned on", () => {
    expect(printSchema(blog)).not.toContain("type Mutation");
    expect(printSchema(blog)).not.toContain("CreateInput");
  });

  it("serves the write API of the design note", () => {
    const sdl = printSchema(blog, {
      models: {
        User: {
          operations: { create: true, update: true, delete: true },
          fields: { passwordHash: { read: false, create: true, update: false } },
        },
        Post: { operations: { create: true, update: true, delete: true } },
      },
    });
    valid(sdl);
    for (const field of [
      "postCreate(data: PostCreateInput!): Post",
      "postCreateMany(data: [PostCreateManyInput!]!): PostBatch",
      "postUpdate(data: PostUpdateInput!, where: PostWhereUnique!): Post",
      "postUpdateMany(data: PostUpdateManyInput!, where: PostWhere): PostBatch",
      "postUpsert(create: PostCreateInput!, update: PostUpdateInput!, where: PostWhereUnique!): Post",
      "postDelete(where: PostWhereUnique!): Post",
      "postDeleteMany(where: PostWhere): PostBatch",
    ]) {
      expect(sdl).toContain(`  ${field}\n`);
    }
    expect(sdl).not.toContain("tagCreate");
    expect(sdl).toContain("type PostBatch {\n  count: Int!");
    // A write-only field: set by create, never read or updated.
    expect(sdl).toMatch(/input UserCreateInput \{[^}]*passwordHash: String!/);
    expect(sdl).not.toMatch(/input UserUpdateInput \{[^}]*passwordHash/);
    expect(sdl).not.toMatch(/type User \{[^}]*passwordHash/);
    // Numeric operators in _ops; nested writes per relation side.
    expect(sdl).toContain("input PostOps {\n  views: IntOps\n}");
    expect(sdl).toMatch(/input UserUpdateInput \{[^}]*_ops: UserOps/);
    expect(sdl).toMatch(
      /input UserUpdateManyWithoutFollowersRelation \{[^}]*connect: \[UserConnectFollows!\][^}]*create: \[UserCreateWithoutFollowersInput!\][^}]*disconnect: \[UserWhereUnique!\][^}]*set: \[UserConnectFollows!\]/,
    );
    expect(sdl).toMatch(/input UserConnectFollows \{[^}]*_edge: FollowsInput/);
    expect(sdl).toMatch(/input UserCreateWithoutPostsInput \{(?![^}]*posts)[^}]*\}/);
    expect(sdl).toMatch(/input UserUpdateOneWithoutPostsRelation \{[^}]*disconnect: Boolean/);
    // Tag is read-only: connect only, no nested create.
    expect(sdl).toMatch(
      /input TagCreateManyWithoutPostsRelation \{\n[^}]*connect: \[TagWhereUnique!\]\n\}/,
    );
    // createMany / updateMany take no relation writes.
    expect(sdl).not.toMatch(/input PostCreateManyInput \{[^}]*tags/);
  });

  it("keeps raw ids in write inputs with relay", () => {
    const sdl = printSchema(blog, {
      relay: true,
      models: { Post: { operations: { create: true, update: true } } },
    });
    valid(sdl);
    expect(sdl).toMatch(/type Post implements Node \{[^}]*rawId: ID!/);
    expect(sdl).toMatch(/input PostCreateInput \{[^}]*\n {2}id: ID\n/);
  });

  it("applies write toggles: groups, upsert, field and relation toggles, naming", () => {
    const sdl = printSchema(blog, {
      defaults: { operations: { create: ["create"], update: ["update", "upsert"] } },
      models: {
        Tag: { operations: { create: false, update: false } },
        Post: { fields: { views: { update: false }, tags: { create: false } } },
      },
      naming: { Post: { create: "writePost" } },
    });
    valid(sdl);
    expect(sdl).toContain("  writePost(data: PostCreateInput!): Post");
    expect(sdl).not.toContain("upsert"); // create does not include it
    expect(sdl).not.toContain("CreateMany(");
    expect(sdl).not.toMatch(/input PostCreateInput \{[^}]*tags/);
    expect(sdl).toMatch(/input PostUpdateInput \{[^}]*tags/);
    expect(sdl).not.toMatch(/input PostUpdateInput \{[^}]*views/);
    expect(sdl).not.toContain("PostOps");
  });

  it("writes interfaces through their implementations and unions not at all", () => {
    const sdl = printSchema(runtimeFixture("interfaces"), {
      defaults: { operations: { create: true, update: true, delete: true } },
    });
    valid(sdl);
    expect(sdl).not.toContain("personCreate");
    expect(sdl).toContain("personUpdate(");
    expect(sdl).toContain("employeeCreate(");
    valid(
      printSchema(runtimeFixture("unions"), {
        defaults: { operations: { create: true, update: true, delete: true } },
      }),
    );
    expect(
      printSchema(runtimeFixture("unions"), {
        defaults: { operations: { create: true, update: true, delete: true } },
      }),
    ).not.toContain("searchHitUpdate");
    for (const f of ["types", "geo", "vector", "labels", "compound", "graph", "ondelete"]) {
      valid(
        printSchema(runtimeFixture(f), {
          defaults: { operations: { create: true, update: true, delete: true } },
        }),
      );
    }
  });

  it("marks deprecated fields", () => {
    const sdl = printSchema(blog, {
      models: { Post: { fields: { body: { deprecated: "use title" } } } },
    });
    expect(sdl).toContain('body: String! @deprecated(reason: "use title")');
  });
});

describe("relay", () => {
  it("adds Node, node(id) and rawId, and keeps inputs on the raw id", () => {
    const sdl = printSchema(blog, { relay: true });
    valid(sdl);
    expect(sdl).toContain("interface Node {\n");
    expect(sdl).toContain("node(id: ID!): Node");
    expect(sdl).toMatch(/type Post implements Node \{/);
    expect(sdl).toMatch(/type Post implements Node \{[^}]*rawId: ID!/);
    // Tag's key is `name`: no rawId, `name` stays.
    expect(sdl).toMatch(/type Tag implements Node \{[^}]*name: ID!/);
    expect(sdl).not.toMatch(/type Tag implements Node \{[^}]*rawId:/);
    expect(sdl).toMatch(/input PostWhere \{[^}]*\bid: IDFilter/);
  });

  it("makes interfaces with an @id implement Node too", () => {
    const sdl = printSchema(runtimeFixture("interfaces"), { relay: true });
    valid(sdl);
    expect(sdl).toContain("interface Person implements Node {");
    expect(sdl).toContain("type Employee implements Node & Person");
  });

  it("is off by default", () => {
    expect(printSchema(blog)).not.toContain("interface Node");
  });

  it("round-trips global ids", () => {
    const id = toGlobalId("Post", "p:1");
    expect(fromGlobalId(id)).toEqual({ type: "Post", key: "p:1" });
    expect(fromGlobalId("not base64!")).toBeUndefined();
  });
});

describe("config checks at startup", () => {
  const bad = (config: unknown, message: RegExp) =>
    expect(() => printSchema(blog, config as never)).toThrow(message);

  it("rejects unknown models, fields, operations and options", () => {
    bad({ models: { Usr: {} } }, /unknown model "Usr"/);
    bad({ models: { User: { fields: { pasword: false } } } }, /unknown field "User.pasword"/);
    bad({ models: { User: { operations: { read: ["findAll"] } } } }, /unknown operation "findAll"/);
    bad({ models: { User: { operations: { create: ["update"] } } } }, /unknown operation "update"/);
    bad({ mutationTransaction: "all" }, /mutationTransaction must be "field" or "request"/);
    bad({ limits: { maxTake: 0 } }, /maxTake must be a positive integer/);
    bad({ limitz: {} }, /unknown key "limitz"/);
    bad({ generator: 2 }, /unknown generator version 2/);
    bad({ naming: { Post: { findMany: "post-list" } } }, /must be a GraphQL name/);
    bad({ naming: { Post: { findMany: "userCount" } } }, /Two root fields are named "userCount"/);
    bad({ defaults: { operations: { read: false } } }, /has no root field/);
    bad({ relay: "yes" }, /relay must be a boolean/);
  });

  it("rejects write configs it cannot serve", () => {
    bad(
      { models: { User: { operations: { create: true }, fields: { passwordHash: false } } } },
      /User.passwordHash is required, has no default and cannot be set by create/,
    );
    expect(() =>
      printSchema(runtimeFixture("interfaces"), {
        models: { Person: { operations: { create: true } } },
      }),
    ).toThrow(/Person is an interface and cannot be created/);
    expect(() =>
      printSchema(runtimeFixture("unions"), {
        models: { SearchHit: { operations: { delete: true } } },
      }),
    ).toThrow(/SearchHit is a union and has no write operations/);
  });

  it("rejects reserved field names and name collisions", () => {
    expect(() => printSchema(fromSource(`node A {\n  id String @id\n  _count Int\n}`))).toThrow(
      NativeSchemaError,
    );
    expect(() => printSchema(fromSource(`node PageInfo {\n  id String @id\n}`))).toThrow(
      /PageInfo/,
    );
    expect(() =>
      printSchema(fromSource(`node A {\n  id String @id\n}\nnode AWhere {\n  id String @id\n}`)),
    ).toThrow(/AWhere/);
  });

  it("rejects hiding an interface field on one implementation only", () => {
    expect(() =>
      printSchema(runtimeFixture("interfaces"), {
        models: { Employee: { fields: { bio: false } } },
      }),
    ).toThrow(/hide it on Person/);
    valid(
      printSchema(runtimeFixture("interfaces"), { models: { Person: { fields: { bio: false } } } }),
    );
  });

  it("needs a schema when the client is a function", () => {
    expect(() => makeSchema({ client: () => ({}) })).toThrow(/pass schema/);
  });

  it("defineGraphQL returns its config", () => {
    const c = defineGraphQL({ limits: { maxDepth: 2 } });
    expect(c).toEqual({ limits: { maxDepth: 2 } });
  });
});
