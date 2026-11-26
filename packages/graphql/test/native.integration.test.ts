/**
 * The native API (`native.makeSchema`) against a real Neo4j: root fields, filters, ordering,
 * relations with aliases, `_edge`, `_count`, list paging (offset and keyset cursors, `pageInfo`,
 * `totalCount`), interfaces and unions through fragments, limits and error codes.
 *
 * Needs NEO4J_TEST_URI / NEO4J_TEST_USER / NEO4J_TEST_PASSWORD; only nodes with `Ng*` labels are
 * touched.
 */
import { graphql, type GraphQLSchema } from "graphql";
import neo4j, { type Driver } from "neo4j-driver";
import { createOrm, type OrmClient, type TypeMap } from "@cyphra/runtime";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { native } from "../src/index.js";

const env = {
  uri: process.env.NEO4J_TEST_URI,
  user: process.env.NEO4J_TEST_USER,
  password: process.env.NEO4J_TEST_PASSWORD,
};
const hasNeo = Boolean(env.uri && env.user && env.password);

const source = /* cyphra */ `
enum NgRole {
  MEMBER
  ADMIN
}

node NgUser {
  id        String   @id
  email     String   @unique
  name      String?
  role      NgRole   @default(MEMBER)
  secret    String?
  posts     NgPost[] @relationship(type: "NG_AUTHORED", direction: OUT)
  following NgUser[] @relationship(type: "NG_FOLLOWS", direction: OUT)
  followers NgUser[] @relationship(type: "NG_FOLLOWS", direction: IN)
}

node NgPost {
  id        String   @id
  title     String
  views     Int      @default(0)
  createdAt DateTime
  author    NgUser?  @relationship(type: "NG_AUTHORED", direction: IN)
  tags      NgTag[]  @relationship(type: "NG_TAGGED", direction: OUT)
}

node NgTag {
  name  String   @id
  posts NgPost[] @relationship(type: "NG_TAGGED", direction: IN)
}

relationship NgFollows {
  type  "NG_FOLLOWS"
  from  NgUser
  to    NgUser
  since DateTime
}

interface NgPerson {
  id      String    @id
  name    String
  manager NgPerson? @relationship(type: "NG_MANAGES", direction: IN)
}

node NgEmployee implements NgPerson {
  salary Int
}

node NgCustomer implements NgPerson {
  tier String
}

union NgHit = NgPost | NgTag
`;

const seed = [
  `CREATE (a:NgUser {id: "u1", email: "alice@x.io", name: "Alice", role: "ADMIN", secret: "s1"}),
          (b:NgUser {id: "u2", email: "bob@x.io", name: "Bob", role: "MEMBER"}),
          (c:NgUser {id: "u3", email: "carol@x.io", role: "MEMBER"}),
          (a)-[:NG_FOLLOWS {since: datetime("2024-01-01T00:00:00Z")}]->(b),
          (a)-[:NG_FOLLOWS {since: datetime("2025-01-01T00:00:00Z")}]->(c),
          (b)-[:NG_FOLLOWS {since: datetime("2024-06-01T00:00:00Z")}]->(a),
          (p1:NgPost {id: "p1", title: "Graphs", views: 10, createdAt: datetime("2024-01-01T00:00:00Z")}),
          (p2:NgPost {id: "p2", title: "Cypher", views: 30, createdAt: datetime("2024-02-01T00:00:00Z")}),
          (p3:NgPost {id: "p3", title: "GraphQL", views: 20, createdAt: datetime("2024-03-01T00:00:00Z")}),
          (p4:NgPost {id: "p4", title: "Neo4j", views: 5, createdAt: datetime("2024-04-01T00:00:00Z")}),
          (a)-[:NG_AUTHORED]->(p1), (a)-[:NG_AUTHORED]->(p2), (b)-[:NG_AUTHORED]->(p3),
          (t1:NgTag {name: "db"}), (t2:NgTag {name: "api"}),
          (p1)-[:NG_TAGGED]->(t1), (p2)-[:NG_TAGGED]->(t1), (p3)-[:NG_TAGGED]->(t2),
          (e1:NgEmployee:NgPerson {id: "e1", name: "Erin", salary: 100}),
          (e2:NgEmployee:NgPerson {id: "e2", name: "Eve", salary: 200}),
          (k1:NgCustomer:NgPerson {id: "k1", name: "Kim", tier: "gold"}),
          (e1)-[:NG_MANAGES]->(e2), (e1)-[:NG_MANAGES]->(k1)`,
];

