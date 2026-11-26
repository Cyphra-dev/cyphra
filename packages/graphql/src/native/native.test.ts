import { readFileSync } from "node:fs";
import { buildSchema, validateSchema } from "graphql";
import { parseSchema, resolveSchema, type SchemaModel } from "@cyphra/schema";
import { describe, expect, it } from "vitest";
import { defineGraphQL, makeSchema, NativeSchemaError, printSchema } from "./index.js";

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

  it("marks deprecated fields", () => {
    const sdl = printSchema(blog, {
      models: { Post: { fields: { body: { deprecated: "use title" } } } },
    });
    expect(sdl).toContain('body: String! @deprecated(reason: "use title")');
  });
});

describe("config checks at startup", () => {
  const bad = (config: unknown, message: RegExp) =>
    expect(() => printSchema(blog, config as never)).toThrow(message);

  it("rejects unknown models, fields, operations and options", () => {
    bad({ models: { Usr: {} } }, /unknown model "Usr"/);
    bad({ models: { User: { fields: { pasword: false } } } }, /unknown field "User.pasword"/);
    bad({ models: { User: { operations: { read: ["findAll"] } } } }, /unknown operation "findAll"/);
    bad({ models: { User: { operations: { create: true } } } }, /writes are not available/);
    bad({ limits: { maxTake: 0 } }, /maxTake must be a positive integer/);
    bad({ limitz: {} }, /unknown key "limitz"/);
    bad({ generator: 2 }, /unknown generator version 2/);
    bad({ naming: { Post: { findMany: "post-list" } } }, /must be a GraphQL name/);
    bad({ naming: { Post: { findMany: "userCount" } } }, /Two root fields are named "userCount"/);
    bad({ defaults: { operations: { read: false } } }, /has no root field/);
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
