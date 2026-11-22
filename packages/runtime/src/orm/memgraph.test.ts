import { describe, expect, it } from "vitest";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { schemaModel } from "./__fixtures__/blog.gen.js";
import { schemaModel as graphSchema } from "./__fixtures__/graph.gen.js";
import { schemaModel as vectorSchema } from "./__fixtures__/vector.gen.js";
import { schemaModel as searchSchema } from "./__fixtures__/search.gen.js";
import { QueryContext } from "./compile.js";
import { ModelEngine, type Executor, type Runner } from "./engine.js";
import { UniqueConstraintError, UnsupportedFeatureError } from "./errors.js";
import { compileShortestPath } from "./shortest.js";
import { compileTraverse } from "./traverse.js";
import { parseUniqueViolation, uniqueConstraintError } from "./unique.js";
import {
  CyphraClient,
  type DriverLike,
  type SessionLike,
  type TransactionLike,
} from "../client.js";
import { detectDialect, dialectFromServerAgent, parseDialect } from "../dialect.js";
import { createOrm } from "./client.js";

const user = schemaModel.nodes.find((n) => n.name === "User")!;
const SCALARS = "n{.`id`, .`email`, .`name`, .`age`, .`tags`, .`createdAt`}";

const mg = (schema = schemaModel) => new QueryContext(schema, "memgraph");

function engine(
  schema: typeof schemaModel,
  model: string,
  answer: (text: string) => Record<string, unknown>[] = () => [],
) {
  const calls: string[] = [];
  const exec: Executor = async (text) => {
    calls.push(text);
    return answer(text);
  };
  const runner: Runner = { read: (fn) => fn(exec), write: (fn) => fn(exec) };
  const node = schema.nodes.find((n) => n.name === model)!;
  return { calls, e: new ModelEngine(schema, node, runner, { dialect: "memgraph" }) };
}

describe("dialect option", () => {
  it("parses, detects and defaults to Neo4j", async () => {
    expect(parseDialect(undefined)).toBe("neo4j");
    expect(parseDialect("memgraph")).toBe("memgraph");
    expect(() => parseDialect("kuzu")).toThrow(/dialect must be "neo4j", "memgraph" or "falkordb"/);
    expect(
      dialectFromServerAgent("Neo4j/v5.11.0 compatible graph database server - Memgraph"),
    ).toBe("memgraph");
    expect(dialectFromServerAgent("Neo4j/5.26.0")).toBe("neo4j");
    const agent = (a: string) => ({ getServerInfo: async () => ({ agent: a }) });
    expect(await detectDialect(agent("Memgraph"))).toBe("memgraph");
    expect(await detectDialect({ rawDriver: {} })).toBe("neo4j");
  });

  it("is a client property, refused over HTTP on Memgraph", async () => {
    const driver = { session: () => ({}) as never, close: async () => {} };
    expect(new CyphraClient({ driver }).dialect).toBe("neo4j");
    expect(new CyphraClient({ driver, dialect: "memgraph" }).dialect).toBe("memgraph");
    expect(() => new CyphraClient({ uri: "https://db.example", dialect: "memgraph" })).toThrow(
      UnsupportedFeatureError,
    );
    expect(() => new CyphraClient({ uri: "https://db.example", dialect: "memgraph" })).toThrow(
      "The HTTP transport is not supported on Memgraph: Memgraph has no Query API; connect over Bolt (bolt://host:7687).",
    );
    const db = createOrm(schemaModel, { driver, dialect: "memgraph" });
    expect(db.$client.dialect).toBe("memgraph");
  });
});

