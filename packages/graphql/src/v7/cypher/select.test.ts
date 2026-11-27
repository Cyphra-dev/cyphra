import { execute, parse } from "graphql";
import { describe, expect, it } from "vitest";
import { fakeDriver } from "../../../test/helpers.js";
import { makeSchema, type MakeSchemaOptions } from "../index.js";
import { cursorToOffset, offsetToCursor } from "./select.js";
import { ENGINE_OPTION } from "../engine/index.js";

/** Options with the shared engine off: these tests check the compiler's statements. */
const compiler = (o: MakeSchemaOptions): MakeSchemaOptions =>
  ({ ...o, [ENGINE_OPTION]: false }) as MakeSchemaOptions;

const typeDefs = /* GraphQL */ `
  type Movie @node {
    title: String!
    released: Int
    actors: [Person!]! @relationship(type: "ACTED_IN", direction: IN, properties: "ActedIn")
  }
  type Person @node {
    name: String!
    budget: BigInt
  }
  type ActedIn @relationshipProperties {
    screenTime: Int
  }
`;

describe("cursors", () => {
  it("are base64(arrayconnection:<offset>), like v7", () => {
    expect(offsetToCursor(0)).toBe("YXJyYXljb25uZWN0aW9uOjA=");
    expect(cursorToOffset("YXJyYXljb25uZWN0aW9uOjE=")).toBe(1);
  });

  it("an invalid cursor has no offset (first page)", () => {
    expect(cursorToOffset("not-a-cursor")).toBeUndefined();
    expect(cursorToOffset(Buffer.from("arrayconnection:x").toString("base64"))).toBeUndefined();
    expect(cursorToOffset(null)).toBeUndefined();
  });
});

describe("root fields compile to one statement each", () => {
  it("list query: filter, sort, paging and nested relationship in one engine statement", async () => {
    const { driver, statements } = fakeDriver((cypher) =>
      cypher.includes("count(n)")
        ? [{ c: 0 }]
        : [{ row: { title: "The Matrix", r0: [{ name: "Keanu" }] } }],
    );
    const schema = makeSchema({ typeDefs, driver });
    const result = await execute({
      schema,
      document: parse(`{
        movies(where: { title: { contains: "Matrix" } }, sort: [{ released: DESC }], limit: 1) {
          title
          actors(sort: [{ name: ASC }]) { name }
        }
        peopleConnection { totalCount }
      }`),
    });
    expect(result.errors).toBeUndefined();
    expect(statements).toHaveLength(2);
    expect(statements[0]!.cypher).toBe(
      "MATCH (n:`Movie`) WHERE n.`title` CONTAINS $p0 WITH n ORDER BY n.`released` DESC LIMIT $p1" +
        " RETURN n{.`title`, `r0`: COLLECT { MATCH (n)<-[r1:`ACTED_IN`]-(m0:`Person`) WITH m0, r1 ORDER BY m0.`name` ASC" +
        " RETURN m0{.`name`, `$edge`: properties(r1)} }} AS row ORDER BY n.`released` DESC",
    );
    expect(statements[1]!.cypher).toBe("MATCH (n:`Person`) RETURN count(n) AS c");
    expect(result.data).toEqual({
      movies: [{ title: "The Matrix", actors: [{ name: "Keanu" }] }],
      peopleConnection: { totalCount: 0 },
    });
  });

  it("connection: cursors, pageInfo and edge properties come from the offset and the total", async () => {
    const { driver, statements } = fakeDriver((cypher) =>
      cypher.includes("count(n)") ? [{ c: 5 }] : [{ row: { name: "A" } }, { row: { name: "B" } }],
    );
    const schema = makeSchema({ typeDefs, driver });
    const result = await execute({
      schema,
      document: parse(`{
        page: peopleConnection(first: 2, after: "YXJyYXljb25uZWN0aW9uOjA=", sort: [{ name: ASC }]) {
          totalCount
          edges { cursor node { n: name } }
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        }
      }`),
    });
    expect(result.errors).toBeUndefined();
    // The page and its total, in one read transaction (the after cursor is offset 0: skip 1).
    expect(statements.map((s) => [s.mode, s.cypher])).toEqual([
      [
        "read",
        "MATCH (n:`Person`) WITH n ORDER BY n.`name` ASC SKIP $p0 LIMIT $p1 RETURN n{.`name`} AS row ORDER BY n.`name` ASC",
      ],
      ["read", "MATCH (n:`Person`) RETURN count(n) AS c"],
    ]);
    expect(String(statements[0]!.params.p0)).toBe("1");
    expect(result.data).toEqual({
      page: {
        totalCount: 5,
        edges: [
          { cursor: offsetToCursor(1), node: { n: "A" } },
          { cursor: offsetToCursor(2), node: { n: "B" } },
        ],
        pageInfo: {
          hasNextPage: true,
          hasPreviousPage: true,
          startCursor: offsetToCursor(1),
          endCursor: offsetToCursor(2),
        },
      },
    });
  });

  it("nested connection with edge filter and sort stays in the same statement", async () => {
    const { driver, statements } = fakeDriver(() => []);
    const schema = makeSchema(compiler({ typeDefs, driver }));
    await execute({
      schema,
      document: parse(`{
        movies {
          actorsConnection(where: { edge: { screenTime: { gt: 0 } } }, sort: [{ edge: { screenTime: DESC } }]) {
            edges { properties { screenTime } node { name } }
          }
        }
      }`),
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]!.cypher).toContain(
      "`actorsConnection`: { edges: COLLECT { MATCH (this0)<-[edge2:`ACTED_IN`]-(this1:`Person`) WHERE edge2.`screenTime` > $p0 ",
    );
    expect(statements[0]!.cypher).toContain("ORDER BY edge2.`screenTime` DESC");
  });

  it("BigInt values are returned as strings", async () => {
    const neo4j = (await import("neo4j-driver")).default;
    const { driver } = fakeDriver(() => [{ row: { budget: neo4j.int("9007199254740993") } }]);
    const schema = makeSchema({ typeDefs, driver });
    const result = await execute({ schema, document: parse("{ people { budget } }") });
    expect(result.data).toEqual({ people: [{ budget: "9007199254740993" }] });
  });
});

