/**
 * Extension points of the native API against a real Neo4j, under rules (#247): computed fields
 * (`$extends({ result })`), Cypher-backed fields (context and arguments bound as parameters: no
 * injection), `extend` SDL with custom root fields, non-node result types and fields added to
 * generated types, and `ctx.cyphra.selection(info)` loading generated types in one statement.
 *
 * Needs NEO4J_TEST_URI / NEO4J_TEST_USER / NEO4J_TEST_PASSWORD; only nodes with `Nx*` labels are
 * touched.
 */
import { graphql, type GraphQLSchema } from "graphql";
import neo4j, { type Driver } from "neo4j-driver";
import { createOrm, type TypeMap } from "@cyphra/runtime";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { native } from "../src/index.js";

const env = {
  uri: process.env.NEO4J_TEST_URI,
  user: process.env.NEO4J_TEST_USER,
  password: process.env.NEO4J_TEST_PASSWORD,
};
const hasNeo = Boolean(env.uri && env.user && env.password);

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const source = /* cyphra */ `
node NxUser {
  id        String   @id
  firstName String
  lastName  String
  email     String?
  posts     NxPost[] @relationship(type: "NX_WROTE", direction: OUT)
  follows   NxUser[] @relationship(type: "NX_FOLLOWS", direction: OUT)
}

node NxPost {
  id        String  @id
  title     String
  published Boolean
  author    NxUser? @relationship(type: "NX_WROTE", direction: IN)
}
`;

// b and c follow a; a follows b. a wrote p1 (published) and p2 (draft); b wrote p3 (published).
const seed = `CREATE (a:NxUser {id: "a", firstName: "Ada", lastName: "Lovelace", email: "ada@x.io"}),
  (b:NxUser {id: "b", firstName: "Bob", lastName: "Byte", email: "bob@x.io"}),
  (c:NxUser {id: "c", firstName: "Cy", lastName: "Cole", email: "cy@x.io"}),
  (b)-[:NX_FOLLOWS {since: datetime("2026-01-01T00:00:00Z")}]->(a),
  (c)-[:NX_FOLLOWS {since: datetime("2026-06-01T00:00:00Z")}]->(a),
  (a)-[:NX_FOLLOWS {since: datetime("2026-03-01T00:00:00Z")}]->(b),
  (a)-[:NX_WROTE]->(:NxPost {id: "p1", title: "Engines", published: true}),
  (a)-[:NX_WROTE]->(:NxPost {id: "p2", title: "Draft", published: false}),
  (b)-[:NX_WROTE]->(:NxPost {id: "p3", title: "Bits", published: true})`;

type Ctx = { user?: { id: string; admin?: boolean }; tag?: string };

const { cypher } = native;

const config = native.defineGraphQL<TypeMap, Ctx>({
  models: {
    NxUser: { fields: { email: { read: ({ ctx }) => ctx.user?.admin === true } } },
    NxPost: {
      operations: { update: ["update"] },
      rules: {
        read: ({ ctx }) =>
          ctx.user?.admin
            ? true
            : { OR: [{ published: true }, { author: { is: { id: ctx.user?.id ?? "" } } }] },
        update: ({ ctx }) => ({ author: { is: { id: ctx.user?.id ?? "" } } }),
      },
    },
  },
  computed: {
    NxUser: {
      fullName: "String!",
      initials: { type: "String", read: ({ ctx }) => Boolean(ctx.user) },
    },
  },
  cypherFields: {
    NxUser: {
      followerCount: {
        type: "Int!",
        cypher: ({ node }) => cypher`COUNT { (${node})<-[:NX_FOLLOWS]-() }`,
      },
      followersSince: {
        type: "Int!",
        args: { since: "DateTime!" },
        cypher: ({ node, args }) =>
          cypher`COUNT { (${node})<-[f:NX_FOLLOWS]-() WHERE f.since >= ${args.since} }`,
      },
      isMe: {
        type: "Boolean!",
        cypher: ({ node, ctx }) => cypher`${node}.id = ${ctx.user?.id ?? null}`,
      },
      tagged: {
        type: "String",
        cypher: ({ ctx }) => cypher`${ctx.tag ?? null}`,
      },
      writings: {
        type: "[NxPost!]!",
        args: { first: { type: "Int", default: 10 } },
        cypher: ({ node, args }) =>
          cypher`COLLECT { MATCH (${node})-[:NX_WROTE]->(p) RETURN p ORDER BY p.id LIMIT ${args.first} }`,
      },
    },
  },
  extend: {
    typeDefs: /* GraphQL */ `
      type NxStats {
        users: Int!
        topAuthors: [NxUser!]!
      }
      extend type Query {
        nxStats: NxStats!
        nxMe: NxUser
        nxSearch(text: String!): [NxPost!]!
      }
      extend type Mutation {
        nxPublish(id: ID!): NxPost
      }
      extend type NxUser {
        greeting: String!
      }
    `,
    resolvers: {
      Query: {
        nxStats: () => ({}),
        nxMe: (_: unknown, __: unknown, ctx, info) =>
          ctx.user
            ? ctx.cyphra.nxUser.findUnique({
                where: { id: ctx.user.id },
                ...ctx.cyphra.selection(info),
              })
            : null,
        nxSearch: (_: unknown, args: { text: string }, ctx, info) =>
          ctx.cyphra.nxPost.findMany({
            where: { title: { contains: args.text } },
            orderBy: [{ id: "asc" }],
            ...ctx.cyphra.selection(info),
          }),
      },
      NxStats: {
        users: (_: unknown, __: unknown, ctx) => ctx.cyphra.nxUser.count(),
        topAuthors: (_: unknown, __: unknown, ctx, info) =>
          ctx.cyphra.nxUser.findMany({
            orderBy: [{ posts: { _count: "desc" } }, { id: "asc" }],
            take: 2,
            ...ctx.cyphra.selection(info),
          }),
      },
      Mutation: {
        nxPublish: (_: unknown, args: { id: string }, ctx, info) =>
          ctx.cyphra.nxPost.update({
            where: { id: args.id },
            data: { published: true },
            ...ctx.cyphra.selection(info),
          }),
      },
      NxUser: {
        greeting: {
          needs: { firstName: true },
          resolve: (user: { id: string; firstName: string }) => `Hi ${user.firstName} (${user.id})`,
        },
      },
    },
  },
});

