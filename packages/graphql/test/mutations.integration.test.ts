/**
 * Mutations against a real Neo4j (5.23+): `info` counters match what changed in the database, nested
 * writes land, a failed check rolls the whole statement back, and concurrent `connect` behaves
 * like `@neo4j/graphql` v7 (one new relationship per connect, never lost).
 *
 * Needs NEO4J_TEST_URI / NEO4J_TEST_USER / NEO4J_TEST_PASSWORD; only nodes with the `GqlMut*`
 * labels used here are touched.
 */
import { CyphraClient } from "@cyphra/runtime";
import { execute, parse, type GraphQLSchema } from "graphql";
import neo4j, { type Driver } from "neo4j-driver";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compat } from "../src/index.js";

const env = {
  uri: process.env.NEO4J_TEST_URI,
  user: process.env.NEO4J_TEST_USER,
  password: process.env.NEO4J_TEST_PASSWORD,
};
const hasNeo = Boolean(env.uri && env.user && env.password);

const typeDefs = /* GraphQL */ `
  type GqlMutMovie @node {
    id: ID! @id
    title: String!
    released: Int
    genres: [String!]
    updatedAt: DateTime @timestamp(operations: [UPDATE])
    actors: [GqlMutPerson!]!
      @relationship(type: "ACTED_IN", direction: IN, properties: "GqlMutRole")
  }
  type GqlMutPerson @node {
    name: String!
    movies: [GqlMutMovie!]!
      @relationship(type: "ACTED_IN", direction: OUT, properties: "GqlMutRole")
  }
  type GqlMutRole @relationshipProperties {
    role: String
    since: DateTime @timestamp(operations: [CREATE])
  }
`;

const SEED = `
CREATE (m:GqlMutMovie {id: "m1", title: "The Matrix", released: 1999, genres: ["Sci-Fi"]})
CREATE (r:GqlMutMovie {id: "m2", title: "Reloaded"})
CREATE (k:GqlMutPerson {name: "Keanu"})
CREATE (c:GqlMutPerson {name: "Carrie"})
CREATE (l:GqlMutPerson {name: "Laurence"})
CREATE (k)-[:ACTED_IN {role: "Neo"}]->(m)
CREATE (c)-[:ACTED_IN {role: "Trinity"}]->(m)
CREATE (l)-[:ACTED_IN {role: "Morpheus"}]->(m)
CREATE (k)-[:ACTED_IN {role: "Neo"}]->(r)
`;

