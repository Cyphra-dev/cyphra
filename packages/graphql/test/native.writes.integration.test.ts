/**
 * The native API's mutations (`native.makeSchema` with writes on) against a real Neo4j: records
 * returned by every write, nested create / connect (a MERGE) / disconnect / set, `_ops`,
 * validation issue paths in GraphQL argument terms, error codes (`NOT_FOUND`,
 * `BAD_USER_INPUT`) and `mutationTransaction`. `UNIQUE_CONSTRAINT` is covered by the compat suite
 * (native/fixtures/writes, whose seed creates a constraint): schema changes here would wait on the
 * other suites running in parallel.
 *
 * Needs NEO4J_TEST_URI / NEO4J_TEST_USER / NEO4J_TEST_PASSWORD; only nodes with `Nw*` labels are
 * touched.
 */
import { graphql, type GraphQLSchema } from "graphql";
import neo4j, { type Driver } from "neo4j-driver";
import { createOrm, type OrmClient, type TypeMap } from "@cyphra/runtime";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { native } from "../src/index.js";

const env = {
  uri: process.env.NEO4J_TEST_URI,
  user: process.env.NEO4J_TEST_USER,
  password: process.env.NEO4J_TEST_PASSWORD,
};
const hasNeo = Boolean(env.uri && env.user && env.password);

// Several round trips per test, next to other suites on the same database.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const source = /* cyphra */ `
enum NwRole {
  MEMBER
  ADMIN
}

node NwUser {
  id         String   @id @default(cuid())
  email      String   @unique
  name       String?  @length(2, 50)
  loginCount Int      @default(0) @min(0)
  role       NwRole   @default(MEMBER)
  posts      NwPost[] @relationship(type: "NW_AUTHORED", direction: OUT)
  following  NwUser[] @relationship(type: "NW_FOLLOWS", direction: OUT)
  followers  NwUser[] @relationship(type: "NW_FOLLOWS", direction: IN)
}

node NwPost {
  id     String  @id @default(cuid())
  title  String  @length(3, 100)
  views  Int     @default(0)
  author NwUser? @relationship(type: "NW_AUTHORED", direction: IN)
  tags   NwTag[] @relationship(type: "NW_TAGGED", direction: OUT)
}

node NwTag {
  name  String   @id
  posts NwPost[] @relationship(type: "NW_TAGGED", direction: IN)
}

relationship NwFollows {
  type   "NW_FOLLOWS"
  from   NwUser
  to     NwUser
  since  DateTime @default(now())
  weight Int      @default(0) @min(0)
}

interface NwPerson {
  id   String @id
  name String
}

