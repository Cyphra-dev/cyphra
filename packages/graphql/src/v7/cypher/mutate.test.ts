import { execute, parse } from "graphql";
import neo4j from "neo4j-driver";
import { describe, expect, it } from "vitest";
import { fakeDriver } from "../../../test/helpers.js";
import { makeSchema } from "../index.js";

const typeDefs = /* GraphQL */ `
  type Movie @node {
    id: ID! @id
    title: String!
    released: Int
    rating: Float
    genres: [String!]
    updatedAt: DateTime @timestamp(operations: [UPDATE])
    actors: [Person!]! @relationship(type: "ACTED_IN", direction: IN, properties: "ActedIn")
  }
  type Person @node {
    name: String!
    movies: [Movie!]! @relationship(type: "ACTED_IN", direction: OUT, properties: "ActedIn")
  }
  type ActedIn @relationshipProperties {
    screenTime: Int
    since: DateTime @timestamp(operations: [CREATE])
  }
  type Secret @node @authorization(filter: [{ where: { node: { name: { eq: "$jwt.sub" } } } }]) {
    name: String!
  }
`;

async function run(document: string, rows: unknown[] = [{ info: {}, data: {} }]) {
  const { driver, statements } = fakeDriver(() => rows);
  const schema = makeSchema({ typeDefs, driver });
  const result = await execute({ schema, document: parse(document) });
  return { result, statements };
}

describe("create", () => {
  it("one write statement: inputs without relationships share an UNWIND, nested writes are subqueries", async () => {
    const { result, statements } = await run(
      `mutation {
        createMovies(input: [
          { title: "A" }
          { title: "B", released: 1 }
          { title: "C", actors: {
              create: [{ node: { name: "N" }, edge: { screenTime: 3 } }]
              connect: [{ where: { node: { name: { eq: "K" } } } }]
          } }
        ]) { info { nodesCreated relationshipsCreated } movies { title } }
      }`,
      [{ info: { nc: neo4j.int(4), rc: neo4j.int(2) }, data: { movies: [{ title: "A" }] } }],
    );
    expect(result.errors).toBeUndefined();
    expect(statements).toHaveLength(1);
    expect(statements[0]!.mode).toBe("write");
    const { cypher, params } = statements[0]!;
    expect(cypher).toContain(
      "UNWIND $p0 AS row0\n  CREATE (this1:`Movie`)\n  SET this1.`id` = randomUUID(), this1.`title` = row0.`title`, this1.`released` = row0.`released`",
    );
    expect(params.p0).toEqual([
      { title: "A", released: null },
      { title: "B", released: neo4j.int(1) },
    ]);
    // Nested create: node, then the edge with its CREATE timestamp; nested create before connect.
    expect(cypher).toContain(
      "CREATE (this4:`Person`)\n    SET this4.`name` = $p2\n    CREATE (this3)<-[edge5:`ACTED_IN`]-(this4)\n    SET edge5.`since` = datetime(), edge5.`screenTime` = $p3",
    );
    // Connect is a CREATE (like v7), without generated edge properties.
    expect(cypher).toContain(
      "MATCH (this7:`Person`) WHERE this7.`name` = $p4\n    CREATE (this3)<-[edge8:`ACTED_IN`]-(this7)\n    RETURN",
    );
    expect(cypher.indexOf("CREATE (this4")).toBeLessThan(cypher.indexOf("MATCH (this7"));
    // The projection runs after every write (on the collected nodes).
    expect(cypher).toMatch(/WITH created2 \+ created10 AS nodes12, .* AS info\nCALL \(nodes12\)/);
    expect(result.data).toEqual({
      createMovies: {
        info: { nodesCreated: 4, relationshipsCreated: 2 },
        movies: [{ title: "A" }],
      },
    });
  });

  it("counts every created node and relationship in the statement", async () => {
    const { statements } = await run(
      `mutation { createMovies(input: [{ title: "C", actors: { create: [{ node: { name: "N" } }] } }]) { info { nodesCreated } } }`,
    );
    const { cypher } = statements[0]!;
    expect(cypher).toContain("RETURN { nc: sum(1), nd: sum(0), rc: sum(1), rd: sum(0) } AS count");
    expect(cypher).toMatch(/nc: sum\(1 \+ count\d+\.nc\)/);
  });
});