describe("traverse on Memgraph", () => {
  it("compiles a variable-length expansion with a filter lambda", () => {
    const c = compileTraverse(
      mg(),
      user,
      {
        from: { id: "u1" },
        via: "following",
        depth: { min: 1, max: 3 },
        where: { age: { gte: 18 } },
        edgeWhere: { since: { gte: new Date("2024-01-01T00:00:00Z") } },
      },
      10,
    );
    expect(c.text).toBe(
      "MATCH (s:`User`) WHERE s.`id` = $p0 " +
        "MATCH (s)-[:`FOLLOWS` *1..3 (r0, m1 | (m1:`User`) AND (r0.`since` >= $p1))]->(n:`User`) " +
        "WHERE (n <> s) AND (n.`age` >= $p2) " +
        `WITH DISTINCT n RETURN ${SCALARS} AS row`,
    );
  });

  it("follows an undirected expansion with direction: both", () => {
    const c = compileTraverse(
      mg(),
      user,
      { from: {}, via: "following", direction: "both", depth: { max: 2 } },
      10,
    );
    expect(c.text).toContain("-[:`FOLLOWS` *1..2 (r0, m1 | (m1:`User`))]-(n:`User`)");
  });

  it("checks each relationship type's own direction in the lambda", () => {
    const schema = resolveSchema(
      parseSchema(`node Person {
  id      String   @id
  manages Person[] @relationship(type: "MANAGES", direction: OUT)
  mentors Person[] @relationship(type: "MENTORS", direction: IN)
}`),
    );
    const c = compileTraverse(
      new QueryContext(schema, "memgraph"),
      schema.nodes[0]!,
      { from: {}, via: ["manages", "mentors"], depth: { max: 2 } },
      10,
    );
    expect(c.text).toContain(
      "-[:`MANAGES`|`MENTORS` *1..2 (r0, m1 | (m1:`Person`) AND ((type(r0) = $p0 AND endNode(r0) = m1) OR (type(r0) = $p1 AND startNode(r0) = m1)))]-(n:`Person`)",
    );
  });

  it("chains one expansion per hop, with a labelled node between hops", () => {
    const chunk = graphSchema.nodes.find((n) => n.name === "GrChunk")!;
    const c = compileTraverse(
      mg(graphSchema),
      chunk,
      {
        from: { id: "c1" },
        via: [
          { rel: "entities", where: { kind: "person" } },
          { rel: "related", direction: "both", depth: { min: 0, max: 2 } },
          { rel: "chunks" },
        ],
        returnPaths: true,
      },
      10,
    );
    expect(c.text).toMatch(
      /^MATCH \(s:`GrChunk`\) WHERE s\.`id` = \$p0 MATCH p = \(s\)-\[:`GR_MENTIONS` \*1\.\.1 \(r\d+, m\d+ \| \(m\d+:`GrEntity`\) AND \(m\d+\.`kind` = \$p1\)\)\]->\(j\d+:`GrEntity`\)-\[:`GR_RELATED` \*0\.\.2 \(r\d+, m\d+ \| \(m\d+:`GrEntity`\)\)\]-\(j\d+:`GrEntity`\)<-\[:`GR_MENTIONS` \*1\.\.1 \(r\d+, m\d+ \| \(m\d+:`GrChunk`\)\)\]-\(n:`GrChunk`\)/,
    );
  });

  it("refuses a relation filter inside a hop (Memgraph cannot run subqueries in lambdas)", () => {
    const chunk = graphSchema.nodes.find((n) => n.name === "GrChunk")!;
    expect(() =>
      compileTraverse(
        mg(graphSchema),
        chunk,
        {
          from: { id: "c1" },
          via: [{ rel: "entities", where: { chunks: { some: { id: "c3" } } } }],
        },
        10,
      ),
    ).toThrow(UnsupportedFeatureError);
    // On the reached nodes (outside the lambda) it is fine.
    expect(
      compileTraverse(
        mg(),
        user,
        { from: {}, via: "following", depth: { max: 2 }, where: { posts: { some: {} } } },
        10,
      ).text,
    ).toContain("EXISTS { MATCH");
  });
});

describe("shortest paths on Memgraph", () => {
  it("uses *BFS, with a zero-hop branch and the projection outside a list comprehension", () => {
    const c = compileShortestPath(
      mg(),
      user,
      {
        from: { email: "a@x.io" },
        to: { email: "b@x.io" },
        via: "following",
        maxDepth: 4,
        where: { age: { gte: 18 } },
      },
      10,
      false,
    );
    expect(c.text).toContain(
      "CALL { WITH s, t MATCH p = (s) WHERE s = t RETURN p UNION WITH s, t MATCH p = (s)-[:`FOLLOWS` *BFS ..4 (r0, m1 | (m1:`User`) AND (m1 = t OR (m1.`age` >= $p2)))]->(t) WHERE s <> t RETURN p }",
    );
    expect(c.text).toContain(
      " WITH p ORDER BY length(p) LIMIT 1 CALL { WITH p UNWIND nodes(p) AS ",
    );
  });

  it("uses *ALLSHORTEST with a constant weight for every shortest path", () => {
    const c = compileShortestPath(
      mg(),
      user,
      { from: {}, to: {}, via: "following", maxDepth: 3, take: 2 },
      10,
      true,
    );
    expect(c.text).toMatch(/\*ALLSHORTEST \.\.3 \(r0, m1 \| 1\) w2 \(r3, m4 \| \(m4:`User`\)\)/);
    expect(c.text).toContain("WITH collect(p) AS ps, min(length(p)) AS d");
  });
});

