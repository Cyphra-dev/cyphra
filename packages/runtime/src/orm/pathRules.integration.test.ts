/**
 * Engine rules on paths (`withEngineRules`): a traversal or a shortest path never steps through a
 * node the read rules hide, and the nodes of returned paths follow the field rules. Also the
 * traversal load (`$traverse`, internal) of the native GraphQL API's named traversal fields. Own
 * `Tr*` labels, so it can run next to the other suites.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { createOrm, withEngineRules, type OrmClient, type TypeMap } from "../index.js";
import { UnsupportedFeatureError } from "./errors.js";
import { hasTestDb, onFalkorDB, onMemgraph, testConnection } from "./__fixtures__/testDialect.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const schema = resolveSchema(
  parseSchema(/* cyphra */ `
node TrUser {
  id      String  @id
  name    String
  email   String?
  hidden  Boolean @default(false)
  follows TrUser[] @relationship(type: "TR_FOLLOWS", direction: OUT)
  docs    TrDoc[]  @relationship(type: "TR_WROTE", direction: OUT)
}

node TrDoc {
  id     String  @id
  title  String
  author TrUser? @relationship(type: "TR_WROTE", direction: IN)
}
`),
);

type Rows = Record<string, unknown>[];
type Delegate = Record<string, (args: unknown) => Promise<unknown>>;

describe.skipIf(!hasTestDb)("engine rules on paths", () => {
  let db: OrmClient<TypeMap>;
  let scoped: OrmClient<TypeMap>;
  const users = (c: OrmClient<TypeMap>) => (c as unknown as Record<string, Delegate>).trUser!;
  const ids = (rows: unknown) => (rows as Rows).map((r) => r.id).sort();

  beforeAll(async () => {
    db = createOrm<TypeMap>(schema, testConnection());
    await db.$cypher`MATCH (n) WHERE n:TrUser OR n:TrDoc DETACH DELETE n`;
    // a → b, a → h (hidden) → c; each user wrote one doc.
    await db.$cypher`CREATE (a:TrUser {id: "a", name: "A", email: "a@x.io", hidden: false}),
      (b:TrUser {id: "b", name: "B", email: "b@x.io", hidden: false}),
      (h:TrUser {id: "h", name: "H", email: "h@x.io", hidden: true}),
      (c:TrUser {id: "c", name: "C", email: "c@x.io", hidden: false}),
      (a)-[:TR_FOLLOWS]->(b), (a)-[:TR_FOLLOWS]->(h), (h)-[:TR_FOLLOWS]->(c),
      (a)-[:TR_WROTE]->(:TrDoc {id: "da", title: "A's"}),
      (b)-[:TR_WROTE]->(:TrDoc {id: "db", title: "B's"}),
      (h)-[:TR_WROTE]->(:TrDoc {id: "dh", title: "H's"}),
      (c)-[:TR_WROTE]->(:TrDoc {id: "dc", title: "C's"})`;
    // Hidden users do not exist; each user reads their own email only (here: a's).
    scoped = withEngineRules(db, {
      TrUser: { read: { hidden: false }, fields: { email: { id: "a" } } },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.$cypher`MATCH (n) WHERE n:TrUser OR n:TrDoc DETACH DELETE n`;
    await db.$disconnect();
  });

  it("traverse does not step through a hidden node", async () => {
    const args = { from: { id: "a" }, via: "follows", depth: { max: 2 }, select: { id: true } };
    expect(ids(await users(db).traverse(args))).toEqual(["b", "c", "h"]);
    expect(ids(await users(scoped).traverse(args))).toEqual(["b"]);
    const hops = {
      from: { id: "a" },
      via: [{ rel: "follows", depth: { max: 2 } }],
      select: { id: true },
    };
    expect(ids(await users(scoped).traverse(hops))).toEqual(["b"]);
  });

  it("returned paths hold no hidden node, and their nodes follow the field rules", async () => {
    const res = (await users(scoped).traverse({
      from: { id: "a" },
      via: "follows",
      depth: { min: 0, max: 2 },
      returnPaths: true,
      orderBy: { id: "asc" },
      select: { id: true },
    })) as { node: { id: string }; path: { nodes: Rows } }[];
    expect(res.map((r) => r.node.id)).toEqual(["a", "b"]);
    const path = res[1]!.path.nodes;
    expect(path.map((n) => n.id)).toEqual(["a", "b"]);
    expect(path.map((n) => n.email)).toEqual(["a@x.io", null]);
  });

  it("shortestPath does not go through a hidden node", async () => {
    const args = { from: { id: "a" }, to: { id: "c" }, via: "follows", maxDepth: 3 };
    const all = (await users(db).shortestPath(args)) as { nodes: Rows } | null;
    expect(all?.nodes.map((n) => n.id)).toEqual(["a", "h", "c"]);
    expect(await users(scoped).shortestPath(args)).toBeNull();
    const toB = (await users(scoped).shortestPath({ ...args, to: { id: "b" } })) as {
      nodes: Rows;
    };
    expect(toB.nodes.map((n) => [n.id, n.email])).toEqual([
      ["a", "a@x.io"],
      ["b", null],
    ]);
  });

  it("loads a traversal under a key ($traverse), in the parent's statement", async () => {
    const select = {
      id: true,
      reach: {
        $traverse: { via: [{ rel: "follows", depth: { max: 2 } }, { rel: "docs" }] },
        orderBy: { id: "asc" },
        select: { id: true },
      },
    };
    if (onMemgraph || onFalkorDB) {
      await expect(users(db).findUnique({ where: { id: "a" }, select })).rejects.toThrow(
        UnsupportedFeatureError,
      );
      return;
    }
    expect(await users(db).findUnique({ where: { id: "a" }, select })).toEqual({
      id: "a",
      reach: [{ id: "db" }, { id: "dc" }, { id: "dh" }],
    });
    expect(await users(scoped).findUnique({ where: { id: "a" }, select })).toEqual({
      id: "a",
      reach: [{ id: "db" }],
    });
    // Paged per parent; the start node is not reached (depth.min 0 would include it).
    const firstTwo = await users(db).findMany({
      where: { id: { in: ["a", "h"] } },
      orderBy: { id: "asc" },
      select: {
        id: true,
        reach: {
          $traverse: { via: [{ rel: "follows", depth: { min: 0, max: 1 } }, { rel: "docs" }] },
          orderBy: { id: "asc" },
          take: 2,
          select: { id: true },
        },
      },
    });
    expect(firstTwo).toEqual([
      { id: "a", reach: [{ id: "da" }, { id: "db" }] },
      { id: "h", reach: [{ id: "dc" }, { id: "dh" }] },
    ]);
  });
});
