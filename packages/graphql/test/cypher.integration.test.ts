/**
 * `@cypher` fields and `@fulltext` queries against a real Neo4j (5.23+): aggregating statements at
 * every nesting level (Neo4j rejects them inside subquery expressions of projections, so they must
 * run as `CALL` clauses), arguments that try to inject Cypher, `$jwt`, root `Query` / `Mutation`
 * fields and full-text indexes.
 *
 * Needs NEO4J_TEST_URI / NEO4J_TEST_USER / NEO4J_TEST_PASSWORD; only nodes with the `GqlCy*`
 * labels and the `gqlcy_title` index used here are touched.
 */
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
  type GqlCyMovie
    @node
    @fulltext(
      indexes: [{ indexName: "gqlcy_title", queryName: "searchGqlCyMovies", fields: ["title"] }]
    ) {
    title: String!
    secret: String
    actorCount: Int!
      @cypher(
        statement: "MATCH (this)<-[:GQLCY_ACTED_IN]-(a:GqlCyPerson) RETURN count(a) AS n"
        columnName: "n"
      )
    titleWith(suffix: String): String
      @cypher(statement: "RETURN this.title + coalesce($suffix, '') AS t", columnName: "t")
    viewer: String @cypher(statement: "RETURN $jwt.sub AS s", columnName: "s")
    cast: [GqlCyPerson!]!
      @relationship(type: "GQLCY_ACTED_IN", direction: IN, properties: "GqlCyActedIn")
    actors: [GqlCyPerson!]!
      @cypher(
        statement: "MATCH (this)<-[:GQLCY_ACTED_IN]-(p:GqlCyPerson) RETURN p"
        columnName: "p"
      )
  }

  type GqlCyPerson @node {
    name: String!
    movieCount: Int!
      @cypher(
        statement: "MATCH (this)-[:GQLCY_ACTED_IN]->(m:GqlCyMovie) RETURN count(m) AS n"
        columnName: "n"
      )
    movies: [GqlCyMovie!]!
      @relationship(type: "GQLCY_ACTED_IN", direction: OUT, properties: "GqlCyActedIn")
  }

  type GqlCyActedIn @relationshipProperties {
    role: String
    roleLength: Int @cypher(statement: "RETURN size(this.role) AS n", columnName: "n")
  }

  type Query {
    gqlCyTitles(prefix: String!): [String!]!
      @cypher(
        statement: "MATCH (m:GqlCyMovie) WHERE m.title STARTS WITH $prefix RETURN m.title AS t ORDER BY t"
        columnName: "t"
      )
  }

  type Mutation {
    gqlCyRename(from: String!, to: String!): GqlCyMovie
      @cypher(
        statement: "MATCH (m:GqlCyMovie {title: $from}) SET m.title = $to RETURN m"
        columnName: "m"
      )
  }
`;

const SEED = `
CREATE (m1:GqlCyMovie {title: "The Matrix", secret: "S1"}),
  (m2:GqlCyMovie {title: "Speed", secret: "S2"}),
  (k:GqlCyPerson {name: "Keanu"}), (c:GqlCyPerson {name: "Carrie"}),
  (k)-[:GQLCY_ACTED_IN {role: "Neo"}]->(m1), (c)-[:GQLCY_ACTED_IN {role: "Trinity"}]->(m1),
  (k)-[:GQLCY_ACTED_IN {role: "Jack"}]->(m2)
