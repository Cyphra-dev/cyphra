import { execute, lexicographicSortSchema, parse, printType, type GraphQLNamedType } from "graphql";
import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { fakeDriver } from "../../test/helpers.js";
import { makeSchema, type Resolvers } from "./index.js";
import { UnsupportedTypeDefsError } from "./model.js";

// Test-only signing key; not a secret.
const KEY = "cyphra-resolvers-test-key";

const typeDefs = /* GraphQL */ `
  type Lab @node {
    id: ID! @id
    title: String!
    owners: [User!]! @relationship(type: "OWNS", direction: IN)
    "Progress of the viewer"
    myProgress: Progress @customResolver(requires: "id")
    ownerNames: [String!]! @customResolver(requires: "owners { name }")
  }
  type User @node {
    name: String!
  }
  "A progress"
  type Progress {
    labId: ID!
    percent: Int!
    level: Level
  }
  enum Level {
    LOW
    HIGH
  }
  input ProgressInput {
    labId: ID!
    percent: Int! = 0
  }
  type Query {
    whoAmI: String
    secret: String @authentication
    stats(level: Level): Progress!
  }
  type Mutation {
    recordProgress(input: ProgressInput!): Progress!
  }
`;

function printed(schema: ReturnType<typeof makeSchema>, name: string): string {
  return printType(lexicographicSortSchema(schema).getType(name) as GraphQLNamedType);
}

const resolvers: Resolvers = {
  Lab: {
    myProgress: (lab: { id: string }) => ({ labId: lab.id, percent: 50 }),
    ownerNames: (lab: { owners: { name: string }[] }) => lab.owners.map((o) => o.name),
  },
  Query: {
    whoAmI: (_: unknown, __: unknown, ctx: { jwt?: { sub?: string } }) => ctx.jwt?.sub ?? null,
    secret: () => "s3cret",
    stats: (_: unknown, args: { level?: string }) => ({
      labId: "all",
      percent: 7,
      level: args.level,
    }),
  },
  Mutation: {
    recordProgress: (_: unknown, { input }: { input: { labId: string; percent: number } }) => input,
  },
};

function schemaWith(rows: (cypher: string) => unknown[] = () => []) {
  const { driver, statements } = fakeDriver(rows);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const schema = makeSchema({
      typeDefs,
      driver,
      resolvers,
      features: { authorization: { key: KEY } },
    });
    return { schema, statements, driver };
  } finally {
    warn.mockRestore();
  }
}

describe("schema", () => {
  it("passes types without @node through and prints fields served by resolvers like v7", () => {
    const { schema } = schemaWith();
    expect(printed(schema, "Progress")).toBe(
      '"""A progress"""\ntype Progress {\n  labId: ID!\n  level: Level\n  percent: Int!\n}',
    );
    expect(printed(schema, "ProgressInput")).toBe(
      "input ProgressInput {\n  labId: ID!\n  percent: Int! = 0\n}",
    );
    expect(printed(schema, "Lab")).toContain(
      '  """Progress of the viewer"""\n  myProgress: Progress\n',
    );
    expect(printed(schema, "Lab")).toContain("  ownerNames: [String!]!\n");
    for (const input of ["LabWhere", "LabSort", "LabCreateInput", "LabUpdateInput"]) {
      expect(printed(schema, input)).not.toMatch(/myProgress|ownerNames/);
    }
    expect(printed(schema, "Query")).toContain("  stats(level: Level): Progress!\n");
    expect(printed(schema, "Mutation")).toContain(
      "  recordProgress(input: ProgressInput!): Progress!\n",
    );
  });

  it("warns about @customResolver fields without a resolver", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    makeSchema({ typeDefs, driver: fakeDriver().driver });
    expect(warn).toHaveBeenCalledWith("Custom resolver for myProgress has not been provided");
    warn.mockRestore();
  });

  it("rejects resolvers for types and fields that are not in the schema", () => {
    const { driver } = fakeDriver();
    expect(() => makeSchema({ typeDefs, driver, resolvers: { Nope: {} } })).toThrow(
      '"Nope" defined in resolvers, but not in schema',
    );
    expect(() => makeSchema({ typeDefs, driver, resolvers: { Lab: { nope: () => 1 } } })).toThrow(
      "Lab.nope defined in resolvers, but not in schema",
    );
  });

  it("checks @customResolver(requires) against the type", () => {
    const { driver } = fakeDriver();
    expect(() =>
      makeSchema({
        typeDefs: `type A @node { x: Int, y: Int @customResolver(requires: "nope") }`,
        driver,
      }),
    ).toThrow(UnsupportedTypeDefsError);
  });

  it("merges an array of resolver maps in order", async () => {
    const { driver } = fakeDriver();
    const schema = makeSchema({
      typeDefs,
      driver,
      resolvers: [
        { Query: { whoAmI: () => "first", secret: () => "x" } },
        { Query: { whoAmI: () => "second" } },
      ],
    });
    const result = await execute({ schema, document: parse("{ whoAmI }"), contextValue: {} });
    expect(result.data).toEqual({ whoAmI: "second" });
  });
});

describe("execution", () => {
  it("serves custom root queries and mutations with the application's resolvers", async () => {
    const { schema, statements } = schemaWith();
    const q = await execute({
      schema,
      document: parse("{ stats(level: HIGH) { labId pct: percent level } }"),
      contextValue: {},
    });
    expect(q.errors).toBeUndefined();
    expect(q.data).toEqual({ stats: { labId: "all", pct: 7, level: "HIGH" } });
    const m = await execute({
      schema,
      document: parse('mutation { recordProgress(input: { labId: "l1" }) { labId percent } }'),
      contextValue: {},
    });
    expect(m.data).toEqual({ recordProgress: { labId: "l1", percent: 0 } });
    expect(statements).toEqual([]);
  });

  it("leaves @customResolver fields out of the statement and always fetches `requires`", async () => {
    const { schema, statements } = schemaWith(() => [
      { title: "Graphs", id: "l1", owners: [{ name: "Ada" }] },
    ]);
    const result = await execute({
      schema,
      document: parse("{ labs { title myProgress { labId percent } ownerNames } }"),
      contextValue: {},
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      labs: [{ title: "Graphs", myProgress: { labId: "l1", percent: 50 }, ownerNames: ["Ada"] }],
    });
    const cypher = statements[0]!.cypher;
    expect(cypher).not.toContain("myProgress");
    expect(cypher).not.toContain("ownerNames");
    expect(cypher).toContain("`id`: this0.`id`");
    expect(cypher).toContain("`owners`: COLLECT { MATCH (this0)<-[:`OWNS`]-");
  });

  it("sets context.jwt from the verified token for the application's resolvers", async () => {
    const { schema } = schemaWith();
    const token = await new SignJWT({ sub: "user-1" })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode(KEY));
    const result = await execute({
      schema,
      document: parse("{ whoAmI }"),
      contextValue: { token: `Bearer ${token}` },
    });
    expect(result.data).toEqual({ whoAmI: "user-1" });
  });

  it("applies @authentication to fields served by resolvers", async () => {
    const { schema } = schemaWith();
    const denied = await execute({ schema, document: parse("{ secret }"), contextValue: {} });
    expect(denied.errors?.[0]?.message).toBe("Unauthenticated");
    const allowed = await execute({
      schema,
      document: parse("{ secret }"),
      contextValue: { jwt: { sub: "u" } },
    });
    expect(allowed.data).toEqual({ secret: "s3cret" });
  });
});
