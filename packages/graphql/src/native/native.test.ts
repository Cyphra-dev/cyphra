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

  it("serves nested update / delete / upsert / connectOrCreate and _count filters", () => {
    const sdl = printSchema(blog, {
      models: {
        User: {
          operations: { create: true, update: true, delete: true },
          fields: { passwordHash: { read: false, create: true, update: false } },
        },
        Post: { operations: { create: true, update: ["update"], delete: true } },
      },
    });
    valid(sdl);
    // To-many: items name the node by unique key; to-one: the linked node.
    expect(sdl).toMatch(
      /input PostUpdateManyWithoutAuthorRelation \{[^}]*connectOrCreate: \[PostConnectOrCreateManyWithoutAuthorInput!\][^}]*delete: \[PostWhereUnique!\][^}]*update: \[PostUpdateWhereManyWithoutAuthorInput!\]/,
    );
    expect(sdl).toContain(
      "input PostUpdateWhereManyWithoutAuthorInput {\n  data: PostUpdateWithoutAuthorInput!\n  where: PostWhereUnique!\n}",
    );
    expect(sdl).toMatch(/input PostUpdateWithoutAuthorInput \{(?![^}]*author)[^}]*tags:/);
    expect(sdl).toMatch(
      /input UserUpdateOneWithoutPostsRelation \{[^}]*delete: Boolean[^}]*update: UserUpdateWithoutPostsInput[^}]*upsert: UserUpsertOneWithoutPostsInput/,
    );
    expect(sdl).toContain(
      "input UserUpsertOneWithoutPostsInput {\n  create: UserCreateWithoutPostsInput!\n  update: UserUpdateWithoutPostsInput!\n}",
    );
    // Post has no upsert operation: no nested upsert of posts; Tag is read-only: connect only.
    expect(sdl).not.toMatch(/input PostUpdateManyWithoutAuthorRelation \{[^}]*upsert/);
    expect(sdl).not.toContain("TagConnectOrCreate");
    expect(sdl).not.toMatch(/input TagUpdateManyWithoutPostsRelation \{[^}]*(update|delete):/);
    // On create: connectOrCreate only.
    expect(sdl).toMatch(
      /input PostCreateManyWithoutAuthorRelation \{[^}]*connectOrCreate:(?![^}]*(update|delete|upsert):)/,
    );
    // _count filters on to-many relations.
    expect(sdl).toMatch(/input UserWhere \{[^}]*_count: UserCountWhere/);
    expect(sdl).toContain(
      "input UserCountWhere {\n  followers: UserCountFilter\n  following: UserCountFilter\n  posts: PostCountFilter\n}",
    );
    expect(sdl).toMatch(/input PostCountFilter \{[^}]*gte: Int[^}]*where: PostWhere/);
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