const anonymous: Ctx = {};
const ada: Ctx = { user: { id: "a" } };
const admin: Ctx = { user: { id: "root", admin: true } };

describe.skipIf(!hasNeo)("native GraphQL API: extension points (Neo4j)", () => {
  let driver: Driver;
  let schema: GraphQLSchema;
  const statements: string[] = [];
  const run = async (query: string, ctx: Ctx = anonymous) =>
    JSON.parse(JSON.stringify(await graphql({ schema, source: query, contextValue: { ...ctx } })));
  const counted = async (query: string, ctx: Ctx = anonymous) => {
    statements.length = 0;
    const res = await run(query, ctx);
    return { res, statements: statements.length };
  };

  beforeAll(async () => {
    driver = neo4j.driver(env.uri!, neo4j.auth.basic(env.user!, env.password!));
    const db = createOrm<TypeMap>(resolveSchema(parseSchema(source)), { driver }) as unknown as {
      $extends(ext: unknown): object;
      $on(level: "query", fn: (e: { text: string }) => void): void;
    };
    db.$on("query", (e) => statements.push(e.text));
    const client = db.$extends({
      result: {
        nxUser: {
          fullName: {
            needs: { firstName: true, lastName: true },
            compute: (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`,
          },
          initials: {
            needs: { firstName: true, lastName: true },
            compute: (u: { firstName: string; lastName: string }) =>
              `${u.firstName[0]}${u.lastName[0]}`,
          },
        },
      },
    });
    schema = native.makeSchema({ client, config });
    await driver.executeQuery(
      "MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH 'Nx') DETACH DELETE n",
    );
    await driver.executeQuery(seed);
  });

  afterAll(async () => {
    await driver?.executeQuery(
      "MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH 'Nx') DETACH DELETE n",
    );
    await driver?.close();
  });

  it("computed fields: needs loaded, computed after decoding, read rule applied", async () => {
    const q = `{ nxUserFindMany(orderBy: [{ id: asc }], take: 2) { nodes { name: fullName initials } } }`;
    const anon = await run(q);
    expect(anon.data.nxUserFindMany.nodes).toEqual([
      { name: "Ada Lovelace", initials: null },
      { name: "Bob Byte", initials: null },
    ]);
    expect(anon.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    const signedIn = await run(q, ada);
    expect(signedIn.errors).toBeUndefined();
    expect(signedIn.data.nxUserFindMany.nodes[0]).toEqual({ name: "Ada Lovelace", initials: "AL" });
  });

  it("Cypher-backed fields: selected, filtered and sorted on, in one statement", async () => {
    const { res, statements: n } = await counted(
      `{ nxUserFindMany(where: { followerCount: { gte: 1 } }, orderBy: [{ followerCount: desc }]) {
        nodes { id followerCount recent: followersSince(since: "2026-02-01T00:00:00Z") all: followersSince(since: "2025-01-01T00:00:00Z") }
      } }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data.nxUserFindMany.nodes).toEqual([
      { id: "a", followerCount: 2, recent: 1, all: 2 },
      { id: "b", followerCount: 1, recent: 1, all: 1 },
    ]);
    expect(n).toBe(1);
  });

  it("Cypher-backed fields returning nodes: the target's read rules filter them", async () => {
    const q = `{ nxUserFindUnique(where: { id: "a" }) { writings { id } two: writings(first: 1) { id } } }`;
    expect((await run(q)).data.nxUserFindUnique).toEqual({
      writings: [{ id: "p1" }],
      two: [{ id: "p1" }],
    });
    expect((await run(q, ada)).data.nxUserFindUnique.writings).toEqual([
      { id: "p1" },
      { id: "p2" },
    ]);
  });

  it("Cypher-backed fields: the context is a parameter, never Cypher text", async () => {
    const evil = `x" OR true //`;
    const injection = `"}) MATCH (n) DETACH DELETE n //`;
    const q = `{ nxUserFindMany(orderBy: [{ id: asc }]) { nodes { id isMe tagged } } }`;
    statements.length = 0;
    const res = await run(q, { user: { id: evil }, tag: injection });
    expect(res.errors).toBeUndefined();
    expect(res.data.nxUserFindMany.nodes).toEqual([
      { id: "a", isMe: false, tagged: injection },
      { id: "b", isMe: false, tagged: injection },
      { id: "c", isMe: false, tagged: injection },
    ]);
    expect(statements.join("\n")).not.toContain("DETACH");
    expect(statements.join("\n")).not.toContain("OR true");
    expect((await run(q, ada)).data.nxUserFindMany.nodes[0].isMe).toBe(true);
    const left = await driver.executeQuery("MATCH (n:NxUser) RETURN count(n) AS c");
    expect(left.records[0]!.get("c").toNumber()).toBe(3);
  });

  it("extend: a non-node result type whose fields load generated types with the rules applied", async () => {
    const { res, statements: n } = await counted(
      `{ nxStats { users topAuthors { id fullName posts(orderBy: [{ id: asc }]) { title } byName: posts { id } } } }`,
    );
    expect(res.errors).toBeUndefined();
    expect(res.data.nxStats).toEqual({
      users: 3,
      topAuthors: [
        {
          id: "a",
          fullName: "Ada Lovelace",
          posts: [{ title: "Engines" }],
          byName: [{ id: "p1" }],
        },
        { id: "b", fullName: "Bob Byte", posts: [{ title: "Bits" }], byName: [{ id: "p3" }] },
      ],
    });
    // One statement per client call: users, topAuthors (with its nested posts).
    expect(n).toBe(2);
  });

  it("extend: ctx.cyphra applies the rules and field rules in custom root fields", async () => {
    const anon = await run(`{ nxSearch(text: "a") { id title } }`);
    expect(anon.data.nxSearch).toEqual([]);
    const mine = await run(`{ nxSearch(text: "a") { id title } }`, ada);
    expect(mine.data.nxSearch).toEqual([{ id: "p2", title: "Draft" }]);
    const me = await run(`{ nxMe { id email followerCount greeting } }`, ada);
    expect(me.data.nxMe).toEqual({
      id: "a",
      email: null,
      followerCount: 2,
      greeting: "Hi Ada (a)",
    });
    expect(me.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    expect((await run(`{ nxMe { email } }`, admin)).data.nxMe).toBeNull();
  });

  it("extend: a field added to a generated type gets its node, with its needs", async () => {
    const res = await run(
      `{ nxUserFindMany(orderBy: [{ id: asc }], take: 1) { nodes { greeting } } }`,
    );
    expect(res.data.nxUserFindMany.nodes).toEqual([{ greeting: "Hi Ada (a)" }]);
  });

  it("$unsafe reads around the rules", async () => {
    const ctx: Record<string, unknown> = {};
    await graphql({ schema, source: `{ nxStats { users } }`, contextValue: ctx });
    const cyphra = ctx.cyphra as {
      $unsafe: { nxPost: { count(): Promise<number> } };
      nxPost: { count(): Promise<number> };
    };
    const seen = [await cyphra.nxPost.count(), await cyphra.$unsafe.nxPost.count()];
    expect(seen).toEqual([2, 3]);
  });

  it("extend: a custom mutation through ctx.cyphra is subject to the update rule", async () => {
    const denied = await run(`mutation { nxPublish(id: "p3") { id published } }`, ada);
    expect(denied.data.nxPublish).toBeNull();
    expect(denied.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
    const done = await run(`mutation { nxPublish(id: "p2") { id published author { id } } }`, ada);
    expect(done.errors).toBeUndefined();
    expect(done.data.nxPublish).toEqual({ id: "p2", published: true, author: { id: "a" } });
  });
});
