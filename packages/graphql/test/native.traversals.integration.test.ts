/**
 * Traversals of the native API against a real Neo4j, under rules: a node the read rules hide is
 * never reached, stepped through or returned in a path, and path nodes follow the field rules
 * (#246): `<model>Traverse`, `<model>TraversePaths`, `<model>ShortestPath` and named traversal
 * fields.
 *
 * Needs NEO4J_TEST_URI / NEO4J_TEST_USER / NEO4J_TEST_PASSWORD; only nodes with `Nt*` labels are
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
node NtUser {
  id      String   @id
  name    String
  email   String?
  hidden  Boolean  @default(false)
  follows NtUser[] @relationship(type: "NT_FOLLOWS", direction: OUT)
  notes   NtNote[] @relationship(type: "NT_WROTE", direction: OUT)
}

node NtNote {
  id     String  @id
  title  String
  author NtUser? @relationship(type: "NT_WROTE", direction: IN)
}
`;

// a → b → d, a → h (hidden) → c; each user wrote one note.
const seed = `CREATE (a:NtUser {id: "a", name: "A", email: "a@x.io", hidden: false}),
  (b:NtUser {id: "b", name: "B", email: "b@x.io", hidden: false}),
  (h:NtUser {id: "h", name: "H", email: "h@x.io", hidden: true}),
  (c:NtUser {id: "c", name: "C", email: "c@x.io", hidden: false}),
  (d:NtUser {id: "d", name: "D", email: "d@x.io", hidden: false}),
  (a)-[:NT_FOLLOWS]->(b), (b)-[:NT_FOLLOWS]->(d), (a)-[:NT_FOLLOWS]->(h), (h)-[:NT_FOLLOWS]->(c),
  (a)-[:NT_WROTE]->(:NtNote {id: "na", title: "A"}), (b)-[:NT_WROTE]->(:NtNote {id: "nb", title: "B"}),
  (h)-[:NT_WROTE]->(:NtNote {id: "nh", title: "H"}), (c)-[:NT_WROTE]->(:NtNote {id: "nc", title: "C"}),
  (d)-[:NT_WROTE]->(:NtNote {id: "nd", title: "D"})`;

type Ctx = { user?: { id: string; admin?: boolean } };

const config = native.defineGraphQL<TypeMap, Ctx>({
  models: {
    NtUser: {
      operations: { traverse: true },
      rules: { read: ({ ctx }) => (ctx.user?.admin ? true : { hidden: false }) },
      fields: { email: { read: { where: ({ ctx }) => ({ id: ctx.user?.id ?? "" }) } } },
    },
  },
  traversals: {
    NtUser: {
      network: {
        via: [{ rel: "follows", depth: { max: 2 } }, { rel: "notes" }],
        args: ["orderBy", "take"],
      },
    },
  },
});

const anonymous: Ctx = {};
const ada: Ctx = { user: { id: "a" } };
const admin: Ctx = { user: { id: "root", admin: true } };

describe.skipIf(!hasNeo)("native GraphQL API: traversals (Neo4j)", () => {
  let driver: Driver;
  let schema: GraphQLSchema;
  const run = async (query: string, ctx: Ctx = anonymous) =>
    JSON.parse(JSON.stringify(await graphql({ schema, source: query, contextValue: { ...ctx } })));
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

  beforeAll(async () => {
    driver = neo4j.driver(env.uri!, neo4j.auth.basic(env.user!, env.password!));
    const db = createOrm<TypeMap>(resolveSchema(parseSchema(source)), { driver });
    schema = native.makeSchema({ client: db, config });
    await driver.executeQuery(
      "MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH 'Nt') DETACH DELETE n",
    );
    await driver.executeQuery(seed);
  });

  afterAll(async () => {
    await driver?.executeQuery(
      "MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH 'Nt') DETACH DELETE n",
    );
    await driver?.close();
  });

  it("traverse: a hidden node is neither reached nor stepped through", async () => {
    const q = `{ ntUserTraverse(from: { id: { equals: "a" } }, via: [follows], depth: { max: 2 }, orderBy: [{ id: asc }]) { id } }`;
    expect(ids((await run(q)).data.ntUserTraverse)).toEqual(["b", "d"]);
    expect(ids((await run(q, admin)).data.ntUserTraverse)).toEqual(["b", "c", "d", "h"]);
  });

  it("traversePaths: no hidden node in a path, and path nodes follow the field rules", async () => {
    const res = await run(
      `{ ntUserTraversePaths(from: { id: { equals: "a" } }, via: [follows], depth: { max: 2 }, orderBy: [{ id: asc }]) {
        node { id }
        path { nodes { id email } edges { type direction } }
      } }`,
      ada,
    );
    expect(res.data.ntUserTraversePaths).toEqual([
      {
        node: { id: "b" },
        path: {
          nodes: [
            { id: "a", email: "a@x.io" },
            { id: "b", email: null },
          ],
          edges: [{ type: "NT_FOLLOWS", direction: "out" }],
        },
      },
      {
        node: { id: "d" },
        path: {
          nodes: [
            { id: "a", email: "a@x.io" },
            { id: "b", email: null },
            { id: "d", email: null },
          ],
          edges: [
            { type: "NT_FOLLOWS", direction: "out" },
            { type: "NT_FOLLOWS", direction: "out" },
          ],
        },
      },
    ]);
  });

  it("shortestPath: no path through a hidden node", async () => {
    const q = `{ ntUserShortestPath(from: { id: { equals: "a" } }, to: { id: { equals: "c" } }, via: [follows], maxDepth: 3) { nodes { id } } }`;
    expect((await run(q)).data.ntUserShortestPath).toBeNull();
    expect(ids((await run(q, admin)).data.ntUserShortestPath.nodes)).toEqual(["a", "h", "c"]);
  });

  it("named traversal fields: compiled into the parent's statement, under the rules", async () => {
    const q = `{ ntUserFindUnique(where: { id: "a" }) { network(orderBy: [{ id: asc }]) { id } } }`;
    expect(ids((await run(q)).data.ntUserFindUnique.network)).toEqual(["nb", "nd"]);
    expect(ids((await run(q, admin)).data.ntUserFindUnique.network)).toEqual([
      "nb",
      "nc",
      "nd",
      "nh",
    ]);
    const firstTwo = await run(
      `{ ntUserFindMany(orderBy: [{ id: asc }], take: 2) { nodes { id network(orderBy: [{ id: asc }], take: 1) { id } } } }`,
    );
    expect(firstTwo.data.ntUserFindMany.nodes).toEqual([
      { id: "a", network: [{ id: "nb" }] },
      { id: "b", network: [{ id: "nd" }] },
    ]);
  });
});
