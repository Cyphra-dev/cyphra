import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { createOrm, withEngineRules } from "./client.js";
import { UnsupportedFeatureError } from "./errors.js";
import { CYPHER_NODE, cypherFragment as cypher, encodeCypherParam } from "./cypherExpr.js";
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
