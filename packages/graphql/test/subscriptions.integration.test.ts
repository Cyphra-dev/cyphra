/**
 * Subscriptions on Neo4j Change Data Capture: events of mutations run through `@cyphra/graphql`
 * (driver and CyphraClient), `onlyGraphQLEvents`, and the error on a database without CDC.
 *
 * Needs Neo4j Enterprise with CDC enabled on the default database
 * (`ALTER DATABASE neo4j SET OPTION txLogEnrichment 'FULL'`): NEO4J_TEST_URI / NEO4J_TEST_USER /
 * NEO4J_TEST_PASSWORD and NEO4J_TEST_CDC=1. Only nodes with the `SubsInt*` labels are touched; a
 * `cyphrasubsnocdc` database (no CDC) is created for the error test.
 */
import { CyphraClient } from "@cyphra/runtime";
import { execute, parse, subscribe, type ExecutionResult, type GraphQLSchema } from "graphql";
import neo4j, { type Driver } from "neo4j-driver";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CDCSubscriptionsEngine, compat } from "../src/index.js";

const env = {
  uri: process.env.NEO4J_TEST_URI,
  user: process.env.NEO4J_TEST_USER,
  password: process.env.NEO4J_TEST_PASSWORD,
};
const hasCdc = Boolean(env.uri && env.user && env.password && process.env.NEO4J_TEST_CDC === "1");

const typeDefs = /* GraphQL */ `
  type SubsIntMovie @node @subscription {
    id: ID! @id
    title: String!
    released: Int
  }
`;

async function nextEvents(
  iterator: AsyncIterator<ExecutionResult>,
  count: number,
  timeoutMs = 10_000,
): Promise<unknown[]> {
  const out: unknown[] = [];
  const deadline = Date.now() + timeoutMs;
  while (out.length < count) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`timed out after ${out.length} of ${count} events`);
    const r = await Promise.race([
      iterator.next(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), left)),
    ]);
    if (r === "timeout") throw new Error(`timed out after ${out.length} of ${count} events`);
    if (r.done) break;
    out.push(r.value.data);
  }
  return out;
}

async function open(schema: GraphQLSchema, document: string) {
  const result = await subscribe({ schema, document: parse(document), contextValue: {} });
  if (!(Symbol.asyncIterator in result)) {
    throw new Error(`subscribe failed: ${JSON.stringify((result as ExecutionResult).errors)}`);
  }
  return result[Symbol.asyncIterator]() as AsyncIterator<ExecutionResult>;
}

async function gql(schema: GraphQLSchema, document: string) {
  const r = await execute({ schema, document: parse(document), contextValue: {} });
  expect(r.errors).toBeUndefined();
  return r.data;
}

