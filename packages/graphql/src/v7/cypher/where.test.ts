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
});

describe("where: aggregation filters", () => {
  const pattern = "(this)<-[r1:`ACTED_IN`]-(n0:`Person`)";

  it("connection form: count.nodes over distinct nodes, count.edges per relationship", () => {
    const { predicate, params } = compile({
      actorsConnection: { aggregate: { count: { nodes: { gte: 2 }, edges: { lt: 5 } } } },
    });
    expect(predicate).toBe(
      `(COUNT { MATCH ${pattern} WITH DISTINCT n0 RETURN n0 } >= $p0) AND (COUNT { MATCH ${pattern} } < $p1)`,
    );
    expect(params).toEqual({ p0: 2, p1: 5 });
  });

  it("node and edge aggregates reduce the collected values", () => {
    expect(
      compile({
        actorsConnection: {
          aggregate: {
            node: { born: { min: { lt: 1945 } } },
            edge: { screenTime: { sum: { gt: 200 } } },
          },
        },
      }).predicate,
    ).toBe(
      `([list2 IN [COLLECT { MATCH ${pattern} WITH DISTINCT n0 WITH n0 WHERE n0.\`born\` IS NOT NULL RETURN n0.\`born\` }] | reduce(acc = null, x IN list2 | CASE WHEN acc IS NULL OR x < acc THEN x ELSE acc END)][0] < $p0)` +
        ` AND ([list3 IN [COLLECT { MATCH ${pattern} WITH r1 WHERE r1.\`screenTime\` IS NOT NULL RETURN r1.\`screenTime\` }] | reduce(acc = 0, x IN list3 | acc + x)][0] > $p1)`,
    );
  });

  it("string aggregates compare lengths; AND / OR / NOT nest", () => {
    const { predicate } = compile({
      actorsConnection: {
        aggregate: {
          OR: [
            { node: { name: { shortestLength: { lt: 5 } } } },
            { NOT: { count: { nodes: { eq: 0 } } } },
          ],
        },
      },
    });
    expect(predicate).toContain("RETURN size(n0.`name`) }] | reduce(acc = null");
    expect(predicate).toMatch(/ OR \(NOT \(COUNT \{ MATCH .* \} = \$p1\)\)$/);
  });

  it("deprecated actorsAggregate: no DISTINCT, count filters and legacy keys", () => {
    const { predicate, params } = compile({
      actorsAggregate: {
        count: { gte: 1 },
        count_LT: 4,
        node: { name_AVERAGE_LENGTH_GT: 8.5 },
        edge: { screenTime_MAX_EQUAL: 120 },
      },
    });
    expect(predicate).toContain(
      `(COUNT { MATCH ${pattern} } >= $p0) AND (COUNT { MATCH ${pattern} } < $p1)`,
    );
    expect(predicate).not.toContain("DISTINCT");
    expect(predicate).toContain("toFloat(reduce(acc = 0, x IN list2 | acc + x)) / size(list2)");
    expect(params).toEqual({ p0: 1, p1: 4, p2: 8.5, p3: 120 });
  });

  it("DateTime aggregate values go through datetime()", () => {
    const ctx = new CypherContext();
    const predicate = new WhereCompiler(model, ctx).node("this", model.node("Person"), {
      moviesConnection: {
        aggregate: { node: { published: { max: { gt: "2020-01-01T00:00:00Z" } } } },
      },
    });
    expect(predicate).toMatch(/\]\[0\] > datetime\(\$p0\)$/);
  });
});