describe("connection aggregate selections", () => {
  it("root aggregate: counts and field aggregates in the connection statement", async () => {
    const neo4j = (await import("neo4j-driver")).default;
    const { driver, statements } = fakeDriver(() => [
      {
        aggregate: {
          agg: {
            count: { n: neo4j.int(2) },
            node: {
              released: {
                min: neo4j.int(1999),
                avg: 2001,
                total: neo4j.int(4002),
              },
              title: { longest: "The Matrix Reloaded", shortest: "The Matrix" },
            },
          },
        },
      },
    ]);
    const schema = makeSchema({ typeDefs, driver });
    const result = await execute({
      schema,
      document: parse(`{
        moviesConnection(where: { title: { startsWith: "The" } }) {
          agg: aggregate {
            count { n: nodes }
            node {
              released { min avg: average total: sum }
              title { longest shortest }
            }
          }
        }
      }`),
    });
    expect(result.errors).toBeUndefined();
    expect(statements).toHaveLength(1);
    const base = "MATCH (this0:`Movie`) WHERE this0.`title` STARTS WITH $p0";
    expect(statements[0]!.cypher).toBe(
      "RETURN { aggregate: { `agg`: { " +
        `\`count\`: { \`n\`: COUNT { ${base} WITH DISTINCT this0 RETURN this0 } }, ` +
        "`node`: { " +
        `\`released\`: [list1 IN [COLLECT { ${base} WITH DISTINCT this0 WHERE this0.\`released\` IS NOT NULL RETURN this0.\`released\` }] | { ` +
        "`min`: reduce(acc = null, x IN list1 | CASE WHEN acc IS NULL OR x < acc THEN x ELSE acc END), " +
        "`avg`: CASE size(list1) WHEN 0 THEN null ELSE toFloat(reduce(acc = 0, x IN list1 | acc + x)) / size(list1) END, " +
        "`total`: reduce(acc = 0, x IN list1 | acc + x) }][0], " +
        `\`title\`: [list2 IN [COLLECT { ${base} WITH DISTINCT this0 WHERE this0.\`title\` IS NOT NULL WITH this0 ORDER BY size(this0.\`title\`) DESC RETURN this0.\`title\` }] | { ` +
        "`longest`: head(list2), `shortest`: last(list2) }][0] } } } } AS this",
    );
    expect(result.data).toEqual({
      moviesConnection: {
        agg: {
          count: { n: 2 },
          node: {
            released: { min: 1999, avg: 2001, total: 4002 },
            title: { longest: "The Matrix Reloaded", shortest: "The Matrix" },
          },
        },
      },
    });
  });

  it("nested aggregate: edges, edge properties, BigInt as strings, empty sets", async () => {
    const neo4j = (await import("neo4j-driver")).default;
    const { driver, statements } = fakeDriver(() => [
      {
        actorsConnection: {
          aggregate: {
            aggregate: {
              count: { nodes: neo4j.int(0), edges: neo4j.int(0) },
              node: { budget: { min: null, sum: neo4j.int(0), average: null } },
              edge: { screenTime: { max: null, sum: neo4j.int(0) } },
            },
          },
        },
      },
    ]);
    const schema = makeSchema({ typeDefs, driver });
    const result = await execute({
      schema,
      document: parse(`{
        movies {
          actorsConnection {
            aggregate {
              count { nodes edges }
              node { budget { min sum average } }
              edge { screenTime { max sum } }
            }
          }
        }
      }`),
    });
    expect(result.errors).toBeUndefined();
    expect(statements).toHaveLength(1);
    const cypher = statements[0]!.cypher;
    const pattern = "MATCH (this0)<-[edge2:`ACTED_IN`]-(this1:`Person`)";
    expect(cypher).toContain(`\`edges\`: COUNT { ${pattern} WITH DISTINCT edge2 RETURN edge2 }`);
    expect(cypher).toContain(
      `COLLECT { ${pattern} WITH DISTINCT edge2 WHERE edge2.\`screenTime\` IS NOT NULL RETURN edge2.\`screenTime\` }`,
    );
    expect(cypher).not.toContain("total:");
    expect(result.data).toEqual({
      movies: [
        {
          actorsConnection: {
            aggregate: {
              count: { nodes: 0, edges: 0 },
              node: { budget: { min: null, sum: "0", average: null } },
              edge: { screenTime: { max: null, sum: 0 } },
            },
          },
        },
      ],
    });
  });
});

