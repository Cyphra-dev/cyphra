import { CyphraError } from "@cyphra/runtime";
import { describe, expect, it } from "vitest";
import { checkTypeDefs, makeSchema, readTypeDefs, UnsupportedTypeDefsError } from "./index.js";

/** One issue per line (on purpose), several of them on the same type or field. */
const MANY = `scalar Upload
type User @node @shareable {
  id: ID! @unique
  name: String @coalesce(value: "x")
  location: Point
  friends: [User!]! @relationship(type: "FRIEND", direction: OUT, queryDirection: DIRECTED)
  best: User! @relationship(type: "BEST", direction: OUT)
  posts: [Post!]! @relationship(type: "WROTE", direction: OUT, properties: "Nope")
}
type Post @node @limit(default: 0) {
  title: String @populatedBy(callback: "x") @unique
}
enum Color @custom { RED }
type Query { hello: String @auth }
`;

const EXPECTED = [
  {
    code: "UNSUPPORTED",
    message: "scalar Upload: custom scalars are not supported by @cyphra/graphql yet.",
    location: { type: "Upload", line: 1, column: 1 },
  },
  {
    code: "UNSUPPORTED",
    message: "type User: @shareable is not supported by @cyphra/graphql yet.",
    location: { type: "User", line: 2, column: 17 },
  },
  {
    code: "UNSUPPORTED",
    message: "User.id: @unique is not supported by @cyphra/graphql yet.",
    location: { type: "User", field: "id", line: 3, column: 11 },
  },
  {
    code: "UNSUPPORTED",
    message: "User.name: @coalesce is not supported by @cyphra/graphql yet.",
    location: { type: "User", field: "name", line: 4, column: 16 },
  },
  {
    code: "UNSUPPORTED",
    message: "User.location: Point is not supported by @cyphra/graphql yet.",
    location: { type: "User", field: "location", line: 5, column: 3 },
  },
  {
    code: "UNSUPPORTED",
    message: "User.friends: @relationship(queryDirection) is not supported by @cyphra/graphql yet.",
    location: { type: "User", field: "friends", line: 6, column: 67 },
  },
  {
    code: "INVALID",
    message: 'User.best: Non-list relationship property "best" cannot have non-nullable type.',
    location: { type: "User", field: "best", line: 7, column: 3 },
  },
  {
    code: "INVALID",
    message: "User.posts: properties type Nope must be a @relationshipProperties type.",
    location: { type: "User", field: "posts", line: 8, column: 3 },
  },
  {
    code: "INVALID",
    message: "type Post: @limit.default invalid value: 0. Must be greater than 0.",
    location: { type: "Post", line: 10, column: 17 },
  },
  {
    code: "UNSUPPORTED",
    message: "Post.title: @populatedBy is not supported by @cyphra/graphql yet.",
    location: { type: "Post", field: "title", line: 11, column: 17 },
  },
  {
    code: "UNSUPPORTED",
    message: "Post.title: @unique is not supported by @cyphra/graphql yet.",
    location: { type: "Post", field: "title", line: 11, column: 45 },
  },
  {
    code: "UNSUPPORTED",
    message: "enum Color: @custom is not supported by @cyphra/graphql yet.",
    location: { type: "Color", line: 13, column: 12 },
  },
  {
    code: "UNSUPPORTED",
    message: "Query.hello: @auth is not supported on Query fields by @cyphra/graphql yet.",
    location: { type: "Query", field: "hello", line: 14, column: 28 },
  },
];