describe.skipIf(!hasCdc)("subscriptions on Neo4j CDC", () => {
  let driver: Driver;

  beforeAll(() => {
    driver = neo4j.driver(env.uri!, neo4j.auth.basic(env.user!, env.password!));
  });
  afterAll(async () => {
    await driver?.close();
  });
  beforeEach(async () => {
    await driver.executeQuery("MATCH (n:SubsIntMovie) DETACH DELETE n");
  });

  it("publishes the changes of GraphQL mutations (driver)", { timeout: 30_000 }, async () => {
    const engine = new CDCSubscriptionsEngine({ driver, pollTime: 50 });
    const schema = compat.v7.makeSchema({ typeDefs, driver, features: { subscriptions: engine } });
    try {
      const created = await open(
        schema,
        `subscription { subsIntMovieCreated(where: { released: { gt: 2000 } }) { event createdSubsIntMovie { title released } } }`,
      );
      const updated = await open(
        schema,
        `subscription { subsIntMovieUpdated { previousState { title } updatedSubsIntMovie { title } } }`,
      );
      const deleted = await open(
        schema,
        `subscription { subsIntMovieDeleted { deletedSubsIntMovie { title } } }`,
      );
      await gql(
        schema,
        `mutation { createSubsIntMovies(input: [{ title: "Old", released: 1990 }, { title: "New", released: 2020 }]) { info { nodesCreated } } }`,
      );
      await gql(
        schema,
        `mutation { updateSubsIntMovies(where: { title: { eq: "New" } }, update: { title: { set: "Newer" } }) { info { nodesCreated } } }`,
      );
      await gql(
        schema,
        `mutation { deleteSubsIntMovies(where: { title: { eq: "Old" } }) { nodesDeleted } }`,
      );
      expect(await nextEvents(created, 1)).toEqual([
        {
          subsIntMovieCreated: {
            event: "CREATE",
            createdSubsIntMovie: { title: "New", released: 2020 },
          },
        },
      ]);
      expect(await nextEvents(updated, 1)).toEqual([
        {
          subsIntMovieUpdated: {
            previousState: { title: "New" },
            updatedSubsIntMovie: { title: "Newer" },
          },
        },
      ]);
      expect(await nextEvents(deleted, 1)).toEqual([
        { subsIntMovieDeleted: { deletedSubsIntMovie: { title: "Old" } } },
      ]);
    } finally {
      engine.close();
    }
  });

  it("works through a CyphraClient", async () => {
    const client = new CyphraClient({ driver });
    const engine = new CDCSubscriptionsEngine({ client, pollTime: 50 });
    const schema = compat.v7.makeSchema({ typeDefs, client, features: { subscriptions: engine } });
    try {
      const created = await open(
        schema,
        `subscription { subsIntMovieCreated { createdSubsIntMovie { title } } }`,
      );
      await gql(
        schema,
        `mutation { createSubsIntMovies(input: [{ title: "Via client" }]) { info { nodesCreated } } }`,
      );
      expect(await nextEvents(created, 1)).toEqual([
        { subsIntMovieCreated: { createdSubsIntMovie: { title: "Via client" } } },
      ]);
    } finally {
      engine.close();
    }
  });

  it("onlyGraphQLEvents skips writes made outside @cyphra/graphql", async () => {
    const engine = new CDCSubscriptionsEngine({ driver, pollTime: 50, onlyGraphQLEvents: true });
    const schema = compat.v7.makeSchema({ typeDefs, driver, features: { subscriptions: engine } });
    try {
      const created = await open(
        schema,
        `subscription { subsIntMovieCreated { createdSubsIntMovie { title } } }`,
      );
      await driver.executeQuery(`CREATE (:SubsIntMovie {id: "x", title: "Raw Cypher"})`);
      await gql(
        schema,
        `mutation { createSubsIntMovies(input: [{ title: "GraphQL" }]) { info { nodesCreated } } }`,
      );
      expect(await nextEvents(created, 1)).toEqual([
        { subsIntMovieCreated: { createdSubsIntMovie: { title: "GraphQL" } } },
      ]);
    } finally {
      engine.close();
    }
  });

  it("fails with a clear error on a database without CDC", { timeout: 120_000 }, async () => {
    await driver.executeQuery(
      "CREATE DATABASE cyphrasubsnocdc IF NOT EXISTS WAIT",
      {},
      {
        database: "system",
      },
    );
    const engine = new CDCSubscriptionsEngine({
      driver,
      database: "cyphrasubsnocdc",
      pollTime: 50,
    });
    const schema = compat.v7.makeSchema({ typeDefs, driver, features: { subscriptions: engine } });
    const result = await subscribe({
      schema,
      document: parse(`subscription { subsIntMovieCreated { event } }`),
      contextValue: {},
    });
    expect(Symbol.asyncIterator in result).toBe(false);
    expect((result as ExecutionResult).errors?.[0]?.message).toMatch(
      /^GraphQL subscriptions need Neo4j Change Data Capture \(CDC\)/,
    );
    engine.close();
  });
});