describe("update", () => {
  it("scalar operators, deprecated forms, timestamps and checks", async () => {
    const { result, statements } = await run(
      `mutation {
        updateMovies(where: { title: { eq: "A" } }, update: {
          released: { add: 1 }, rating_MULTIPLY: 2, genres_PUSH: ["x"], title_SET: "B"
        }) { info { nodesCreated } }
      }`,
    );
    expect(result.errors).toBeUndefined();
    const { cypher, params } = statements[0]!;
    expect(cypher).toContain(
      "MATCH (this0:`Movie`)\nWHERE this0.`title` = $p0\nSET this0.`updatedAt` = datetime(), this0.`title` = $p1, this0.`released` = (this0.`released` + $p2), this0.`rating` = (this0.`rating` * $p5), this0.`genres` = this0.`genres` + $p7",
    );
    // Checks are evaluated on the written values and returned with the counts.
    expect(cypher).toContain(
      "errors: reduce(acc = [], l IN collect([x IN [CASE WHEN this0.`released` IS NULL THEN $p3 WHEN this0.`released` > 2147483647 THEN $p4 END, CASE WHEN this0.`rating` IS NULL THEN $p6 END, CASE WHEN this0.`genres` IS NULL THEN $p8 END] WHERE x IS NOT NULL]) | acc + l)",
    );
    expect(params.p2).toEqual(neo4j.int(1));
    expect(params.p3).toBe("Cannot add 1 to Nan");
    expect(params.p4).toBe("Overflow: Value returned from operator add is larger than 32 bit");
    expect(params.p6).toBe("Cannot multiply 2.0 to Nan");
    expect(params.p8).toBe("Property genres cannot be NULL");
  });

  it("a failed check is an error (and the write transaction is rolled back)", async () => {
    const { result } = await run(
      `mutation { updateMovies(update: { released: { add: 1 } }) { info { nodesCreated } } }`,
      [{ info: { errors: ["Cannot add 1 to Nan"] }, data: {} }],
    );
    expect(result.errors?.[0]?.message).toBe("Cannot add 1 to Nan");
  });

  it("conflicting modifications of one field are rejected like v7", async () => {
    const { result, statements } = await run(
      `mutation { updateMovies(update: { released: { add: 1 }, released_INCREMENT: 1 }) { info { nodesCreated } } }`,
    );
    expect(result.errors?.[0]?.message).toBe(
      "Conflicting modification of [[released]], [[released_INCREMENT]] on type Movie",
    );
    expect(statements).toHaveLength(0);
  });

  it("relationship operations run in the v7 order: update, create, connect, delete, disconnect", async () => {
    const { statements } = await run(
      `mutation {
        updateMovies(update: { actors: [{
          disconnect: [{ where: { node: { name: { eq: "X" } } } }]
          delete: [{ where: { node: { name: { eq: "D" } } }, delete: { movies: [{}] } }]
          connect: [{ where: { node: { name: { eq: "C" } } } }]
          create: [{ node: { name: "N" } }]
          update: { where: { edge: { screenTime: { gt: 1 } } }, edge: { screenTime: { set: 2 } } }
        }] }) { info { nodesDeleted } }
      }`,
    );
    const { cypher } = statements[0]!;
    const at = (s: string) => {
      const i = cypher.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at("SET edge2.`screenTime` = $p"),
      at("CREATE (this3:`Person`)"),
      at("MATCH (this6:`Person`) WHERE this6.`name`"),
      at("FOREACH ("),
      at("DELETE edge"),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Nested delete: the related nodes matched (with nested deletes) before anything is deleted;
    // the distinct nodes and their relationships are counted.
    expect(cypher).toContain(
      "MATCH (this0)<-[edge10:`ACTED_IN`]-(this9:`Person`) WHERE this9.`name` = $p4 MATCH (this9)-[edge12:`ACTED_IN`]->(this11:`Movie`) RETURN DISTINCT this11",
    );
    expect(cypher).toMatch(
      /COUNT \{ UNWIND deleted\d+ AS node\d+ MATCH \(node\d+\)-\[rel\d+\]-\(\) RETURN DISTINCT rel\d+ \}/,
    );
  });

  it("without `update` it reads (and refreshes UPDATE timestamps, like v7)", async () => {
    const { result, statements } = await run(
      `mutation { updateMovies(where: { title: { eq: "A" } }) { movies { t: title } } }`,
      [{ info: {}, data: { movies: [{ t: "A" }] } }],
    );
    expect(statements[0]!.cypher).toContain("SET this0.`updatedAt` = datetime()");
    expect(result.data).toEqual({ updateMovies: { movies: [{ t: "A" }] } });
  });
});

describe("delete", () => {
  it("deletes the matched nodes and the nested ones, returning DeleteInfo", async () => {
    const { result, statements } = await run(
      `mutation {
        deleteMovies(where: { title: { eq: "A" } }, delete: { actors: [{ where: { node: { name: { eq: "X" } } } }] }) {
          deleted: nodesDeleted
          relationshipsDeleted
        }
      }`,
      [{ nd: neo4j.int(2), rd: neo4j.int(5) }],
    );
    expect(result.errors).toBeUndefined();
    expect(statements[0]!.cypher).toBe(
      [
        "MATCH (this0:`Movie`)",
        "WHERE this0.`title` = $p0",
        "WITH collect(this0) AS roots1, collect(COLLECT { MATCH (this0)<-[edge3:`ACTED_IN`]-(this2:`Person`) WHERE this2.`name` = $p1 RETURN DISTINCT this2 }) AS related4",
        "WITH COLLECT { UNWIND (roots1 + reduce(acc = [], l IN related4 | acc + l)) AS node6 RETURN DISTINCT node6 } AS deleted5",
        "WITH deleted5, COUNT { UNWIND deleted5 AS node6 MATCH (node6)-[rel7]-() RETURN DISTINCT rel7 } AS relCount8",
        "FOREACH (node6 IN deleted5 | DETACH DELETE node6)",
        "RETURN { nc: 0, nd: size(deleted5), rc: 0, rd: relCount8 } AS this",
      ].join("\n"),
    );
    expect(result.data).toEqual({ deleteMovies: { deleted: 2, relationshipsDeleted: 5 } });
  });
});

describe("not implemented yet", () => {
  it("writes to types with authorization rules (#74)", async () => {
    const { result, statements } = await run(
      `mutation { createSecrets(input: [{ name: "x" }]) { info { nodesCreated } } }`,
    );
    expect(result.errors?.[0]?.message).toMatch(
      /^Not implemented yet in @cyphra\/graphql \(see #74\)/,
    );
    expect(statements).toHaveLength(0);
  });
});