`;

describe.skipIf(!hasNeo)("@cypher and @fulltext on Neo4j", () => {
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
  const run = async (
    document: string,
    contextValue: Record<string, unknown> = {},
    variableValues?: Record<string, unknown>,
  ) => execute({ schema, document: parse(document), contextValue, variableValues });
  const titles = async () =>
    (await cypher("MATCH (m:GqlCyMovie) RETURN m.title AS t ORDER BY t")).map((r) => r.t);

  beforeAll(async () => {
    driver = neo4j.driver(env.uri!, neo4j.auth.basic(env.user!, env.password!));
    schema = compat.v7.makeSchema({ typeDefs, driver });
    await cypher(
      "CREATE FULLTEXT INDEX gqlcy_title IF NOT EXISTS FOR (n:GqlCyMovie) ON EACH [n.title]",
    );
  });
  afterAll(async () => {
    await cypher("MATCH (n) WHERE n:GqlCyMovie OR n:GqlCyPerson DETACH DELETE n");
    await cypher("DROP INDEX gqlcy_title IF EXISTS");
    await driver.close();
  });
  beforeEach(async () => {
    await cypher("MATCH (n) WHERE n:GqlCyMovie OR n:GqlCyPerson DETACH DELETE n");
    await cypher(SEED);
    await cypher("CALL db.awaitIndexes()");
  });

  it("aggregating statements work at every level (projection, sort, filter, connections)", async () => {
    const result = await run(`{
      gqlCyMovies(where: { actorCount: { gt: 0 } }, sort: [{ actorCount: DESC }]) {
        title
        actorCount
        cast(where: { movieCount: { gte: 1 } }, sort: [{ movieCount: DESC }, { name: ASC }]) {
          name
          movieCount
        }
        castConnection(sort: [{ edge: { roleLength: ASC } }], where: { node: { movieCount: { gt: 0 } } }) {
          totalCount
          aggregate { count { nodes } node { name { longest } } }
          edges { properties { role roleLength } node { name movieCount } }
        }
        actors { name movieCount }
      }
    }`);
    expect(result.errors).toBeUndefined();
    const movies = result.data!.gqlCyMovies as Record<string, unknown>[];
    expect(movies.map((m) => [m.title, m.actorCount])).toEqual([
      ["The Matrix", 2],
      ["Speed", 1],
    ]);
    expect(movies[0]!.cast).toEqual([
      { name: "Keanu", movieCount: 2 },
      { name: "Carrie", movieCount: 1 },
    ]);
    expect(movies[0]!.castConnection).toEqual({
      totalCount: 2,
      aggregate: { count: { nodes: 2 }, node: { name: { longest: "Carrie" } } },
      edges: [
        { properties: { role: "Neo", roleLength: 3 }, node: { name: "Keanu", movieCount: 2 } },
        { properties: { role: "Trinity", roleLength: 7 }, node: { name: "Carrie", movieCount: 1 } },
      ],
    });
    expect((movies[0]!.actors as { name: string }[]).map((a) => a.name).sort()).toEqual([
      "Carrie",
      "Keanu",
    ]);
  });

  it("filters through @cypher node fields, with nested @cypher filters", async () => {
    const result = await run(`{
      some: gqlCyMovies(where: { actors: { some: { movieCount: { gt: 1 } } } }) { title }
      all: gqlCyMovies(where: { actors: { all: { movieCount: { gt: 1 } } } }) { title }
    }`);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      some: expect.arrayContaining([{ title: "The Matrix" }, { title: "Speed" }]),
      all: [{ title: "Speed" }],
    });
  });

  it("arguments trying to inject Cypher stay parameters", async () => {
    const attacks = [
      `' OR true RETURN 'x' AS t //`,
      `") RETURN 1 AS t UNION MATCH (n) DETACH DELETE n RETURN 1 AS t //`,
      "$prefix",
      "x` RETURN 1 //",
    ];
    for (const prefix of attacks) {
      const q = await run(`query ($p: String!) { gqlCyTitles(prefix: $p) }`, {}, { p: prefix });
      expect(q.errors).toBeUndefined();
      expect(q.data).toEqual({ gqlCyTitles: [] });
      const f = await run(
        `query ($s: String) { gqlCyMovies(where: { title: { eq: "Speed" } }) { titleWith(suffix: $s) } }`,
        {},
        { s: `' + this.secret + '` },
      );
      expect(f.data).toEqual({ gqlCyMovies: [{ titleWith: "Speed' + this.secret + '" }] });
    }
    expect(await titles()).toEqual(["Speed", "The Matrix"]);
  });

  it("$jwt is the request's JWT (an empty map without one)", async () => {
    const anon = await run(`{ gqlCyMovies(where: { title: { eq: "Speed" } }) { viewer } }`);
    expect(anon.data).toEqual({ gqlCyMovies: [{ viewer: null }] });
    const authed = await run(`{ gqlCyMovies(where: { viewer: { eq: "ann" } }) { title viewer } }`, {
      jwt: { sub: "ann" },
    });
    expect((authed.data!.gqlCyMovies as unknown[]).length).toBe(2);
  });

  it("root Query and Mutation fields", async () => {
    const q = await run(`{ gqlCyTitles(prefix: "S") }`);
    expect(q.data).toEqual({ gqlCyTitles: ["Speed"] });
    const m = await run(
      `mutation { gqlCyRename(from: "Speed", to: "Speed 2") { title actorCount } }`,
    );
    expect(m.errors).toBeUndefined();
    expect(m.data).toEqual({ gqlCyRename: { title: "Speed 2", actorCount: 1 } });
    expect(await titles()).toEqual(["Speed 2", "The Matrix"]);
    const none = await run(`mutation { gqlCyRename(from: "Nope", to: "X") { title } }`);
    expect(none.data).toEqual({ gqlCyRename: null });
  });

  it("mutation responses select @cypher fields", async () => {
    const result = await run(`mutation {
      updateGqlCyMovies(where: { actorCount: { eq: 1 } }, update: { title: { set: "Speed!" } }) {
        gqlCyMovies { title actorCount cast { name movieCount } }
      }
    }`);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      updateGqlCyMovies: {
        gqlCyMovies: [{ title: "Speed!", actorCount: 1, cast: [{ name: "Keanu", movieCount: 2 }] }],
      },
    });
  });

  it("full-text queries: score, where, sort and pagination", async () => {
    const result = await run(`{
      searchGqlCyMovies(phrase: "matrix OR speed", where: { node: { actorCount: { gt: 0 } } }, sort: [{ node: { title: ASC } }], first: 1) {
        totalCount
        pageInfo { hasNextPage endCursor }
        edges { cursor score node { title actorCount } }
      }
    }`);
    expect(result.errors).toBeUndefined();
    const conn = result.data!.searchGqlCyMovies as {
      totalCount: number;
      pageInfo: { hasNextPage: boolean };
      edges: { score: number; node: unknown }[];
    };
    expect(conn.totalCount).toBe(2);
    expect(conn.pageInfo.hasNextPage).toBe(true);
    expect(conn.edges).toHaveLength(1);
    expect(conn.edges[0]!.node).toEqual({ title: "Speed", actorCount: 1 });
    expect(conn.edges[0]!.score).toBeGreaterThan(0);
    const phrase = await run(
      `query ($q: String!) { searchGqlCyMovies(phrase: $q) { totalCount } }`,
      {},
      {
        q: "title:matrix",
      },
    );
    expect(phrase.data).toEqual({ searchGqlCyMovies: { totalCount: 1 } });
  });
});