describe.skipIf(!hasNeo)("v7 mutations on Neo4j", () => {
  let driver: Driver;
  let schema: GraphQLSchema;

  const cypher = async (statement: string, params: Record<string, unknown> = {}) => {
    const session = driver.session();
    try {
      return (await session.run(statement, params)).records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  };
  const totals = async () => {
    const [row] = await cypher(
      `RETURN COUNT { MATCH (n) WHERE n:GqlMutMovie OR n:GqlMutPerson } AS nodes,
              COUNT { MATCH (n)-[r]->() WHERE n:GqlMutMovie OR n:GqlMutPerson } AS rels`,
    );
    return { nodes: Number(row!.nodes), rels: Number(row!.rels) };
  };
  const run = async (document: string, s = schema) => {
    const result = await execute({ schema: s, document: parse(document) });
    return result;
  };

  beforeAll(() => {
    driver = neo4j.driver(env.uri!, neo4j.auth.basic(env.user!, env.password!));
    schema = compat.v7.makeSchema({ typeDefs, driver });
  });
  afterAll(async () => {
    await cypher("MATCH (n) WHERE n:GqlMutMovie OR n:GqlMutPerson DETACH DELETE n");
    await driver.close();
  });
  beforeEach(async () => {
    await cypher("MATCH (n) WHERE n:GqlMutMovie OR n:GqlMutPerson DETACH DELETE n");
    await cypher(SEED);
  });

  it("create: nested create and connect, generated values, counters match the database", async () => {
    const before = await totals();
    const result = await run(`mutation {
      createGqlMutMovies(input: [
        { title: "John Wick", actors: {
            create: [{ node: { name: "Ian" }, edge: { role: "Winston" } }]
            connect: [{ where: { node: { name: { eq: "Keanu" } } }, edge: { role: "John" } }]
        } }
        { title: "Speed", released: 1994 }
      ]) {
        info { nodesCreated relationshipsCreated }
        gqlMutMovies { id title released actorsConnection { edges { properties { role since } node { name } } } }
      }
    }`);
    expect(result.errors).toBeUndefined();
    const data = result.data!.createGqlMutMovies as {
      info: { nodesCreated: number; relationshipsCreated: number };
      gqlMutMovies: {
        id: string;
        title: string;
        actorsConnection: { edges: { properties: { role: string; since: string | null } }[] };
      }[];
    };
    expect(data.info).toEqual({ nodesCreated: 3, relationshipsCreated: 2 });
    const after = await totals();
    expect(after.nodes - before.nodes).toBe(3);
    expect(after.rels - before.rels).toBe(2);
    expect(data.gqlMutMovies.map((m) => m.title)).toEqual(["John Wick", "Speed"]);
    expect(data.gqlMutMovies[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    const edges = data.gqlMutMovies[0]!.actorsConnection.edges;
    const byRole = Object.fromEntries(edges.map((e) => [e.properties.role, e.properties.since]));
    // @timestamp edge properties are set by nested create, not by connect (like v7).
    expect(byRole.Winston).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(byRole.John).toBeNull();
  });

  it("update: scalar operators and every nested operation in one statement, counters match", async () => {
    const before = await totals();
    const result = await run(`mutation {
      updateGqlMutMovies(where: { id: { eq: "m1" } }, update: {
        released: { add: 1 }
        genres_PUSH: ["Action"]
        actors: [
          { update: { where: { node: { name: { eq: "Keanu" } } }, edge: { role: { set: "The One" } } } }
          { disconnect: [{ where: { node: { name: { eq: "Laurence" } } } }] }
          { create: [{ node: { name: "Hugo" }, edge: { role: "Smith" } }] }
          { delete: [{ where: { node: { name: { eq: "Carrie" } } } }] }
        ]
      }) {
        info { nodesCreated nodesDeleted relationshipsCreated relationshipsDeleted }
        gqlMutMovies { released genres updatedAt actors { name } }
      }
    }`);
    expect(result.errors).toBeUndefined();
    const data = result.data!.updateGqlMutMovies as {
      info: Record<string, number>;
      gqlMutMovies: {
        released: number;
        genres: string[];
        updatedAt: string;
        actors: { name: string }[];
      }[];
    };
    expect(data.info).toEqual({
      nodesCreated: 1,
      nodesDeleted: 1,
      relationshipsCreated: 1,
      relationshipsDeleted: 2,
    });
    const after = await totals();
    expect(after.nodes - before.nodes).toBe(1 - 1);
    expect(after.rels - before.rels).toBe(1 - 2);
    const [movie] = data.gqlMutMovies;
    expect(movie!.released).toBe(2000);
    expect(movie!.genres).toEqual(["Sci-Fi", "Action"]);
    expect(movie!.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(movie!.actors.map((a) => a.name).sort()).toEqual(["Hugo", "Keanu"]);
    const [keanu] = await cypher(
      "MATCH (:GqlMutPerson {name: 'Keanu'})-[r:ACTED_IN]->(:GqlMutMovie {id: 'm1'}) RETURN r.role AS role",
    );
    expect(keanu!.role).toBe("The One");
  });

  it("delete: nested delete, distinct nodes and relationships are counted", async () => {
    const before = await totals();
    const result = await run(`mutation {
      deleteGqlMutMovies(where: { id: { eq: "m1" } }, delete: { actors: [{ where: { node: { name: { eq: "Keanu" } } } }] }) {
        nodesDeleted
        relationshipsDeleted
      }
    }`);
    expect(result.errors).toBeUndefined();
    // The Matrix and Keanu; the 3 ACTED_IN of The Matrix and Keanu's other one.
    expect(result.data!.deleteGqlMutMovies).toEqual({ nodesDeleted: 2, relationshipsDeleted: 4 });
    const after = await totals();
    expect(before.nodes - after.nodes).toBe(2);
    expect(before.rels - after.rels).toBe(4);
  });

  it("a failed check rolls the whole mutation back", async () => {
    const before = await cypher(
      "MATCH (n:GqlMutMovie) RETURN n.title AS t, n.released AS r ORDER BY t",
    );
    const result = await run(`mutation {
      updateGqlMutMovies(update: { released: { add: 1 }, title: { set: "changed" } }) {
        info { nodesCreated }
      }
    }`);
    // "Reloaded" has no `released`: v7 refuses to add to a missing value.
    expect(result.errors?.[0]?.message).toBe("Cannot add 1 to Nan");
    const after = await cypher(
      "MATCH (n:GqlMutMovie) RETURN n.title AS t, n.released AS r ORDER BY t",
    );
    expect(after).toEqual(before);
  });

  it("concurrent connect of the same pair: one relationship per mutation, like v7", async () => {
    // v7's connect is a CREATE (not a MERGE): connecting an already connected pair adds another
    // relationship, sequentially or concurrently. Each mutation runs in its own transaction and
    // reports exactly the relationship it created; none is lost or merged.
    const n = 12;
    const results = await Promise.all(
      Array.from({ length: n }, () =>
        run(`mutation {
          updateGqlMutMovies(where: { id: { eq: "m2" } }, update: {
            actors: [{ connect: [{ where: { node: { name: { eq: "Carrie" } } } }] }]
          }) { info { relationshipsCreated } }
        }`),
      ),
    );
    for (const r of results) {
      expect(r.errors).toBeUndefined();
      expect(r.data!.updateGqlMutMovies).toEqual({ info: { relationshipsCreated: 1 } });
    }
    const [row] = await cypher(
      "RETURN COUNT { (:GqlMutPerson {name: 'Carrie'})-[:ACTED_IN]->(:GqlMutMovie {id: 'm2'}) } AS c",
    );
    expect(Number(row!.c)).toBe(n);
  });

  it("runs on a CyphraClient too (write transaction)", async () => {
    const client = new CyphraClient({ driver });
    const viaClient = compat.v7.makeSchema({ typeDefs, client });
    const result = await run(
      `mutation { createGqlMutPeople(input: [{ name: "Ann" }]) { info { nodesCreated } gqlMutPeople { name } } }`,
      viaClient,
    );
    expect(result.errors).toBeUndefined();
    expect(result.data!.createGqlMutPeople).toEqual({
      info: { nodesCreated: 1 },
      gqlMutPeople: [{ name: "Ann" }],
    });
  });
});
