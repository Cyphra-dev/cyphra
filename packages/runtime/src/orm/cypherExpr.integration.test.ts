import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import neo4j from "neo4j-driver";
import { createOrm, runCypherFragment, withEngineRules, withReservedVariables } from "./client.js";
import { UnsupportedFeatureError } from "./errors.js";
import {
  CYPHER_AGGREGATES,
  CYPHER_NODE,
  cypherFragment as cypher,
  encodeCypherParam,
} from "./cypherExpr.js";
import { hasTestDb, onFalkorDB, onMemgraph, testConnection } from "./__fixtures__/testDialect.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

type Row = Record<string, unknown>;
type Delegate = Record<string, (args?: unknown) => Promise<unknown>>;
type UntypedDb = {
  cxUser: Delegate;
  cxPost: Delegate;
  $cypher(strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
  $disconnect(): Promise<void>;
};

// Internal engine entries behind the native GraphQL API's Cypher-backed fields.
describe.skipIf(!hasTestDb)("Cypher expressions in select, where and orderBy", () => {
  const schema = resolveSchema(
    parseSchema(`
      node CxUser {
        id        String   @id
        name      String
        posts     CxPost[] @relationship(type: "CX_WROTE", direction: OUT)
        followers CxUser[] @relationship(type: "CX_FOLLOWS", direction: IN)
      }
      node CxPost {
        id        String  @id
        title     String
        published Boolean
        author    CxUser? @relationship(type: "CX_WROTE", direction: IN)
      }
    `),
  );
  let db: UntypedDb;
  const wipe = () => db.$cypher`MATCH (n) WHERE n:CxUser OR n:CxPost DETACH DELETE n`;
  // Memgraph has no COUNT {} subquery expression: a pattern-free size() of a list works everywhere.
  const followers = onMemgraph
    ? cypher`size([(${CYPHER_NODE})<-[:CX_FOLLOWS]-(f) | f])`
    : cypher`COUNT { (${CYPHER_NODE})<-[:CX_FOLLOWS]-() }`;
  const posts = cypher`[(${CYPHER_NODE})-[:CX_WROTE]->(p) | p]`;

  beforeAll(async () => {
    db = createOrm(schema, { ...testConnection() }) as unknown as UntypedDb;
    await wipe();
    await db.$cypher`
      CREATE (a:CxUser {id: "a", name: "Ada"}), (b:CxUser {id: "b", name: "Bob"}),
             (c:CxUser {id: "c", name: "Cy"})
      CREATE (b)-[:CX_FOLLOWS]->(a), (c)-[:CX_FOLLOWS]->(a), (a)-[:CX_FOLLOWS]->(b)
      CREATE (a)-[:CX_WROTE]->(:CxPost {id: "p1", title: "One", published: true}),
             (a)-[:CX_WROTE]->(:CxPost {id: "p2", title: "Two", published: false}),
             (b)-[:CX_WROTE]->(:CxPost {id: "p3", title: "Three", published: true})`;
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  it("projects, filters and sorts on a scalar expression", async () => {
    const rows = await db.cxUser.findMany({
      where: { $cypher: [{ expr: followers, type: "Int", filter: { gte: 1 } }] },
      orderBy: [{ $cypher: { expr: followers, type: "Int", sort: "desc" } }],
      select: { id: true, followerCount: { $cypher: followers, $type: "Int" } },
    });
    expect(rows).toEqual([
      { id: "a", followerCount: 2 },
      { id: "b", followerCount: 1 },
    ]);
  });

  it.runIf(onFalkorDB)("refuses expressions returning nodes on FalkorDB", async () => {
    await expect(
      db.cxUser.findMany({
        select: { id: true, wrote: { $cypher: posts, $model: "CxPost", $many: true } },
      }),
    ).rejects.toThrow(UnsupportedFeatureError);
  });

  it.skipIf(onFalkorDB)(
    "projects the nodes an expression returns, filtered by the target's read rule",
    async () => {
      const scoped = withEngineRules(db, { CxPost: { read: { published: true } } });
      const rows = await scoped.cxUser.findMany({
        where: { id: "a" },
        select: {
          id: true,
          wrote: {
            $cypher: posts,
            $model: "CxPost",
            $many: true,
            select: { id: true, title: true },
            orderBy: { id: "asc" },
          },
        },
      });
      expect(rows).toEqual([{ id: "a", wrote: [{ id: "p1", title: "One" }] }]);
    },
  );

  it.skipIf(onFalkorDB)("returns one node (or null) for a single-node expression", async () => {
    const rows = await db.cxUser.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        latest: {
          $cypher: cypher`head([(${CYPHER_NODE})-[:CX_WROTE]->(p) WHERE p.published | p])`,
          $model: "CxPost",
          select: { id: true },
        },
      },
    });
    expect(rows).toEqual([
      { id: "a", latest: { id: "p1" } },
      { id: "b", latest: { id: "p3" } },
      { id: "c", latest: null },
    ]);
  });

  it("binds context values and typed arguments as parameters: no injection", async () => {
    const evil = `Ada"}) DETACH DELETE n //`;
    const rows = (await db.cxUser.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        match: { $cypher: cypher`${CYPHER_NODE}.name = ${evil}`, $type: "Boolean" },
        limited: {
          $cypher: cypher`[x IN range(1, 5) | x][0..${encodeCypherParam("Int", 2)}]`,
          $type: "Int",
          $list: true,
        },
      },
    })) as Row[];
    expect(rows.map((r) => r.match)).toEqual([false, false, false]);
    expect(rows[0]!.limited).toEqual([1, 2]);
    const left = await db.$cypher`MATCH (n:CxUser) RETURN count(n) AS c`;
    expect(Number(left[0]!.c)).toBe(3);
  });
});

