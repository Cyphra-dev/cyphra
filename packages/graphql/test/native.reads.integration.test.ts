/**
 * Aggregates, groupBy, full-text search, findSimilar and union search of the native API against a
 * real Neo4j, under rules: a node the read rules hide is never counted, grouped or returned, and a
 * field a rule hides is not aggregated (#246).
 *
 * Needs NEO4J_TEST_URI / NEO4J_TEST_USER / NEO4J_TEST_PASSWORD; only nodes with `Nr*` labels (and
 * the `nr*` indexes) are touched.
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

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const source = /* cyphra */ `
union NrHit = NrDoc | NrPerson

node NrPerson {
  id     String  @id
  name   String
  salary Int?
  docs   NrDoc[] @relationship(type: "NR_WROTE", direction: OUT)

  @@fulltext([name], name: "nrPersonName", eventuallyConsistent: false)
}

node NrDoc {
  id        String     @id
  title     String
  status    String
  views     Int
  hidden    Boolean    @default(false)
  owner     String?
  embedding Vector(2)? @vectorIndex(similarity: cosine, name: "nrDocEmbedding", quantization: false)
  author    NrPerson?  @relationship(type: "NR_WROTE", direction: IN)

  @@fulltext([title], name: "nrDocTitle", eventuallyConsistent: false)
}
`;

const seed = `CREATE (ada:NrPerson {id: "pa", name: "Ada graph", salary: 10}),
  (bo:NrPerson {id: "pb", name: "Bo", salary: 20}),
  (d1:NrDoc {id: "d1", title: "graph one", status: "open", views: 1, hidden: false, owner: "pa", embedding: [1.0, 0.0]}),
  (d2:NrDoc {id: "d2", title: "graph two", status: "open", views: 2, hidden: false, owner: "pb", embedding: [0.0, 1.0]}),
  (d3:NrDoc {id: "d3", title: "graph graph graph hidden", status: "closed", views: 100, hidden: true, owner: "pa", embedding: [1.0, 0.01]}),
  (ada)-[:NR_WROTE]->(d1), (ada)-[:NR_WROTE]->(d3), (bo)-[:NR_WROTE]->(d2)`;

type Ctx = { user?: { id: string; admin?: boolean } };

const config = native.defineGraphQL<TypeMap, Ctx>({
  models: {
    NrPerson: { fields: { salary: { read: ({ ctx }) => ctx.user?.admin === true } } },
    NrDoc: {
      operations: { traverse: true },
      // Row-dependent: each user sees the owner of their own docs only.
      fields: { owner: { read: { where: ({ ctx }) => ({ owner: ctx.user?.id ?? "" }) } } },
      rules: { read: ({ ctx }) => (ctx.user?.admin ? true : { hidden: false }) },
    },
    NrHit: { operations: { traverse: true } },
  },
});

const anonymous: Ctx = {};
const admin: Ctx = { user: { id: "root", admin: true } };

