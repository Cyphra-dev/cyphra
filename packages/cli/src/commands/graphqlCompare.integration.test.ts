import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import neo4j, { type Driver } from "neo4j-driver";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runGraphqlCompare } from "./graphqlCompare.js";

/**
 * `cyphra graphql compare` in-process against a live Neo4j: each v7 operation runs on
 * `compat.v7` and its translation on the native API, on the same data. Reads only (no `--reset`),
 * on labels with a random suffix, so the suite can share the database with other suites.
 */
const enabled = Boolean(
  process.env.NEO4J_TEST_URI &&
  process.env.NEO4J_TEST_USER &&
  process.env.NEO4J_TEST_PASSWORD &&
  process.env.CYPHRA_TEST_DIALECT !== "memgraph" &&
  process.env.CYPHRA_TEST_DIALECT !== "falkordb",
);

const S = Math.random().toString(36).slice(2, 8);
// The random part is in the middle: v7 pluralizes the type name.
const MOVIE = `Cmp${S}Movie`;
const PERSON = `Cmp${S}Person`;

const TYPEDEFS = `
type ${MOVIE} @node {
  id: ID! @id
  title: String!
  released: Int!
  actors: [${PERSON}!]! @relationship(type: "CMP_ACTED_IN", direction: IN, properties: "CmpActedIn${S}")
}
type ${PERSON} @node {
  id: ID! @id
  name: String!
  movies: [${MOVIE}!]! @relationship(type: "CMP_ACTED_IN", direction: OUT, properties: "CmpActedIn${S}")
}
type CmpActedIn${S} @relationshipProperties {
  role: String
}
`;

const plural = (s: string) => `${s.charAt(0).toLowerCase()}${s.slice(1)}s`;

describe.skipIf(!enabled)("cyphra graphql compare (Neo4j)", () => {
  let driver: Driver;
  let dir: string;
  let out: string[];

  beforeAll(async () => {
    driver = neo4j.driver(
      process.env.NEO4J_TEST_URI!,
      neo4j.auth.basic(process.env.NEO4J_TEST_USER!, process.env.NEO4J_TEST_PASSWORD!),
    );
    await driver.executeQuery(
      `CREATE (up:${MOVIE} {id: "m1", title: "Up", released: 2009}),
              (cars:${MOVIE} {id: "m2", title: "Cars", released: 2006}),
              (ed:${PERSON} {id: "p1", name: "Ed"}), (jo:${PERSON} {id: "p2", name: "Jo"}),
              (ed)-[:CMP_ACTED_IN {role: "Carl"}]->(up), (jo)-[:CMP_ACTED_IN {role: "Russell"}]->(up),
              (jo)-[:CMP_ACTED_IN {role: "Sally"}]->(cars)`,
    );
    dir = await mkdtemp(join(tmpdir(), "cyphra-graphql-compare-"));
    await writeFile(join(dir, "typeDefs.graphql"), TYPEDEFS);
    const movies = plural(MOVIE);
    await writeFile(
      join(dir, "01-list.graphql"),
      `query List { ${movies}(where: { released: { gt: 2000 } }, sort: [{ title: ASC }]) { title actors(sort: [{ name: ASC }]) { name } } }`,
    );
    await writeFile(
      join(dir, "02-connection.graphql"),
      `query Conn($first: Int) {
        ${movies}Connection(first: $first, sort: [{ released: DESC }]) {
          totalCount
          edges { node { title actorsConnection { totalCount edges { properties { role } node { name } } } } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
    );
    await writeFile(join(dir, "02-connection.variables.json"), JSON.stringify({ first: 1 }));
    await writeFile(
      join(dir, "03-filters.graphql"),
      `query Filters { a: ${movies}(where: { actors: { all: { name: { startsWith: "J" } } } }) { title }
        b: ${movies}(where: { actors: { single: { name: { eq: "Ed" } } } }) { title }
        c: ${movies}(where: { actorsAggregate: { count: { gte: 2 } } }) { title } }`,
    );
    await writeFile(
      join(dir, "04-edge.graphql"),
      `{ ${movies}(where: { actorsConnection: { some: { edge: { role: { eq: "Carl" } } } } }) { title } }`,
    );
    await writeFile(
      join(dir, "05-create.graphql"),
      `mutation { create${MOVIE}s(input: [{ title: "Coco", released: 2017 }]) { ${movies} { title } } }`,
    );
  });

  afterAll(async () => {
    await driver?.executeQuery(`MATCH (n) WHERE n:${MOVIE} OR n:${PERSON} DETACH DELETE n`);
    await driver?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("runs both APIs and finds the same results, cursors aside", async () => {
    out = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void out.push(String(m)));
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void out.push(String(m)));
    const saved = { ...process.env };
    process.env.NEO4J_URI = process.env.NEO4J_TEST_URI;
    process.env.NEO4J_USERNAME = process.env.NEO4J_TEST_USER;
    process.env.NEO4J_PASSWORD = process.env.NEO4J_TEST_PASSWORD;
    try {
      const code = await runGraphqlCompare(dir, ["0*.graphql"], {
        typedefs: ["typeDefs.graphql"],
        ordered: true,
      });
      const report = out.join("\n");
      expect(report).toMatch(/01-list\.graphql:1:1 +same +List/);
      expect(report).toMatch(/02-connection\.graphql:1:1 +same \(known differences\) +Conn/);
      expect(report).toMatch(
        /pageInfo\.endCursor: v7 \(not comparable\), native "[^"]+" \(known: v7 cursors are offsets/,
      );
      expect(report).toMatch(/03-filters\.graphql:1:1 +same +Filters/);
      expect(report).toMatch(
        /04-edge\.graphql:1:1 +not translated .*no filters on edge properties/,
      );
      expect(report).toMatch(/05-create\.graphql:1:1 +skipped .*--reset/);
      expect(report).toMatch(
        /5 operations: 3 same \(1 with known differences\), 0 differ, 1 not translated, 1 skipped\./,
      );
      expect(code).toBe(0);
    } finally {
      process.env = saved;
      vi.restoreAllMocks();
    }
  });
});