// Internal engine entries behind compat.v7's `@cypher` statements (Neo4j only).
describe.skipIf(!hasTestDb)("Cypher CALL clauses ($call, $from) and reserved variables", () => {
  const schema = resolveSchema(
    parseSchema(`
      node CcAuthor {
        id    String   @id
        name  String
        books CcBook[] @relationship(type: "CC_WROTE", direction: OUT)
      }
      node CcBook {
        id      String     @id
        title   String
        authors CcAuthor[] @relationship(type: "CC_WROTE", direction: IN)
      }
      relationship CcWrote {
        type "CC_WROTE"
        from CcAuthor
        to CcBook
        position Int
      }
    `),
  );
  let db: UntypedDb & { ccAuthor: Delegate; ccBook: Delegate };
  const wipe = () => db.$cypher`MATCH (n) WHERE n:CcAuthor OR n:CcBook DETACH DELETE n`;
  const neo4jOnly = onMemgraph || onFalkorDB;
  // A statement that aggregates, and names variables the engine uses (`n`, `m0`).
  const bookCount = cypher`CALL (${CYPHER_NODE}) {
  WITH ${CYPHER_NODE} AS this
  /* cyphra:aggregates */
  MATCH (this)-[:CC_WROTE]->(m0:CcBook) RETURN count(m0) AS n
}
RETURN n`;
  const bookCountValue = cypher`head(COLLECT {
  /* cyphra:aggregates */
  CALL (${CYPHER_NODE}) {
    WITH ${CYPHER_NODE} AS this
    MATCH (this)-[:CC_WROTE]->(m0:CcBook) RETURN count(m0) AS n
  }
  RETURN n
})`;
  // One row per book: none for an author without books, several for an author with many.
  const titles = cypher`CALL (${CYPHER_NODE}) {
  WITH ${CYPHER_NODE} AS this
  MATCH (this)-[:CC_WROTE]->(b:CcBook) RETURN b.title AS n
}
RETURN n`;

  it("marks aggregating fragments with a comment", () => {
    expect(CYPHER_AGGREGATES).toBe("/* cyphra:aggregates */");
  });

  beforeAll(async () => {
    const orm = createOrm(schema, { ...testConnection() });
    db = withReservedVariables(orm, ["n", "m0", "this", "b"]) as unknown as typeof db;
    await wipe();
    await db.$cypher`
      CREATE (a:CcAuthor {id: "a", name: "Ada"}), (b:CcAuthor {id: "b", name: "Bob"}),
             (c:CcAuthor {id: "c", name: "Cy"})
      CREATE (a)-[:CC_WROTE {position: 1}]->(:CcBook {id: "x", title: "X"}),
             (a)-[:CC_WROTE {position: 2}]->(y:CcBook {id: "y", title: "Y"}),
             (b)-[:CC_WROTE {position: 1}]->(y)`;
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  it.runIf(neo4jOnly)("refuses $call off Neo4j", async () => {
    await expect(
      db.ccAuthor.findMany({ select: { id: true, n: { $call: bookCount, $type: "Int" } } }),
    ).rejects.toThrow(/needs Neo4j/);
  });

  it.skipIf(neo4jOnly)(
    "sorts by and projects an aggregating statement, computed once, with clashing names",
    async () => {
      const rows = await db.ccAuthor.findMany({
        orderBy: [
          { $call: { expr: bookCount, type: "Int", sort: "desc", key: "n" } },
          { id: "asc" },
        ],
        take: 2,
        select: { id: true, count: { $call: bookCount, $type: "Int", $key: "n" } },
      });
      expect(rows).toEqual([
        { id: "a", count: 2 },
        { id: "b", count: 1 },
      ]);
    },
  );

  it.skipIf(neo4jOnly)("drops or repeats a node with the rows of a $call", async () => {
    const rows = await db.ccAuthor.findMany({
      orderBy: { id: "asc" },
      select: { id: true, title: { $call: titles, $type: "String" } },
    });
    const list = rows as Row[];
    expect(list.map((r) => r.id)).toEqual(["a", "a", "b"]);
    expect(list.map((r) => r.title).sort()).toEqual(["X", "Y", "Y"]);
  });

  it.skipIf(neo4jOnly)(
    "runs relation loads with aggregating filters, sorts and projections as CALL clauses",
    async () => {
      const rows = await db.ccBook.findMany({
        orderBy: { id: "asc" },
        select: {
          id: true,
          authors: {
            where: {
              $cypher: [{ expr: bookCountValue, type: "Int", filter: { gte: 1 } }],
            },
            orderBy: [{ $call: { expr: bookCount, type: "Int", sort: "asc" } }],
            select: {
              id: true,
              count: { $call: bookCount, $type: "Int" },
              position: {
                $call: cypher`RETURN ${CYPHER_NODE}.position`,
                $type: "Int",
                $edge: true,
              },
            },
          },
        },
      });
      expect(rows).toEqual([
        { id: "x", authors: [{ id: "a", count: 2, position: 1, $edge: { position: 1 } }] },
        {
          id: "y",
          authors: [
            { id: "b", count: 1, position: 1, $edge: { position: 1 } },
            { id: "a", count: 2, position: 2, $edge: { position: 2 } },
          ],
        },
      ]);
    },
  );

  it.skipIf(neo4jOnly)("filters on the nodes of an aggregating $call", async () => {
    const most = cypher`CALL (${CYPHER_NODE}) {
  WITH ${CYPHER_NODE} AS this
  MATCH (this)-[:CC_WROTE]->(b:CcBook)<-[:CC_WROTE]-(n:CcAuthor)
  WITH n, count(*) AS shared ORDER BY shared DESC, n.id RETURN n
}
RETURN n`;
    const rows = await db.ccAuthor.findMany({
      where: {
        $cypherNodes: [{ call: most, model: "CcAuthor", quantifier: "some", where: { id: "b" } }],
      },
      select: {
        id: true,
        coAuthors: {
          $call: most,
          $model: "CcAuthor",
          $many: true,
          $labelTest: false,
          where: { NOT: { id: "a" } },
          select: { id: true },
        },
      },
    });
    // The pattern's two edges differ: an author is not its own co-author.
    expect(rows).toEqual([{ id: "a", coAuthors: [{ id: "b" }] }]);
  });

  it.skipIf(neo4jOnly)("reads the nodes of a statement's rows with $from", async () => {
    const rows = await db.ccAuthor.findMany({
      $from: cypher`CALL () { MATCH (n:CcAuthor) WHERE n.id <> ${"c"} RETURN n UNION RETURN null AS n }
RETURN n`,
      where: { NOT: { id: "b" } },
      select: { id: true, count: { $call: bookCount, $type: "Int" } },
    });
    expect(rows).toEqual([{ id: "a", count: 2 }]);
  });

  it.skipIf(neo4jOnly)("runs a whole statement and returns the driver's rows", async () => {
    const rows = await runCypherFragment(
      db,
      cypher`MATCH (n:CcAuthor) WHERE n.id = ${"a"} RETURN n.name AS name, count(*) AS c`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Ada");
    expect(neo4j.isInt(rows[0]!.c)).toBe(true);
  });
});