describe.skipIf(!hasNeo)("native GraphQL API: aggregates and search (Neo4j)", () => {
  let driver: Driver;
  let schema: GraphQLSchema;
  const run = async (query: string, ctx: Ctx = anonymous) =>
    JSON.parse(JSON.stringify(await graphql({ schema, source: query, contextValue: { ...ctx } })));

  beforeAll(async () => {
    driver = neo4j.driver(env.uri!, neo4j.auth.basic(env.user!, env.password!));
    const db = createOrm<TypeMap>(resolveSchema(parseSchema(source)), { driver });
    schema = native.makeSchema({ client: db, config });
    await driver.executeQuery(
      "MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH 'Nr') DETACH DELETE n",
    );
    for (const name of ["nrPersonName", "nrDocTitle", "nrDocEmbedding"]) {
      await driver.executeQuery(`DROP INDEX ${name} IF EXISTS`);
    }
    await driver.executeQuery(
      "CREATE FULLTEXT INDEX nrPersonName FOR (n:NrPerson) ON EACH [n.name]",
    );
    await driver.executeQuery("CREATE FULLTEXT INDEX nrDocTitle FOR (n:NrDoc) ON EACH [n.title]");
    await driver.executeQuery(
      "CREATE VECTOR INDEX nrDocEmbedding FOR (n:NrDoc) ON n.embedding OPTIONS { indexConfig: { `vector.dimensions`: 2, `vector.similarity_function`: 'cosine' } }",
    );
    await driver.executeQuery("CALL db.awaitIndexes(60)");
    await driver.executeQuery(seed);
  });

  afterAll(async () => {
    await driver?.executeQuery(
      "MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH 'Nr') DETACH DELETE n",
    );
    for (const name of ["nrPersonName", "nrDocTitle", "nrDocEmbedding"]) {
      await driver?.executeQuery(`DROP INDEX ${name} IF EXISTS`);
    }
    await driver?.close();
  });

  it("aggregate: a node the read rules hide is not counted, summed or in the max", async () => {
    const q = `{ nrDocAggregate { _count { _all } _sum { views } _max { views status } } }`;
    expect((await run(q)).data.nrDocAggregate).toEqual({
      _count: { _all: 2 },
      _sum: { views: 3 },
      _max: { views: 2, status: "open" },
    });
    expect((await run(q, admin)).data.nrDocAggregate).toEqual({
      _count: { _all: 3 },
      _sum: { views: 103 },
      _max: { views: 100, status: "open" },
    });
  });

  it("aggregate: a row-dependent field rule hides the field on the rows outside it", async () => {
    const q = `{ nrDocAggregate { _count { owner } _min { owner } } }`;
    expect((await run(q, { user: { id: "pb" } })).data.nrDocAggregate).toEqual({
      _count: { owner: 1 },
      _min: { owner: "pb" },
    });
  });

  it("groupBy: hidden nodes are in no group, also through a relation key", async () => {
    const q = `{
      byStatus: nrDocGroupBy(by: { fields: [status] }, orderBy: [{ status: asc }]) {
        status _count { _all }
      }
      byAuthor: nrDocGroupBy(by: { author: [name] }, orderBy: [{ author: { name: asc } }]) {
        author { name } _sum { views }
      }
    }`;
    expect((await run(q)).data).toEqual({
      byStatus: [{ status: "open", _count: { _all: 2 } }],
      byAuthor: [
        { author: { name: "Ada graph" }, _sum: { views: 1 } },
        { author: { name: "Bo" }, _sum: { views: 2 } },
      ],
    });
    const all = await run(q, admin);
    expect(all.data.byStatus).toEqual([
      { status: "closed", _count: { _all: 1 } },
      { status: "open", _count: { _all: 2 } },
    ]);
    expect(all.data.byAuthor[0]).toEqual({ author: { name: "Ada graph" }, _sum: { views: 101 } });
  });

  it("groupBy: having on an aggregate, and a context-denied field is FORBIDDEN", async () => {
    const res = await run(`{
      nrDocGroupBy(by: { fields: [status] }, having: { views: { _sum: { gt: 50 } } }) { status }
      nrPersonAggregate { _sum { salary } }
    }`);
    expect(res.data.nrDocGroupBy).toEqual([]);
    expect(res.data.nrPersonAggregate).toBeNull();
    expect(res.errors.map((e: { extensions: { code: string } }) => e.extensions.code)).toEqual([
      "FORBIDDEN",
    ]);
    const all = await run(`{ nrPersonAggregate { _sum { salary } } }`, admin);
    expect(all.data.nrPersonAggregate).toEqual({ _sum: { salary: 30 } });
  });

  it("search: a hidden node is not a hit", async () => {
    const q = `{ nrDocSearch(index: nrDocTitle, query: "graph", mode: terms) { id } }`;
    expect((await run(q)).data.nrDocSearch.map((d: { id: string }) => d.id).sort()).toEqual([
      "d1",
      "d2",
    ]);
    expect((await run(q, admin)).data.nrDocSearch[0]).toEqual({ id: "d3" });
  });

  it("findSimilar: a hidden node is not a neighbour, and _score is the similarity", async () => {
    const q = `{ nrDocFindSimilar(field: embedding, vector: [1.0, 0.0], k: 1) { id _score } }`;
    const res = await run(q);
    expect(res.data.nrDocFindSimilar).toHaveLength(1);
    expect(res.data.nrDocFindSimilar[0].id).toBe("d1");
    expect(res.data.nrDocFindSimilar[0]._score).toBeCloseTo(1, 5);
    const all = await run(
      `{ nrDocFindSimilar(field: embedding, vector: [1.0, 0.02], k: 1) { id } }`,
      admin,
    );
    expect(all.data.nrDocFindSimilar).toEqual([{ id: "d3" }]);
  });

  it("union search and findSimilar: hidden members' nodes are not hits", async () => {
    const res = await run(`{
      nrHitSearch(query: "graph", mode: terms) {
        __typename
        ... on NrDoc { id _scores { index rank } }
        ... on NrPerson { id _score }
      }
      nrHitFindSimilar(vector: [1.0, 0.02], take: 5) { ... on NrDoc { id } }
    }`);
    const ids = res.data.nrHitSearch.map((h: { id: string }) => h.id);
    expect(ids).toContain("pa");
    expect(ids).not.toContain("d3");
    expect(ids.sort()).toEqual(["d1", "d2", "pa"]);
    const doc = res.data.nrHitSearch.find((h: { id: string }) => h.id === "d1");
    expect(doc._scores).toEqual([{ index: "nrDocTitle", rank: expect.any(Number) }]);
    expect(res.data.nrHitFindSimilar.map((h: { id: string }) => h.id)).not.toContain("d3");
  });
});