describe("unions", () => {
  const unionTypeDefs = /* GraphQL */ `
    union Content = Movie | Book
    type User @node {
      name: String!
      favorites: [Content!]! @relationship(type: "FAVORITED", direction: OUT)
    }
    type Movie @node {
      title: String!
    }
    type Book @node {
      isbn: ID!
    }
  `;

  it("one UNION branch per member selected by where, rows typed by member", async () => {
    const { driver, statements } = fakeDriver(() => [
      {
        name: "ana",
        favorites: [{ "cyphra:type": "Movie", "cyphra:id": "4:x:1", t: "Arrival" }],
      },
    ]);
    const schema = makeSchema({ typeDefs: unionTypeDefs, driver });
    const result = await execute({
      schema,
      document: parse(`{
        users {
          name
          favorites(where: { Movie: { title: { eq: "Arrival" } } }, limit: 2) {
            __typename
            ... on Movie { t: title }
            ... on Book { isbn }
          }
        }
      }`),
    });
    expect(result.errors).toBeUndefined();
    const cypher = statements[0]!.cypher;
    expect(cypher).toContain("MATCH (this0)-[:`FAVORITED`]->(this2:`Movie`)");
    expect(cypher).not.toContain("`Book`");
    expect(cypher).toMatch(/ELSE rows\d+\[0\.\.\$p\d+\] END AS union\d+/);
    expect(result.data).toEqual({
      users: [{ name: "ana", favorites: [{ __typename: "Movie", t: "Arrival" }] }],
    });
  });

  it("a where without any member key matches nothing", async () => {
    const { driver, statements } = fakeDriver(() => [{ name: "ana" }]);
    const schema = makeSchema({ typeDefs: unionTypeDefs, driver });
    const result = await execute({
      schema,
      document: parse(`{ users { name favorites(where: { Movie: null }) { __typename } } }`),
    });
    expect(result.errors).toBeUndefined();
    expect(statements[0]!.cypher).not.toContain("UNION");
    expect(result.data).toEqual({ users: [{ name: "ana", favorites: [] }] });
  });

  it("root union query and relationship filters per member", async () => {
    const { driver, statements } = fakeDriver(() => [[{ "cyphra:type": "Book", isbn: "b-1" }]]);
    const schema = makeSchema({ typeDefs: unionTypeDefs, driver });
    const result = await execute({
      schema,
      document: parse(`{ contents { ... on Book { isbn } } }`),
    });
    expect(result.errors).toBeUndefined();
    expect(statements[0]!.cypher).toContain("\nUNION\n");
    expect(result.data).toEqual({ contents: [{ isbn: "b-1" }] });

    await execute({
      schema,
      document: parse(`{
        users(where: { favorites: { single: { Movie: { title: { eq: "Up" } }, Book: {} } } }) { name }
      }`),
    });
    // `single` on a member without conditions filters nothing (v7).
    expect(statements[1]!.cypher).toContain(
      "WHERE COUNT { MATCH (this0)-[:`FAVORITED`]->(n1:`Movie`) WHERE n1.`title` = $p0 } = 1",
    );
    expect(statements[1]!.cypher).not.toContain("`Book`");
  });
});