describe("vector and text search on Memgraph", () => {
  it("calls vector_search.search, rescales cosine scores and skips deleted hits", async () => {
    const { calls, e } = engine(vectorSchema, "VecChunk", () => [
      { fetched: 2, lowest: 0.5, rows: [] },
    ]);
    await e.findSimilar({ field: "embedding", vector: [1, 0, 0], k: 2 });
    expect(calls[0]).toMatch(
      /^CALL vector_search\.search\(\$p\d+, \$cyphraCandidates, \$p\d+\) YIELD node AS hit, similarity OPTIONAL MATCH \(node\) WHERE id\(node\) = id\(hit\) WITH node, \(1 \+ similarity\) \/ 2 AS score WITH collect/,
    );
    expect(calls[0]).toContain("WHERE n IS NOT NULL");
  });

  it("computes exact scores like Neo4j's vector.similarity functions", async () => {
    const { calls, e } = engine(vectorSchema, "VecChunk");
    await e.findSimilar({ field: "embedding", vector: [1, 0, 0], k: 1, exact: true });
    expect(calls[0]).toContain("(1 + vector_search.cosine_similarity(n.`embedding`, $p");
    await e.findSimilar({ field: "sketch", vector: [1, 0], k: 1, exact: true });
    expect(calls[1]).toMatch(
      /1\.0 \/ \(1\.0 \+ reduce\(acc = 0\.0, i\d+ IN range\(0, size\(\$p\d+\) - 1\)/,
    );
  });

  it("searches text indexes with text_search.search_all", async () => {
    const { calls, e } = engine(searchSchema, "FtPost");
    await e.search({ index: "ftPostSearch", query: "graph", take: 5 });
    expect(calls[0]).toMatch(
      /^CALL text_search\.search_all\(\$p0, \$p1, \{limit: \$p2\}\) YIELD node AS hit, score MATCH \(node\) WHERE id\(node\) = id\(hit\) WITH node AS n, score/,
    );
  });
});

describe("Memgraph errors", () => {
  it("maps Memgraph's uniqueness violations", () => {
    expect(
      parseUniqueViolation("Unable to commit due to unique constraint violation on :User(email)"),
    ).toEqual({ entity: "node", label: "User", properties: ["email"] });
    const err = uniqueConstraintError(schemaModel, {
      code: "Memgraph.ClientError.MemgraphError.MemgraphError",
      message: "Unable to commit due to unique constraint violation on :User(email)",
    });
    expect(err).toBeInstanceOf(UniqueConstraintError);
    expect(err).toMatchObject({
      model: "User",
      fields: ["email"],
      constraint: "User_email_unique",
    });
  });

  it("rejects Time values and month durations before running anything", async () => {
    const statements: string[] = [];
    const tx: TransactionLike = {
      run: async (text: string) => (statements.push(text), { records: [] }),
    };
    const session: SessionLike = {
      run: tx.run,
      executeRead: async (fn) => fn(tx),
      executeWrite: async (fn) => fn(tx),
      close: async () => {},
    };
    const driver: DriverLike = { session: () => session, close: async () => {} };
    const db = createOrm(schemaModel, { driver, dialect: "memgraph" }) as unknown as {
      $cypher(s: TemplateStringsArray, ...v: unknown[]): Promise<unknown>;
    };
    const { CypherTime, CypherDuration } = await import("../cypher-values.js");
    await expect(db.$cypher`RETURN ${new CypherTime(10, 0, 0, 0, 0)}`).rejects.toThrow(
      UnsupportedFeatureError,
    );
    await expect(db.$cypher`RETURN ${[new CypherDuration(1, 0, 0, 0)]}`).rejects.toThrow(
      /A Duration with months or years is not supported on Memgraph/,
    );
    await db.$cypher`RETURN ${new CypherDuration(0, 1, 0, 0)}`;
    expect(statements).toHaveLength(1);
  });
});