describe("aggregates, groupBy and search", () => {
  it("serves aggregate and groupBy with typed aggregates per field", () => {
    const sdl = printSchema(blog);
    valid(sdl);
    expect(sdl).toContain(
      "postAggregate(orderBy: [PostOrderBy!], skip: Int, take: Int, where: PostWhere): PostAggregate",
    );
    expect(sdl).toContain("postGroupBy(by: PostGroupByInput!, having: PostHaving");
    // _sum keeps the number type, _avg is a Float, _min / _max the field's type.
    expect(sdl).toContain("type PostSumAggregate {\n  views: Int\n}");
    expect(sdl).toContain("type PostAvgAggregate {\n  views: Float\n}");
    expect(sdl).toMatch(/type PostMinAggregate \{[^}]*createdAt: DateTime[^}]*\}/);
    expect(sdl).not.toMatch(/type PostMinAggregate \{[^}]*published[^}]*\}/);
    // by: the model's fields and each to-one relation's.
    expect(sdl).toContain(
      'input PostGroupByInput {\n  """Fields of the related User (to-one)."""\n  author: [UserGroupField!]',
    );
    expect(sdl).toContain("type UserGroupKeys {");
    expect(sdl).toContain("input IntHaving {\n  _avg: FloatFilter");
  });

  it("serves search where a model has a full-text index, findSimilar only with traverse", () => {
    const sdl = printSchema(blog);
    expect(sdl).toContain("postSearch(");
    expect(sdl).toContain("enum PostFulltextIndex {\n  postSearch\n}");
    expect(sdl).not.toContain("userSearch(");
    // _score only on the types search results have.
    expect(sdl).toMatch(/type Post \{[^}]*_score: Float/);
    expect(sdl).not.toMatch(/type User \{[^}]*_score/);

    const vector = runtimeFixture("vector");
    expect(printSchema(vector)).not.toContain("FindSimilar(");
    const on = printSchema(vector, { models: { VecChunk: { operations: { traverse: true } } } });
    valid(on);
    expect(on).toContain("vecChunkFindSimilar(");
    expect(on).toContain("enum VecChunkVectorField {\n  embedding\n  sketch\n}");
  });

  it("serves union search over the members' indexes, with _scores on the members", () => {
    const schema = runtimeFixture("unionSearch");
    const sdl = printSchema(schema, {
      defaults: { operations: { traverse: ["findSimilar"] } },
    });
    valid(sdl);
    expect(sdl).toContain("usHitSearch(");
    expect(sdl).toContain("usHitFindSimilar(");
    expect(sdl).toContain("input UsHitSearchIndexes {");
    expect(sdl).toMatch(/type UsArticle [^{]*\{[^}]*_scores: \[IndexScore!\]/);
    expect(sdl).not.toContain("usHitAggregate");
    expect(sdl).not.toContain("usHitGroupBy");
  });

  it("turns the new reads off like the others", () => {
    const sdl = printSchema(blog, {
      defaults: { operations: { read: ["findMany"] } },
      naming: { Post: { aggregate: "postStats" } },
    });
    expect(sdl).not.toContain("Aggregate(");
    expect(sdl).not.toContain("postSearch(");
    expect(sdl).not.toContain("_score");
    const named = printSchema(blog, { naming: { Post: { aggregate: "postStats" } } });
    expect(named).toContain("postStats(");
    expect(() =>
      printSchema(blog, { models: { Post: { operations: { traverse: ["traverse"] as never } } } }),
    ).toThrow(NativeSchemaError);
  });

  it("rejects index names GraphQL cannot serve as enum values", () => {
    const s = fromSource(`node Doc {
      id    String @id
      title String
      @@fulltext([title], name: "true")
    }`);
    expect(() => printSchema(s)).toThrow(/not a valid GraphQL enum value/);
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

  it("checks auth config: rule keys, relations, field read rules, authenticated", () => {
    const fn = () => true;
    bad({ models: { Post: { rules: { write: fn } } } }, /rules: unknown key "write"/);
    bad(
      { models: { Post: { rules: { read: { published: true } } } } },
      /rules.read must be a function/,
    );
    bad({ models: { Post: { rules: { connect: { tagz: fn } } } } }, /unknown relation "Post.tagz"/);
    bad({ models: { Post: { rules: { after: { delete: fn } } } } }, /unknown key "delete"/);
    bad(
      { models: { User: { fields: { posts: { read: { where: fn } } } } } },
      /row-dependent rules \(\{ where \}\) are for scalar fields/,
    );
    bad(
      { models: { User: { fields: { id: { read: fn } } } } },
      /the @id field cannot have a read rule/,
    );
    bad(
      { models: { User: { fields: { email: { read: "admin" } } } } },
      /must be a boolean, a function or \{ where \}/,
    );
    bad(
      { models: { User: { authenticated: { read: ["findAll"] } } } },
      /unknown operation "findAll"/,
    );
    bad({ isAuthenticated: true }, /isAuthenticated must be a function/);
    expect(() =>
      printSchema(runtimeFixture("unions"), {
        models: { SearchHit: { rules: { update: fn } } },
      }),
    ).toThrow(/SearchHit is a union, which is only read/);
    expect(() =>
      printSchema(runtimeFixture("interfaces"), {
        models: { Employee: { fields: { bio: { read: fn } } } },
      }),
    ).toThrow(/a rule on a field of the interface Person goes on Person/);
  });

  it("checks the where of rules at startup (with an empty context)", () => {
    const make = (config: unknown) => () =>
      makeSchema({ client: { $schema: blog }, config: config as never });
    expect(make({ models: { Post: { rules: { read: () => ({ publishd: true }) } } } })).toThrow(
      /config.models.Post.rules.read: unknown field "Post.publishd"/,
    );
    expect(
      make({
        models: {
          Post: {
            rules: {
              update: () => ({ published: true, author: { is: { emial: "x" } } }),
            },
          },
        },
      }),
    ).toThrow(/rules.update.author.is: unknown field "User.emial"/);
    expect(
      make({ models: { Post: { rules: { connect: { tags: () => ({ OR: [{ nme: "x" }] }) } } } } }),
    ).toThrow(/rules.connect.tags.OR\[0\]: unknown field "Tag.nme"/);
    expect(
      make({ models: { User: { fields: { email: { read: { where: () => ({ idd: "x" }) } } } } } }),
    ).toThrow(/fields.email.read.where: unknown field "User.idd"/);
    expect(
      make({ models: { User: { rules: { read: () => ({ _count: { name: { gte: 1 } } }) } } } }),
    ).toThrow(/rules.read._count: "name" is not a to-many relation of User/);
    expect(
      make({
        models: {
          User: { rules: { read: () => ({ _count: { posts: { gte: 1, where: { x: 1 } } } }) } },
        },
      }),
    ).toThrow(/rules.read._count.posts.where: unknown field "Post.x"/);
    expect(
      make({ models: { User: { rules: { read: () => ({ _count: { posts: { gte: 1 } } }) } } } }),
    ).not.toThrow();
    // A rule that needs a context is checked on its first request instead.
    expect(
      make({
        models: {
          Post: {
            rules: {
              read: ({ ctx }: { ctx: { user: { id: string } } }) => ({
                author: { is: { id: ctx.user.id } },
              }),
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it("generates fields with a read rule nullable", () => {
    const sdl = printSchema(blog, {
      models: {
        User: {
          fields: {
            email: { read: { where: () => ({ name: "me" }) } },
            loginCount: { read: () => true },
            posts: { read: () => true },
            passwordHash: false,
          },
        },
      },
    });
    valid(sdl);
    expect(sdl).toMatch(/type User \{[^}]*\n {2}email: String\n/);
    expect(sdl).toMatch(/type User \{[^}]*\n {2}loginCount: Int\n/);
    expect(sdl).toMatch(/type User \{[^}]*\n {2}posts\([^)]*\): \[Post!\]\n/);
    expect(sdl).toMatch(/type User \{[^}]*\n {2}name: String\n/);
    expect(sdl).toMatch(/type User \{[^}]*\n {2}role: Role!\n/);
    const iface = printSchema(runtimeFixture("interfaces"), {
      models: { Person: { fields: { name: { read: () => true } } } },
    });
    valid(iface);
  });

  it("needs a schema when the client is a function", () => {
    expect(() => makeSchema({ client: () => ({}) })).toThrow(/pass schema/);
  });

  it("defineGraphQL returns its config", () => {
    const c = defineGraphQL({ limits: { maxDepth: 2 } });
    expect(c).toEqual({ limits: { maxDepth: 2 } });
  });
});