describe.skipIf(!hasNeo)("native GraphQL API (Neo4j)", () => {
  let driver: Driver;
  let db: OrmClient<TypeMap>;
  let schema: GraphQLSchema;

  const run = async (
    query: string,
    variables?: Record<string, unknown>,
    s: GraphQLSchema = schema,
  ) =>
    JSON.parse(
      JSON.stringify(await graphql({ schema: s, source: query, variableValues: variables })),
    );

  beforeAll(async () => {
    driver = neo4j.driver(env.uri!, neo4j.auth.basic(env.user!, env.password!));
    await driver.executeQuery(
      "MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH 'Ng') DETACH DELETE n",
    );
    for (const s of seed) await driver.executeQuery(s);
    db = createOrm<TypeMap>(resolveSchema(parseSchema(source)), { driver });
    schema = native.makeSchema({
      client: db,
      config: native.defineGraphQL({
        models: { NgUser: { fields: { secret: false } } },
        limits: { maxDepth: 3, maxTake: 50 },
      }),
    });
  });

  afterAll(async () => {
    await driver?.executeQuery(
      "MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH 'Ng') DETACH DELETE n",
    );
    await driver?.close();
  });

  it("serves findMany with filters, ordering, relations and _count", async () => {
    const res = await run(`{
      ngPostFindMany(
        where: { title: { startsWith: "Graph" }, author: { is: { role: { equals: ADMIN } } } }
        orderBy: [{ views: desc }]
      ) {
        nodes { id title author { name } tags(orderBy: [{ name: asc }]) { name } _count { tags } }
        totalCount
      }
    }`);
    expect(res).toEqual({
      data: {
        ngPostFindMany: {
          nodes: [
            {
              id: "p1",
              title: "Graphs",
              author: { name: "Alice" },
              tags: [{ name: "db" }],
              _count: { tags: 1 },
            },
          ],
          totalCount: 1,
        },
      },
    });
  });

  it("hides fields turned off in the config", async () => {
    const res = await run(`{ ngUserFindUnique(where: { id: "u1" }) { secret } }`);
    expect(res.errors?.[0]?.message).toMatch(/Cannot query field "secret"/);
  });

  it("loads one relation twice under aliases, and edge properties as _edge", async () => {
    const res = await run(`{
      ngUserFindUnique(where: { email: "alice@x.io" }) {
        who: name
        recent: following(orderBy: [{ name: desc }], take: 1) { name _edge { since } }
        all: following(orderBy: [{ email: asc }]) { email _edge { since } }
        _count { following followers }
      }
    }`);
    expect(res.data.ngUserFindUnique).toEqual({
      who: "Alice",
      recent: [{ name: null, _edge: { since: "2025-01-01T00:00:00.000Z" } }],
      all: [
        { email: "bob@x.io", _edge: { since: "2024-01-01T00:00:00.000Z" } },
        { email: "carol@x.io", _edge: { since: "2025-01-01T00:00:00.000Z" } },
      ],
      _count: { following: 2, followers: 1 },
    });
  });

  it("rejects _edge outside a relation with an edge model", async () => {
    const res = await run(`{ ngUserFindFirst { _edge { since } } }`);
    expect(res.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    expect(res.errors[0].message).toMatch(/_edge is only available/);
    expect(res.data).toEqual({ ngUserFindFirst: null });
  });

  it("pages forward and backward with keyset cursors", async () => {
    const page = `query ($after: String, $before: String, $take: Int) {
      ngPostFindMany(orderBy: [{ createdAt: asc }], take: $take, after: $after, before: $before) {
        nodes { id }
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        totalCount
      }
    }`;
    const first = (await run(page, { take: 2 })).data.ngPostFindMany;
    expect(first.nodes).toEqual([{ id: "p1" }, { id: "p2" }]);
    expect(first.totalCount).toBe(4);
    expect(first.pageInfo).toMatchObject({ hasNextPage: true, hasPreviousPage: false });
    const second = (await run(page, { take: 2, after: first.pageInfo.endCursor })).data
      .ngPostFindMany;
    expect(second.nodes).toEqual([{ id: "p3" }, { id: "p4" }]);
    expect(second.pageInfo).toMatchObject({ hasNextPage: false, hasPreviousPage: true });
    const back = (await run(page, { take: 1, before: second.pageInfo.startCursor })).data
      .ngPostFindMany;
    expect(back.nodes).toEqual([{ id: "p2" }]);
    expect(back.pageInfo).toMatchObject({ hasNextPage: true, hasPreviousPage: true });
  });

  it("rejects a cursor made for another orderBy", async () => {
    const first = await run(`{ ngPostFindMany(take: 1) { pageInfo { endCursor } } }`);
    const res = await run(
      `query ($c: String) { ngPostFindMany(orderBy: [{ views: asc }], after: $c) { nodes { id } } }`,
      { c: first.data.ngPostFindMany.pageInfo.endCursor },
    );
    expect(res.errors[0].extensions.code).toBe("BAD_USER_INPUT");
  });

  it("pages by offset and counts", async () => {
    const res = await run(`{
      ngPostFindMany(orderBy: [{ views: asc }], skip: 1, take: 2) { nodes { views } }
      ngPostCount(where: { views: { gte: 10 } })
      ngTagFindFirst(orderBy: [{ posts: { _count: desc } }]) { name }
    }`);
    expect(res.data).toEqual({
      ngPostFindMany: { nodes: [{ views: 10 }, { views: 20 }] },
      ngPostCount: 3,
      ngTagFindFirst: { name: "db" },
    });
  });

  it("rejects two keys in one orderBy element, and limits", async () => {
    const two = await run(
      `{ ngPostFindMany(orderBy: [{ views: asc, title: asc }]) { nodes { id } } }`,
    );
    expect(two.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    const take = await run(`{ ngPostFindMany(take: 51) { nodes { id } } }`);
    expect(take.errors[0].extensions).toEqual({ code: "BAD_USER_INPUT", limit: "maxTake" });
    const deep = await run(
      `{ ngUserFindFirst { posts { author { posts { author { name } } } } } }`,
    );
    expect(deep.errors[0].extensions).toEqual({ code: "BAD_USER_INPUT", limit: "maxDepth" });
    const unique = await run(`{ ngUserFindUnique(where: { name: { equals: "Alice" } }) { id } }`);
    expect(unique.errors[0].extensions.code).toBe("BAD_USER_INPUT");
  });

  it("reads interfaces with fragments, _typename and _on", async () => {
    const res = await run(`{
      ngPersonFindMany(
        where: { _on: { NgEmployee: { salary: { gt: 50 } }, NgCustomer: {} } }
        orderBy: [{ _typename: asc }, { name: asc }]
      ) {
        nodes {
          __typename
          name
          manager { name }
          ... on NgEmployee { salary }
          ... on NgCustomer { tier }
        }
      }
      onlyCustomers: ngPersonCount(where: { _typename: { in: [NgCustomer] } })
    }`);
    expect(res).toEqual({
      data: {
        ngPersonFindMany: {
          nodes: [
            { __typename: "NgCustomer", name: "Kim", manager: { name: "Erin" }, tier: "gold" },
            { __typename: "NgEmployee", name: "Erin", manager: null, salary: 100 },
            { __typename: "NgEmployee", name: "Eve", manager: { name: "Erin" }, salary: 200 },
          ],
        },
        onlyCustomers: 1,
      },
    });
  });

  it("reads unions with fragments", async () => {
    const res = await run(`{
      ngHitFindMany(
        where: { _on: { NgPost: { views: { gte: 20 } }, NgTag: { name: { equals: "api" } } } }
      ) {
        nodes { __typename ... on NgPost { title } ... on NgTag { name } }
        totalCount
      }
    }`);
    expect(res.data.ngHitFindMany.totalCount).toBe(3);
    expect(res.data.ngHitFindMany.nodes).toEqual(
      expect.arrayContaining([
        { __typename: "NgPost", title: "Cypher" },
        { __typename: "NgPost", title: "GraphQL" },
        { __typename: "NgTag", name: "api" },
      ]),
    );
  });

  it("runs one statement per root field, whatever the depth and aliases", async () => {
    let statements = 0;
    const off = db.$on("query", () => statements++);
    try {
      const res = await run(`{
        ngUserFindMany(orderBy: [{ email: asc }], take: 2) {
          nodes {
            __typename
            email: posts(orderBy: [{ id: asc }]) { title _count { tags } tags { posts { id } } }
            following { followers { name } }
          }
          pageInfo { hasNextPage }
        }
      }`);
      expect(res.errors).toBeUndefined();
      const alice = res.data.ngUserFindMany.nodes[0];
      expect(alice.email.map((p: { title: string }) => p.title)).toEqual(["Graphs", "Cypher"]);
      expect(alice.email[0]._count).toEqual({ tags: 1 });
      expect(alice.following).toHaveLength(2);
      expect(statements).toBe(1);
    } finally {
      off();
    }
  });

  it("selects only __typename and nested fragments on a relation to an interface", async () => {
    const res = await run(`{
      ngTagFindMany(orderBy: [{ name: asc }]) { nodes { __typename } }
      ngPersonFindUnique(where: { id: "k1" }) {
        ... on NgCustomer { manager { __typename ... on NgEmployee { salary } } }
      }
    }`);
    expect(res).toEqual({
      data: {
        ngTagFindMany: { nodes: [{ __typename: "NgTag" }, { __typename: "NgTag" }] },
        ngPersonFindUnique: { manager: { __typename: "NgEmployee", salary: 100 } },
      },
    });
  });

  it("serves Relay global ids and node(id) with relay: true", async () => {
    const relay = native.makeSchema({ client: db, config: { relay: true } });
    const list = await run(
      `{ ngPostFindMany(orderBy: [{ id: asc }], take: 1) { nodes { id rawId } } ngPersonFindUnique(where: { id: "e2" }) { id } }`,
      undefined,
      relay,
    );
    const post = list.data.ngPostFindMany.nodes[0];
    expect(post.rawId).toBe("p1");
    expect(native.fromGlobalId(post.id)).toEqual({ type: "NgPost", key: "p1" });
    expect(native.fromGlobalId(list.data.ngPersonFindUnique.id)).toEqual({
      type: "NgEmployee",
      key: "e2",
    });
    const node = await run(
      `query ($id: ID!) { node(id: $id) { __typename id ... on NgPost { title author { id name } } } }`,
      { id: post.id },
      relay,
    );
    expect(node.data.node).toEqual({
      __typename: "NgPost",
      id: post.id,
      title: "Graphs",
      author: { id: native.toGlobalId("NgUser", "u1"), name: "Alice" },
    });
    const missing = await run(
      `query ($id: ID!) { node(id: $id) { id } }`,
      { id: native.toGlobalId("NgPost", "nope") },
      relay,
    );
    expect(missing).toEqual({ data: { node: null } });
    const malformed = await run(`{ node(id: "%%") { id } }`, undefined, relay);
    expect(malformed.errors[0].extensions.code).toBe("BAD_USER_INPUT");
  });

  it("runs the request's client when client is a function", async () => {
    const calls: string[] = [];
    const s = native.makeSchema({
      schema: db.$schema,
      client: () =>
        (db as unknown as { $extends(e: unknown): object }).$extends({
          query: {
            $allModels: {
              findMany: ({
                model,
                args,
                query,
              }: {
                model: string;
                args: unknown;
                query: (a: unknown) => Promise<unknown>;
              }) => {
                calls.push(model);
                return query(args);
              },
            },
          },
        }),
    });
    const res = await run(`{ ngTagFindMany { nodes { name } } }`, undefined, s);
    expect(res.data.ngTagFindMany.nodes).toHaveLength(2);
    expect(calls).toEqual(["NgTag"]);
  });
});
