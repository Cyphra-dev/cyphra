import { describe, expect, it } from "vitest";
import { readTypeDefs } from "../model.js";
import { CypherContext } from "./context.js";
import { WhereCompiler } from "./where.js";

const model = readTypeDefs(/* GraphQL */ `
  type Movie @node {
    title: String!
    released: Int
    published: DateTime
    genres: [String!]!
    actors: [Person!]! @relationship(type: "ACTED_IN", direction: IN, properties: "ActedIn")
  }
  type Person @node {
    name: String!
    born: Int
    movies: [Movie!]! @relationship(type: "ACTED_IN", direction: OUT, properties: "ActedIn")
  }
  type ActedIn @relationshipProperties {
    screenTime: Int
  }
`);

function compile(where: unknown) {
  const ctx = new CypherContext();
  const predicate = new WhereCompiler(model, ctx).node("this", model.node("Movie"), where);
  return { predicate, params: ctx.params };
}

describe("where: scalars", () => {
  it("combines operators of one field and fields of one object with AND", () => {
    const { predicate, params } = compile({
      title: { startsWith: "The" },
      released: { gte: 1995, lt: 2000 },
    });
    expect(predicate).toBe(
      "(this.`title` STARTS WITH $p0) AND ((this.`released` >= $p1) AND (this.`released` < $p2))",
    );
    expect(params.p0).toBe("The");
    expect(String(params.p1)).toBe("1995");
  });

  it("eq: null matches a missing property", () => {
    expect(compile({ released: { eq: null } }).predicate).toBe("this.`released` IS NULL");
  });

  it("lists: eq compares the whole list, includes tests membership", () => {
    expect(compile({ genres: { includes: "Drama" } }).predicate).toBe("$p0 IN this.`genres`");
    expect(compile({ genres: { eq: ["Drama"] } }).predicate).toBe("this.`genres` = $p0");
  });

  it("DateTime values are compared as datetimes", () => {
    expect(compile({ published: { gt: "2024-01-01T00:00:00Z" } }).predicate).toBe(
      "this.`published` > datetime($p0)",
    );
    expect(compile({ published: { in: ["2024-01-01T00:00:00Z"] } }).predicate).toBe(
      "this.`published` IN [x IN $p0 | datetime(x)]",
    );
  });

  it("deprecated field_OPERATOR keys behave like the generic form", () => {
    expect(compile({ title_CONTAINS: "Matrix" }).predicate).toBe("this.`title` CONTAINS $p0");
    expect(compile({ released_IN: [1999] }).predicate).toBe("this.`released` IN $p0");
  });

  it("AND / OR / NOT nest", () => {
    expect(
      compile({ OR: [{ title: { eq: "A" } }, { NOT: { released: { gt: 2000 } } }] }).predicate,
    ).toBe("(this.`title` = $p0) OR (NOT (this.`released` > $p1))");
  });

  it("an empty object filters nothing", () => {
    expect(compile({}).predicate).toBeUndefined();
    expect(compile({ AND: [{}] }).predicate).toBeUndefined();
  });
});

describe("where: relationship quantifiers", () => {
  it("some / none / single use EXISTS and COUNT subqueries", () => {
    expect(compile({ actors: { some: { born: { gt: 1965 } } } }).predicate).toBe(
      "EXISTS { MATCH (this)<-[:`ACTED_IN`]-(n0:`Person`) WHERE n0.`born` > $p0 }",
    );
    expect(compile({ actors: { none: { name: { eq: "K" } } } }).predicate).toBe(
      "NOT EXISTS { MATCH (this)<-[:`ACTED_IN`]-(n0:`Person`) WHERE n0.`name` = $p0 }",
    );
    expect(compile({ actors: { single: { name: { eq: "K" } } } }).predicate).toBe(
      "COUNT { MATCH (this)<-[:`ACTED_IN`]-(n0:`Person`) WHERE n0.`name` = $p0 } = 1",
    );
  });

  it("all is not vacuously true: it needs at least one related node", () => {
    expect(compile({ actors: { all: { born: { lt: 1965 } } } }).predicate).toBe(
      "EXISTS { MATCH (this)<-[:`ACTED_IN`]-(n0:`Person`) } AND NOT EXISTS { MATCH (this)<-[:`ACTED_IN`]-(n0:`Person`) WHERE NOT (n0.`born` < $p0) }",
    );
  });

  it("{} inside some / none / single is ignored (matches every node)", () => {
    expect(compile({ actors: { some: {} } }).predicate).toBeUndefined();
    expect(compile({ actors: { none: {} } }).predicate).toBeUndefined();
    expect(compile({ actors: { single: {} } }).predicate).toBeUndefined();
  });

  it("deprecated rel_SOME and nested relationship filters", () => {
    expect(compile({ actors_SOME: { movies: { some: { title: { eq: "X" } } } } }).predicate).toBe(
      "EXISTS { MATCH (this)<-[:`ACTED_IN`]-(n0:`Person`) WHERE EXISTS { MATCH (n0)-[:`ACTED_IN`]->(n1:`Movie`) WHERE n1.`title` = $p0 } }",
    );
  });

  it("connection filters reach node and edge properties", () => {
    expect(
      compile({
        actorsConnection: {
          some: { node: { name: { eq: "K" } }, edge: { screenTime: { gte: 100 } } },
        },
      }).predicate,
    ).toBe(
      "EXISTS { MATCH (this)<-[r1:`ACTED_IN`]-(n0:`Person`) WHERE (n0.`name` = $p0) AND (r1.`screenTime` >= $p1) }",
    );
  });

  it("aggregation filters are not implemented yet (#72)", () => {
    expect(() => compile({ actorsAggregate: { count: { eq: 1 } } })).toThrow(/see #72/);
    expect(() =>
      compile({ actorsConnection: { aggregate: { count: { nodes: { eq: 1 } } } } }),
    ).toThrow(/see #72/);
  });
});
