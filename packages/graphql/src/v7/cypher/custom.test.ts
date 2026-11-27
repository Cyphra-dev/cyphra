import { execute, parse } from "graphql";
import neo4j from "neo4j-driver";
import { describe, expect, it } from "vitest";
import { fakeDriver } from "../../../test/helpers.js";
import { makeSchema, type MakeSchemaOptions } from "../index.js";
import { ENGINE_OPTION } from "../engine/index.js";
import { readTypeDefs, UnsupportedTypeDefsError } from "../model.js";
import { CypherContext } from "./context.js";
import { bindArguments, hasStatement, STATEMENT_MARK, statementCall } from "./custom.js";

/** Options with the shared engine off: these tests check the compiler's statements. */
const compiler = (o: MakeSchemaOptions): MakeSchemaOptions =>
  ({ ...o, [ENGINE_OPTION]: false }) as MakeSchemaOptions;

const typeDefs = /* GraphQL */ `
  type Movie
    @node
    @fulltext(
      indexes: [{ indexName: "MovieTitle", queryName: "moviesByTitle", fields: ["title"] }]
    ) {
    title: String!
    actorCount: Int!
      @cypher(
        statement: "MATCH (this)<-[:ACTED_IN]-(a:Person) RETURN count(a) AS n"
        columnName: "n"
      )
    label(suffix: String, times: Int = 1): String
      @cypher(statement: "RETURN this.title + $suffix + toString($times) AS l", columnName: "l")
    viewer: String @cypher(statement: "RETURN $jwt.sub AS s", columnName: "s")
    actors: [Person!]!
      @cypher(statement: "MATCH (this)<-[:ACTED_IN]-(p:Person) RETURN p", columnName: "p")
  }
  type Person @node {
    name: String!
  }
  type Query {
    titles(prefix: String!): [String!]!
      @cypher(
        statement: "MATCH (m:Movie) WHERE m.title STARTS WITH $prefix RETURN m.title AS t"
        columnName: "t"
      )
  }
  type Mutation {
    touch(title: String!): Movie
      @cypher(
        statement: "MATCH (m:Movie {title: $title}) SET m.touched = true RETURN m"
        columnName: "m"
      )
  }
`;

const argDefs = [
  {
    name: "suffix",
    type: { name: "String", list: false, required: false, elementRequired: false },
    kind: "scalar",
  },
  {
    name: "times",
    type: { name: "Int", list: false, required: false, elementRequired: false },
    kind: "scalar",
  },
] as const;

describe("@cypher statements", () => {
  it("arguments become parameters, never statement text (v7 replaceArgumentsInStatement)", () => {
    const ctx = new CypherContext();
    const attack = `"' + this.secret + '" }) DETACH DELETE n //`;
    const out = bindArguments(ctx, "RETURN $suffix + $suffix + $times + $suffixes AS l", argDefs, {
      suffix: attack,
      times: 2,
    });
    expect(out).toBe("RETURN $p0 + $p0 + $p1 + $suffixes AS l");
    expect(out).not.toContain("DELETE");
    expect(ctx.params.p0).toBe(attack);
    // Int arguments are sent as integers, like v7.
    expect(ctx.params.p1).toEqual(neo4j.int(2));
  });

  it("a missing or null argument is NULL", () => {
    const ctx = new CypherContext();
    expect(bindArguments(ctx, "RETURN $suffix AS a, $times AS b", argDefs, { times: null })).toBe(
      "RETURN NULL AS a, NULL AS b",
    );
    expect(ctx.params).toEqual({});
  });

  it("`this` is bound to the node and `$jwt` is the decoded JWT ({} without one)", () => {
    const ctx = new CypherContext();
    const call = statementCall(
      ctx,
      { statement: "RETURN $jwt.sub AS s", columnName: "s" },
      [],
      {},
      "this3",
    );
    expect(call).toBe(
      `CALL (this3) {\n  WITH this3 AS this\n  ${STATEMENT_MARK}\n  RETURN $jwt.sub AS s\n}`,
    );
    expect(ctx.params).toEqual({ jwt: {} });
    expect(hasStatement(call)).toBe(true);
    expect(hasStatement("COLLECT { MATCH (n) RETURN n }")).toBe(false);
  });
});