node NwEmployee implements NwPerson {
  salary Int
}
`;

const seed = `CREATE (a:NwUser {id: "u1", email: "alice@x.io", name: "Alice", loginCount: 1, role: "ADMIN"}),
  (b:NwUser {id: "u2", email: "bob@x.io", name: "Bob", loginCount: 0, role: "MEMBER"}),
  (c:NwUser {id: "u3", email: "carol@x.io", loginCount: 0, role: "MEMBER"}),
  (a)-[:NW_FOLLOWS {since: datetime("2024-01-01T00:00:00Z"), weight: 1}]->(c),
  (p1:NwPost {id: "p1", title: "Graphs", views: 10}),
  (a)-[:NW_AUTHORED]->(p1),
  (t1:NwTag {name: "db"}), (t2:NwTag {name: "api"}),
  (p1)-[:NW_TAGGED]->(t1),
  (:NwEmployee:NwPerson {id: "e1", name: "Erin", salary: 100})`;

const config = {
  models: {
    NwUser: { operations: { create: true, update: true, delete: true } },
    NwPost: { operations: { create: true, update: true, delete: true } },
    NwEmployee: { operations: { create: true } },
    NwPerson: { operations: { update: true, delete: ["deleteMany"] } },
  },
} as const;

describe.skipIf(!hasNeo)("native GraphQL API: mutations (Neo4j)", () => {
  let driver: Driver;
  let db: OrmClient<TypeMap>;
  let schema: GraphQLSchema;
  let perRequest: GraphQLSchema;

  const run = async (
    query: string,
    variables?: Record<string, unknown>,
    s: GraphQLSchema = schema,
  ) =>
    JSON.parse(
      JSON.stringify(await graphql({ schema: s, source: query, variableValues: variables })),
    );
  const count = async (cypher: string) =>
    (await driver.executeQuery(cypher)).records[0]!.get(0).toNumber() as number;

  beforeAll(async () => {
    driver = neo4j.driver(env.uri!, neo4j.auth.basic(env.user!, env.password!));
    db = createOrm<TypeMap>(resolveSchema(parseSchema(source)), { driver });
    schema = native.makeSchema({ client: db, config: native.defineGraphQL(config) });
    perRequest = native.makeSchema({
      client: db,
      config: native.defineGraphQL({ ...config, mutationTransaction: "request" }),
    });
  });

  beforeEach(async () => {
    await driver.executeQuery(
      "MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH 'Nw') DETACH DELETE n",
    );
    await driver.executeQuery(seed);
  });

  afterAll(async () => {
    await driver?.executeQuery(
      "MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH 'Nw') DETACH DELETE n",
    );
    await driver?.close();
  });

  it("creates with nested create and connect, and returns the record", async () => {
    const res = await run(`mutation {
      nwUserCreate(data: {
        email: "dan@x.io"
        name: "Dan"
        posts: { create: [{ title: "First", tags: { connect: [{ name: "db" }, { name: "api" }] } }] }
        following: { connect: [{ email: "bob@x.io", _edge: { weight: 2 } }] }
      }) {
        email loginCount role
        posts { title views tags(orderBy: [{ name: asc }]) { name } author { email } }
        following { email _edge { weight } }
      }
    }`);
    expect(res).toEqual({
      data: {
        nwUserCreate: {
          email: "dan@x.io",
          loginCount: 0,
          role: "MEMBER",
          posts: [
            {
              title: "First",
              views: 0,
              tags: [{ name: "api" }, { name: "db" }],
              author: { email: "dan@x.io" },
            },
          ],
          following: [{ email: "bob@x.io", _edge: { weight: 2 } }],
        },
      },
    });
  });

  it("generates no nested create for a model whose create is off", async () => {
    const res = await run(`mutation {
      nwPostCreate(data: { title: "New", tags: { create: [{ name: "x" }] } }) { id }
    }`);
    expect(res.errors[0].message).toMatch(
      /"create" is not defined by type "NwTagCreateManyWithoutPostsRelation"/,
    );
    expect(await count("MATCH (p:NwPost) RETURN count(p)")).toBe(1);
  });

  it("connect is a MERGE: connecting twice keeps one edge and updates _edge", async () => {
    const res = await run(`mutation {
      a: nwUserUpdate(where: { id: "u1" }, data: { following: { connect: [{ email: "carol@x.io", _edge: { _ops: { weight: { increment: 2 } } } }] } }) {
        following { email _edge { weight since } }
      }
      b: nwUserUpdate(where: { id: "u1" }, data: { following: { connect: [{ email: "carol@x.io" }] } }) {
        _count { following }
      }
    }`);
    expect(res.errors).toBeUndefined();
    expect(res.data.a.following).toEqual([
      { email: "carol@x.io", _edge: { weight: 3, since: "2024-01-01T00:00:00.000Z" } },
    ]);
    expect(res.data.b._count.following).toBe(1);
    expect(
      await count(
        "MATCH (:NwUser {id: 'u1'})-[r:NW_FOLLOWS]->(:NwUser {id: 'u3'}) RETURN count(r)",
      ),
    ).toBe(1);
  });

  it("updates scalars, _ops, null, disconnect and set", async () => {
    const res = await run(`mutation {
      nwUserUpdate(
        where: { email: "alice@x.io" }
        data: {
          name: null
          _ops: { loginCount: { increment: 2 } }
          following: { set: [{ email: "bob@x.io" }] }
          posts: { disconnect: [{ id: "p1" }] }
        }
      ) {
        name loginCount following { email } posts { id }
      }
      nwPostUpdate(where: { id: "p1" }, data: { author: { connect: { email: "bob@x.io" } }, _ops: { views: { multiply: 2 } } }) {
        views author { email }
      }
    }`);
    expect(res).toEqual({
      data: {
        nwUserUpdate: { name: null, loginCount: 3, following: [{ email: "bob@x.io" }], posts: [] },
        nwPostUpdate: { views: 20, author: { email: "bob@x.io" } },
      },
    });
  });

  it("rejects a value and an _ops update of one field, and null for a required field", async () => {
    const res = await run(`mutation {
      both: nwUserUpdate(where: { id: "u1" }, data: { loginCount: 3, _ops: { loginCount: { increment: 1 } } }) { id }
      required: nwUserUpdate(where: { id: "u1" }, data: { email: null }) { id }
    }`);
    expect(res.data).toEqual({ both: null, required: null });
    expect(res.errors.map((e: { extensions: { code: string } }) => e.extensions.code)).toEqual([
      "BAD_USER_INPUT",
      "BAD_USER_INPUT",
    ]);
    expect(res.errors[0].message).toMatch(/loginCount is given a value and an _ops update/);
    expect(res.errors[1].message).toMatch(/email is required and cannot be null/);
  });

  it("reports validation issues with GraphQL argument paths", async () => {
    const res = await run(`mutation {
      nested: nwUserCreate(data: { email: "e@x.io", name: "E", posts: { create: [{ title: "Okay" }, { title: "No" }] } }) { id }
      ops: nwUserUpdate(where: { id: "u2" }, data: { _ops: { loginCount: { decrement: 5 } } }) { id }
      edge: nwUserUpdate(where: { id: "u1" }, data: { following: { connect: [{ email: "carol@x.io", _edge: { _ops: { weight: { decrement: 9 } } } }] } }) { id }
    }`);
    const issues = Object.fromEntries(
      res.errors.map((e: { path: string[]; extensions: { code: string; issues: unknown[] } }) => [
        e.path[0],
        [e.extensions.code, e.extensions.issues],
      ]),
    );
    expect(issues.nested).toEqual([
      "BAD_USER_INPUT",
      [
        {
          path: ["data", "name"],
          model: "NwUser",
          field: "name",
          rule: "length",
          message: expect.any(String),
        },
        {
          path: ["data", "posts", "create", 1, "title"],
          model: "NwPost",
          field: "title",
          rule: "length",
          message: expect.any(String),
        },
      ],
    ]);
    expect(issues.ops[1]).toEqual([
      expect.objectContaining({ path: ["data", "_ops", "loginCount"], rule: "min" }),
    ]);
    expect(issues.edge[1]).toEqual([
      expect.objectContaining({
        path: ["data", "following", "connect", 0, "_edge", "_ops", "weight"],
        rule: "min",
      }),
    ]);
    // Nothing was written.
    expect(await count("MATCH (u:NwUser) RETURN count(u)")).toBe(3);
    expect(await count("MATCH (:NwUser)-[r:NW_FOLLOWS]->() RETURN sum(r.weight)")).toBe(1);
  });

  it("batch mutations return count and, when selected, the nodes", async () => {
    const res = await run(`mutation {
      created: nwPostCreateMany(data: [{ title: "Two" }, { title: "Three", views: 3 }]) {
        count nodes { title views }
      }
      updated: nwPostUpdateMany(where: { views: { lt: 5 } }, data: { _ops: { views: { increment: 1 } } }) {
        count
      }
      deleted: nwPostDeleteMany(where: { title: { in: ["Two", "Graphs"] } }) {
        n: count nodes { title views tags { name } }
      }
    }`);
    expect(res.errors).toBeUndefined();
    expect(res.data.created).toEqual({
      count: 2,
      nodes: [
        { title: "Two", views: 0 },
        { title: "Three", views: 3 },
      ],
    });
    expect(res.data.updated).toEqual({ count: 2 });
    expect(res.data.deleted.n).toBe(2);
    expect(
      res.data.deleted.nodes.sort((a: { title: string }, b: { title: string }) =>
        a.title.localeCompare(b.title),
      ),
    ).toEqual([
      { title: "Graphs", views: 10, tags: [{ name: "db" }] },
      { title: "Two", views: 1, tags: [] },
    ]);
  });

  it("upserts (both branches) and deletes, returning the records", async () => {
    const res = await run(`mutation {
      created: nwUserUpsert(where: { email: "eve@x.io" }, create: { email: "eve@x.io", name: "Eve" }, update: { name: "Eve2" }) { email name }
      updated: nwUserUpsert(where: { email: "eve@x.io" }, create: { email: "eve@x.io", name: "Eve" }, update: { name: "Eve2" }) { email name }
      deleted: nwUserDelete(where: { email: "eve@x.io" }) { email name }
      missing: nwUserDelete(where: { email: "eve@x.io" }) { email }
    }`);
    expect(res.data).toEqual({
      created: { email: "eve@x.io", name: "Eve" },
      updated: { email: "eve@x.io", name: "Eve2" },
      deleted: { email: "eve@x.io", name: "Eve2" },
      missing: null,
    });
    expect(res.errors.map((e: { extensions: { code: string } }) => e.extensions.code)).toEqual([
      "NOT_FOUND",
    ]);
  });

  it("writes through an interface and creates its implementations", async () => {
    const res = await run(`mutation {
      nwEmployeeCreate(data: { id: "e2", name: "Eli", salary: 50 }) { id name salary }
      nwPersonUpdate(where: { id: "e1" }, data: { name: "Erin B" }) { name ... on NwEmployee { salary } }
      nwPersonDeleteMany(where: { name: { startsWith: "El" } }) { count nodes { id __typename } }
    }`);
    expect(res).toEqual({
      data: {
        nwEmployeeCreate: { id: "e2", name: "Eli", salary: 50 },
        nwPersonUpdate: { name: "Erin B", salary: 100 },
        nwPersonDeleteMany: { count: 1, nodes: [{ id: "e2", __typename: "NwEmployee" }] },
      },
    });
  });

  it("runs each root field in its own transaction by default", async () => {
    const two = await run(`mutation {
      a: nwPostCreate(data: { title: "Kept" }) { title }
      b: nwPostCreate(data: { title: "No" }) { title }
    }`);
    expect(two.data).toEqual({ a: { title: "Kept" }, b: null });
    expect(await count("MATCH (p:NwPost {title: 'Kept'}) RETURN count(p)")).toBe(1);
  });

  it('commits every root field together with mutationTransaction: "request"', async () => {
    const failed = await run(
      `mutation {
        a: nwPostCreate(data: { title: "Kept?" }) { title }
        b: nwUserUpdate(where: { id: "u1" }, data: { name: "Al" }) { name }
        c: nwUserDelete(where: { id: "nope" }) { id }
        d: nwPostCreate(data: { title: "Never" }) { title }
      }`,
      undefined,
      perRequest,
    );
    expect(failed.data).toEqual({ a: null, b: null, c: null, d: null });
    expect(new Set(failed.errors.map((e: { message: string }) => e.message)).size).toBe(1);
    expect(failed.errors.map((e: { extensions: { code: string } }) => e.extensions.code)).toEqual([
      "NOT_FOUND",
      "NOT_FOUND",
      "NOT_FOUND",
      "NOT_FOUND",
    ]);
    expect(await count("MATCH (p:NwPost) RETURN count(p)")).toBe(1);
    expect(await count("MATCH (u:NwUser {name: 'Al'}) RETURN count(u)")).toBe(0);

    const ok = await run(
      `mutation {
        __typename
        a: nwPostCreate(data: { title: "One" }) { title }
        b: nwPostUpdate(where: { title: { equals: "One" }, id: "x" }, data: { views: 1 }) { title }
      }`,
      undefined,
      perRequest,
    );
    expect(ok.data).toEqual({ __typename: "Mutation", a: null, b: null });
    expect(await count("MATCH (p:NwPost {title: 'One'}) RETURN count(p)")).toBe(0);
    const good = await run(
      `mutation ($t: String!) {
        a: nwPostCreate(data: { id: "p9", title: $t }) { title }
        b: nwPostUpdate(where: { id: "p9" }, data: { views: 7 }) { title views }
      }`,
      { t: "Nine" },
      perRequest,
    );
    expect(good).toEqual({
      data: { a: { title: "Nine" }, b: { title: "Nine", views: 7 } },
    });
  });
});