describe("compat.v7.checkTypeDefs", () => {
  it("reports every unsupported construct and invalid usage, with its location", () => {
    expect(checkTypeDefs(MANY)).toEqual(EXPECTED);
  });

  it("returns no issue for type definitions makeSchema accepts", () => {
    const typeDefs = `type User @node { id: ID! name: String posts: [Post!]! @relationship(type: "WROTE", direction: OUT) }
type Post @node { title: String }`;
    expect(checkTypeDefs(typeDefs)).toEqual([]);
    expect(() => makeSchema({ typeDefs, driver: {} as never })).not.toThrow();
  });

  it("reports a syntax error as a SYNTAX issue", () => {
    expect(checkTypeDefs("type A @node {\n  id: ID\n", { source: "a.graphql" })).toEqual([
      {
        code: "SYNTAX",
        message: "Syntax Error: Expected Name, found <EOF>.",
        location: { source: "a.graphql", line: 3, column: 1 },
      },
    ]);
  });

  it("checks several files together, locating each issue in its file", () => {
    const issues = checkTypeDefs([
      {
        name: "user.graphql",
        body: 'type User @node {\n  id: ID!\n  posts: [Post!]! @relationship(type: "WROTE", direction: OUT)\n}',
      },
      { name: "post.graphql", body: "type Post @node {\n  title: String @unique\n}" },
    ]);
    expect(issues).toEqual([
      {
        code: "UNSUPPORTED",
        message: "Post.title: @unique is not supported by @cyphra/graphql yet.",
        location: { type: "Post", field: "title", source: "post.graphql", line: 2, column: 17 },
      },
    ]);
  });

  it("reports invalid @authorization rules and @customResolver selections", () => {
    const rules = `type User @node @authorization(filter: [{ where: { node: { nope: "x" } } }]) {
  id: ID!
}
type Post @node { id: ID @unique }`;
    expect(checkTypeDefs(rules).map((i) => [i.code, i.location.type, i.location.line])).toEqual([
      ["INVALID", "User", 1],
      ["UNSUPPORTED", "Post", 4],
    ]);
    const requires = `type User @node {
  id: ID!
  full: String @customResolver(requires: "nope")
}`;
    expect(checkTypeDefs(requires)).toEqual([
      expect.objectContaining({
        code: "INVALID",
        message: expect.stringContaining(
          "Invalid selection set provided to @customResolver on User",
        ),
        location: { type: "User", field: "full", line: 3, column: 3 },
      }),
    ]);
  });
});

describe("UnsupportedTypeDefsError", () => {
  it("makeSchema throws one error listing every issue", () => {
    let error: unknown;
    try {
      makeSchema({ typeDefs: MANY });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnsupportedTypeDefsError);
    expect(error).toBeInstanceOf(CyphraError);
    const e = error as UnsupportedTypeDefsError;
    expect(e.name).toBe("UnsupportedTypeDefsError");
    expect(e.issues).toEqual(EXPECTED);
    expect(e.message.split("\n")).toEqual([
      "13 problems in the type definitions:",
      ...EXPECTED.map(
        (i) => `- ${i.message} (line ${i.location.line}, column ${i.location.column})`,
      ),
    ]);
  });

  it("keeps the message of a single issue as is", () => {
    const typeDefs = `type A @node { id: ID @unique }`;
    expect(() => readTypeDefs(typeDefs)).toThrow(UnsupportedTypeDefsError);
    try {
      readTypeDefs(typeDefs);
    } catch (e) {
      expect((e as UnsupportedTypeDefsError).message).toBe(
        "A.id: @unique is not supported by @cyphra/graphql yet.",
      );
      expect((e as UnsupportedTypeDefsError).issues).toEqual([
        {
          code: "UNSUPPORTED",
          message: "A.id: @unique is not supported by @cyphra/graphql yet.",
          location: { type: "A", field: "id", line: 1, column: 23 },
        },
      ]);
    }
  });

  it("does not report what follows from another issue", () => {
    // The implementation field is not readable: the interface does not also report it missing.
    const typeDefs = `interface Named { name: String }
type Movie implements Named @node { name: String @unique }`;
    expect(checkTypeDefs(typeDefs).map((i) => i.message)).toEqual([
      "Movie.name: @unique is not supported by @cyphra/graphql yet.",
    ]);
  });
});