describe("@cypher fields in statements", () => {
  it("projections run the statement in a CALL clause before the RETURN", async () => {
    const { driver, statements } = fakeDriver(() => [{ title: "A", actorCount: neo4j.int(2) }]);
    const schema = makeSchema(compiler({ typeDefs, driver }));
    const result = await execute({ schema, document: parse("{ movies { title actorCount } }") });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ movies: [{ title: "A", actorCount: 2 }] });
    const cypher = statements[0]!.cypher;
    expect(cypher).toContain("CALL (this0) {\nCALL (this0) {\n  WITH this0 AS this\n");
    expect(cypher).toMatch(
      /RETURN `n` AS cypher\d+\n}\nRETURN \{ `title`: this0.`title`, `actorCount`: cypher\d+ \} AS this$/,
    );
  });

  it("aliases with different arguments get their own parameters", async () => {
    const { driver, statements } = fakeDriver(() => []);
    const schema = makeSchema(compiler({ typeDefs, driver }));
    await execute({
      schema,
      document: parse(`{ movies { a: label(suffix: "!") b: label(suffix: "?", times: 3) } }`),
    });
    const { cypher, params } = statements[0]!;
    expect(Object.values(params)).toEqual(
      expect.arrayContaining(["!", "?", neo4j.int(1), neo4j.int(3)]),
    );
    expect(cypher).not.toContain('"!"');
  });

  it("filters and sorts on @cypher fields (sorted value reused by the projection)", async () => {
    const { driver, statements } = fakeDriver(() => []);
    const schema = makeSchema(compiler({ typeDefs, driver }));
    await execute({
      schema,
      document: parse(
        "{ movies(where: { actorCount: { gt: 1 } }, sort: [{ actorCount: DESC }]) { actorCount } }",
      ),
    });
    const cypher = statements[0]!.cypher;
    expect(cypher).toMatch(/WHERE head\(COLLECT \{\nCALL \(this0\)/);
    const sortVar = /ORDER BY (cypher\d+) DESC/.exec(cypher)?.[1];
    expect(sortVar).toBeDefined();
    expect(cypher).toContain(`RETURN { \`actorCount\`: ${sortVar} } AS this`);
  });

  it("$jwt receives the request's JWT", async () => {
    const { driver, statements } = fakeDriver(() => []);
    const schema = makeSchema(compiler({ typeDefs, driver }));
    await execute({
      schema,
      document: parse("{ movies { viewer } }"),
      contextValue: { jwt: { sub: "u1" } },
    });
    expect(statements[0]!.params.jwt).toEqual({ sub: "u1" });
  });

  it("context.cypherParams are top-level parameters; a clash is an error", async () => {
    const { driver, statements } = fakeDriver(() => []);
    const schema = makeSchema(compiler({ typeDefs, driver }));
    await execute({
      schema,
      document: parse("{ movies { title } }"),
      contextValue: { cypherParams: { tenant: "t1" } },
    });
    expect(statements[0]!.params.tenant).toBe("t1");
    const clash = await execute({
      schema,
      document: parse('{ movies(where: { title: { eq: "x" } }) { title } }'),
      contextValue: { cypherParams: { p0: "t1" } },
    });
    expect(clash.errors?.[0]?.message).toMatch(/Duplicate parameter keys/);
  });

  it("Query fields run in a read transaction, Mutation fields in a write transaction", async () => {
    const { driver, statements } = fakeDriver((cypher) =>
      cypher.includes("SET m.touched") ? [{ title: "A" }] : ["A", "B"],
    );
    const schema = makeSchema(compiler({ typeDefs, driver }));
    const q = await execute({ schema, document: parse('{ titles(prefix: "A\\" OR 1=1 //") }') });
    expect(q.data).toEqual({ titles: ["A", "B"] });
    expect(statements[0]!.mode).toBe("read");
    expect(statements[0]!.cypher).toContain("STARTS WITH $p0");
    expect(statements[0]!.params.p0).toBe('A" OR 1=1 //');
    const m = await execute({
      schema,
      document: parse('mutation { touch(title: "A") { title } }'),
    });
    expect(m.data).toEqual({ touch: { title: "A" } });
    expect(statements[1]!.mode).toBe("write");
  });

  it("full-text queries call db.index.fulltext.queryNodes with parameters", async () => {
    const { driver, statements } = fakeDriver(() => [
      { total: neo4j.int(3), edges: [{ score: 1.5, node: { title: "A" } }] },
    ]);
    const schema = makeSchema(compiler({ typeDefs, driver }));
    const result = await execute({
      schema,
      document: parse(`{
        moviesByTitle(phrase: "matrix", first: 1) {
          totalCount
          pageInfo { hasNextPage endCursor }
          edges { cursor score node { title } }
        }
      }`),
    });
    expect(result.errors).toBeUndefined();
    const { cypher, params } = statements[0]!;
    expect(cypher).toMatch(
      /^CALL db\.index\.fulltext\.queryNodes\(\$p\d+, \$p\d+\) YIELD node AS this0, score AS score1/,
    );
    expect(Object.values(params)).toEqual(expect.arrayContaining(["MovieTitle", "matrix"]));
    expect(result.data).toEqual({
      moviesByTitle: {
        totalCount: 3,
        pageInfo: { hasNextPage: true, endCursor: "YXJyYXljb25uZWN0aW9uOjA=" },
        edges: [{ cursor: "YXJyYXljb25uZWN0aW9uOjA=", score: 1.5, node: { title: "A" } }],
      },
    });
  });
});

describe("type definitions", () => {
  const bad = (td: string) => () => readTypeDefs(td);

  it("arguments are only allowed on @cypher fields", () => {
    expect(bad("type A @node { name(x: Int): String }")).toThrow(UnsupportedTypeDefsError);
  });

  it("Query and Mutation fields without @cypher are served by resolvers", () => {
    const model = readTypeDefs("type A @node { name: String } type Query { a: String }");
    expect(model.query.fields).toEqual([]);
    expect(model.query.resolved.map((f) => f.name)).toEqual(["a"]);
  });

  it("@cypher needs a statement and a column", () => {
    expect(bad('type A @node { n: Int @cypher(statement: "RETURN 1 AS x") }')).toThrow(
      /columnName/,
    );
  });

  it("@fulltext fields must be String fields of the type", () => {
    expect(
      bad(
        'type A @node @fulltext(indexes: [{ indexName: "i", queryName: "q", fields: ["n"] }]) { n: Int }',
      ),
    ).toThrow(/must be a String or ID field/);
  });

  it("generated names cannot be taken by custom fields", () => {
    expect(
      bad(
        'type A @node { n: Int } type Query { as: [A!]! @cypher(statement: "MATCH (a:A) RETURN a", columnName: "a") }',
      ),
    ).toThrow(/conflicts with a generated Query field/);
  });
});
