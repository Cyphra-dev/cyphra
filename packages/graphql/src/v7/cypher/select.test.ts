import { execute, parse } from "graphql";
import { describe, expect, it } from "vitest";
import { fakeDriver } from "../../../test/helpers.js";
import { makeSchema } from "../index.js";
import { cursorToOffset, offsetToCursor } from "./select.js";

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
  it("list query: filter, sort, paging and nested relationship in one statement", async () => {
    const { driver, statements } = fakeDriver(() => [
      { title: "The Matrix", actors: [{ name: "Keanu" }] },
    ]);
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
      [
        "MATCH (this0:`Movie`)",
        "WHERE this0.`title` CONTAINS $p0",
        "WITH this0 ORDER BY this0.`released` DESC LIMIT $p1",
        "RETURN { `title`: this0.`title`, `actors`: COLLECT { MATCH (this0)<-[:`ACTED_IN`]-(this1:`Person`) WITH this1 ORDER BY this1.`name` ASC RETURN { `name`: this1.`name` } } } AS this",
      ].join("\n"),
    );
    expect(result.data).toEqual({
      movies: [{ title: "The Matrix", actors: [{ name: "Keanu" }] }],
      peopleConnection: { totalCount: 0 },
    });
  });

  it("connection: cursors, pageInfo and edge properties come from the offset and the total", async () => {
    const { driver, statements } = fakeDriver(() => [
      {
        total: 5,
        edges: [{ node: { n: "A" } }, { node: { n: "B" } }],
      },
    ]);
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
    expect(statements[0]!.cypher).toBe(
      "RETURN { total: COUNT { MATCH (this0:`Person`) }, edges: COLLECT { MATCH (this0:`Person`) WITH this0 ORDER BY this0.`name` ASC SKIP $p0 LIMIT $p1 RETURN { `node`: { `n`: this0.`name` } } } } AS this",
    );
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
    const schema = makeSchema({ typeDefs, driver });
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
      "`actorsConnection`: { total: COUNT { MATCH (this0)<-[edge2:`ACTED_IN`]-(this1:`Person`) WHERE edge2.`screenTime` > $p0 }",
    );
    expect(statements[0]!.cypher).toContain("ORDER BY edge2.`screenTime` DESC");
  });

  it("BigInt values are returned as strings", async () => {
    const neo4j = (await import("neo4j-driver")).default;
    const { driver } = fakeDriver(() => [{ budget: neo4j.int("9007199254740993") }]);
    const schema = makeSchema({ typeDefs, driver });
    const result = await execute({ schema, document: parse("{ people { budget } }") });
    expect(result.data).toEqual({ people: [{ budget: "9007199254740993" }] });
  });

  it("parts of the API that are not implemented yet answer with a clear error", async () => {
    const { driver, statements } = fakeDriver();
    const schema = makeSchema({ typeDefs, driver });
    const mutation = await execute({
      schema,
      document: parse(
        `mutation { createMovies(input: [{ title: "X" }]) { info { nodesCreated } } }`,
      ),
    });
    expect(mutation.errors?.[0]?.message).toMatch(
      /^Not implemented yet in @cyphra\/graphql \(see #73\)/,
    );
    const aggregate = await execute({
      schema,
      document: parse("{ moviesConnection { aggregate { count { nodes } } } }"),
    });
    expect(aggregate.errors?.[0]?.message).toMatch(/see #72/);
    expect(statements).toHaveLength(0);
  });
});
