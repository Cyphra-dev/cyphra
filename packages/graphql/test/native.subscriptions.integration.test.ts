/**
 * Subscriptions of the native API on Neo4j Change Data Capture (`native.CDCReader`): the rules
 * apply to the re-read of every event, node changes and relationship events alike, so a subscriber
 * never receives a node the rules hide; DELETED events; the reader on a Cyphra client; the error
 * on a database without CDC.
 *
 * Needs Neo4j Enterprise with CDC enabled on the default database
 * (`ALTER DATABASE neo4j SET OPTION txLogEnrichment 'FULL'`): NEO4J_TEST_URI / NEO4J_TEST_USER /
 * NEO4J_TEST_PASSWORD and NEO4J_TEST_CDC=1. Only nodes with `Ns*` labels are touched; a
 * `cyphranativenocdc` database (no CDC) is created for the error test.
 */
import { createOrm, type TypeMap } from "@cyphra/runtime";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { graphql, parse, subscribe, type ExecutionResult, type GraphQLSchema } from "graphql";
import neo4j, { type Driver } from "neo4j-driver";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { native } from "../src/index.js";

const env = {
  uri: process.env.NEO4J_TEST_URI,
  user: process.env.NEO4J_TEST_USER,
  password: process.env.NEO4J_TEST_PASSWORD,
};
const hasCdc = Boolean(env.uri && env.user && env.password && process.env.NEO4J_TEST_CDC === "1");

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const schemaModel = resolveSchema(
  parseSchema(/* cyphra */ `
node NsUser {
  id    String   @id
  name  String
  posts NsPost[] @relationship(type: "NS_AUTHORED", direction: OUT)
}

node NsPost {
  id        String  @id @default(cuid())
  title     String
  published Boolean @default(false)
  author    NsUser? @relationship(type: "NS_AUTHORED", direction: IN)
  tags      NsTag[] @relationship(type: "NS_TAGGED", direction: OUT)
}

node NsTag {
  name     String   @id
  internal Boolean  @default(false)
  posts    NsPost[] @relationship(type: "NS_TAGGED", direction: IN)
}
`),
);

type Ctx = { user?: { id: string } };
const me = (ctx: Ctx) => ctx.user?.id ?? "";

const config = native.defineGraphQL<TypeMap, Ctx>({
  defaults: { operations: { subscribe: true } },
  models: {
    NsPost: {
      operations: { create: ["create"], update: ["update"] },
      rules: {
        read: ({ ctx }) => ({ OR: [{ published: true }, { author: { is: { id: me(ctx) } } }] }),
      },
    },
    NsTag: { rules: { read: () => ({ internal: false }) } },
  },
});

const alice: Ctx = { user: { id: "u-alice" } };
const bob: Ctx = { user: { id: "u-bob" } };

type Stream = { events: unknown[]; stop: () => Promise<void> };

/** Subscribe and collect every event in the background. */
async function open(schema: GraphQLSchema, document: string, ctx: Ctx = {}): Promise<Stream> {
  const result = await subscribe({ schema, document: parse(document), contextValue: { ...ctx } });
  if (!(Symbol.asyncIterator in result)) {
    throw new Error(`subscribe failed: ${JSON.stringify((result as ExecutionResult).errors)}`);
  }
  const iterator = result[Symbol.asyncIterator]() as AsyncIterator<ExecutionResult>;
  const events: unknown[] = [];
  const pump = (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      if (next.value.errors) throw new Error(JSON.stringify(next.value.errors));
      events.push(next.value.data);
    }
  })();
  return {
    events,
    stop: async () => {
      await iterator.return?.();
      await pump;
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `stream` has `count` events, then a little longer (nothing else may come). */
async function settle(stream: Stream, count: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (stream.events.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`timed out with ${stream.events.length} of ${count} events`);
    }
    await sleep(50);
  }
  await sleep(800);
}

describe.skipIf(!hasCdc)("native subscriptions on Neo4j CDC", () => {
  let driver: Driver;
  let cdc: InstanceType<typeof native.CDCReader>;
  let schema: GraphQLSchema;
  const run = (cypher: string, params: Record<string, unknown> = {}) =>
    driver.executeQuery(cypher, params);

  beforeAll(() => {
    driver = neo4j.driver(env.uri!, neo4j.auth.basic(env.user!, env.password!));
    cdc = new native.CDCReader({ driver, pollInterval: 50 });
    schema = native.makeSchema({
      client: createOrm(schemaModel, { driver }),
      config,
      subscriptions: cdc,
    });
  });
  afterAll(async () => {
    cdc?.close();
    await driver?.close();
  });
  beforeEach(async () => {
    await run("MATCH (n) WHERE n:NsUser OR n:NsPost OR n:NsTag DETACH DELETE n");
    await run(
      `CREATE (:NsUser {id: "u-alice", name: "Alice"}), (:NsUser {id: "u-bob", name: "Bob"}),
              (:NsTag {name: "db", internal: false}), (:NsTag {name: "secret", internal: true})`,
    );
  });

  it("never delivers a node the rules hide, on node changes and relationship events", async () => {
    const changes = `subscription { nsPostChanged { operation id node { id title published } } }`;
    const tagged = `subscription { nsPostTagsConnected { id relatedId node { title } related { name } } }`;
    const authored = `subscription { nsUserPostsConnected { id relatedId related { id title } } }`;
    const subscribers = { alice, bob, anonymous: {} as Ctx };
    const streams = Object.fromEntries(
      await Promise.all(
        Object.entries(subscribers).map(async ([who, ctx]) => [
          who,
          {
            changes: await open(schema, changes, ctx),
            tagged: await open(schema, tagged, ctx),
            authored: await open(schema, authored, ctx),
          },
        ]),
      ),
    ) as Record<keyof typeof subscribers, Record<"changes" | "tagged" | "authored", Stream>>;

    // Through the GraphQL API (Alice's mutation) and straight to the database.
    const created = await graphql({
      schema,
      source: `mutation { nsPostCreate(data: { id: "p-draft", title: "Alice draft", author: { connect: { id: "u-alice" } } }) { id } }`,
      contextValue: { ...alice },
    });
    expect(created.errors).toBeUndefined();
    await run(
      `MATCH (a:NsUser {id: "u-alice"}) CREATE (a)-[:NS_AUTHORED]->(:NsPost {id: "p-pub", title: "Alice public", published: true})`,
    );
    await run(
      `MATCH (p:NsPost {id: "p-draft"}), (t:NsTag {name: "db"}) CREATE (p)-[:NS_TAGGED]->(t)`,
    );
    await run(
      `MATCH (p:NsPost {id: "p-pub"}), (t:NsTag {name: "secret"}) CREATE (p)-[:NS_TAGGED]->(t)`,
    );
    await run(
      `MATCH (p:NsPost {id: "p-pub"}), (t:NsTag {name: "db"}) CREATE (p)-[:NS_TAGGED]->(t)`,
    );

    // Alice reads her draft: 2 creates, 2 tags (not the secret one), 2 authored relationships.
    await settle(streams.alice.changes, 2);
    await settle(streams.alice.tagged, 2);
    await settle(streams.alice.authored, 2);
    for (const who of ["bob", "anonymous"] as const) {
      await settle(streams[who].changes, 1);
      await settle(streams[who].tagged, 1);
      await settle(streams[who].authored, 1);
    }

    expect(streams.alice.changes.events).toEqual([
      {
        nsPostChanged: {
          operation: "CREATED",
          id: "p-draft",
          node: { id: "p-draft", title: "Alice draft", published: false },
        },
      },
      {
        nsPostChanged: {
          operation: "CREATED",
          id: "p-pub",
          node: { id: "p-pub", title: "Alice public", published: true },
        },
      },
    ]);
    expect(new Set(streams.alice.tagged.events.map((e) => JSON.stringify(e)))).toEqual(
      new Set(
        [
          {
            id: "p-draft",
            relatedId: "db",
            node: { title: "Alice draft" },
            related: { name: "db" },
          },
          {
            id: "p-pub",
            relatedId: "db",
            node: { title: "Alice public" },
            related: { name: "db" },
          },
        ].map((e) => JSON.stringify({ nsPostTagsConnected: e })),
      ),
    );
    for (const who of ["bob", "anonymous"] as const) {
      const s = streams[who];
      expect(s.changes.events).toEqual([
        {
          nsPostChanged: {
            operation: "CREATED",
            id: "p-pub",
            node: { id: "p-pub", title: "Alice public", published: true },
          },
        },
      ]);
      expect(s.tagged.events).toEqual([
        {
          nsPostTagsConnected: {
            id: "p-pub",
            relatedId: "db",
            node: { title: "Alice public" },
            related: { name: "db" },
          },
        },
      ]);
      // The user is readable, the draft at the other end of the relationship is not.
      expect(s.authored.events).toEqual([
        {
          nsUserPostsConnected: {
            id: "u-alice",
            relatedId: "p-pub",
            related: { id: "p-pub", title: "Alice public" },
          },
        },
      ]);
    }
    // Neither the draft nor the secret tag appear anywhere in their events.
    const leaked = JSON.stringify(
      [streams.bob, streams.anonymous].map((s) => [
        s.changes.events,
        s.tagged.events,
        s.authored.events,
      ]),
    );
    expect(leaked).not.toContain("p-draft");
    expect(leaked).not.toContain("secret");

    // Rules are applied to the re-read, now: once published, the draft is delivered to Bob.
    await run(`MATCH (p:NsPost {id: "p-draft"}) SET p.published = true, p.title = "Out now"`);
    await settle(streams.bob.changes, 2);
    expect(streams.bob.changes.events[1]).toEqual({
      nsPostChanged: {
        operation: "UPDATED",
        id: "p-draft",
        node: { id: "p-draft", title: "Out now", published: true },
      },
    });

    for (const s of Object.values(streams)) for (const x of Object.values(s)) await x.stop();
  });

  it("delivers DELETED for the nodes a restricted subscription delivered", async () => {
    await run(`CREATE (:NsPost {id: "p-old", title: "Old", published: true})`);
    await run(
      `MATCH (a:NsUser {id: "u-alice"}) CREATE (a)-[:NS_AUTHORED]->(:NsPost {id: "p-hidden", title: "Hidden"})`,
    );
    const posts = await open(
      schema,
      `subscription { nsPostChanged { operation id node { title } } }`,
      bob,
    );
    const users = await open(
      schema,
      `subscription { nsUserChanged { operation id node { name } } }`,
      bob,
    );

    await run(`CREATE (:NsPost {id: "p-new", title: "New", published: true})`);
    await settle(posts, 1);
    await run(`MATCH (p:NsPost) WHERE p.id IN ["p-new", "p-old", "p-hidden"] DETACH DELETE p`);
    await run(`MATCH (u:NsUser {id: "u-bob"}) DETACH DELETE u`);
    await settle(posts, 2);
    await settle(users, 1);

    // p-old was never delivered to this subscription, p-hidden is hidden from Bob: their keys
    // are not sent. NsUser has no read rule: Bob reads every user, so every delete is delivered.
    expect(posts.events).toEqual([
      { nsPostChanged: { operation: "CREATED", id: "p-new", node: { title: "New" } } },
      { nsPostChanged: { operation: "DELETED", id: "p-new", node: null } },
    ]);
    expect(users.events).toEqual([
      { nsUserChanged: { operation: "DELETED", id: "u-bob", node: null } },
    ]);
    await posts.stop();
    await users.stop();
  });

  it("reads changes through a Cyphra client, and close() ends the subscriptions", async () => {
    const db = createOrm(schemaModel, { driver });
    const reader = new native.CDCReader({ client: db, pollInterval: 50 });
    const own = native.makeSchema({ client: db, config, subscriptions: reader });
    const result = await subscribe({
      schema: own,
      document: parse(
        `subscription { nsTagChanged(where: { name: { startsWith: "g" } }, operations: [CREATED]) { operation id } }`,
      ),
      contextValue: {},
    });
    if (!(Symbol.asyncIterator in result)) throw new Error(JSON.stringify(result.errors));
    const iterator = result[Symbol.asyncIterator]();
    await run(
      `CREATE (:NsTag {name: "graphs", internal: false}), (:NsTag {name: "other", internal: false})`,
    );
    await run(`CREATE (:NsTag {name: "gossip", internal: true})`);
    const first = await iterator.next();
    expect(first.value).toEqual({ data: { nsTagChanged: { operation: "CREATED", id: "graphs" } } });
    reader.close();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it("fails with a clear error on a database without CDC", async () => {
    await driver.executeQuery(
      "CREATE DATABASE cyphranativenocdc IF NOT EXISTS WAIT",
      {},
      {
        database: "system",
      },
    );
    const reader = new native.CDCReader({ driver, database: "cyphranativenocdc" });
    const own = native.makeSchema({
      client: createOrm(schemaModel, { driver }),
      config,
      subscriptions: reader,
    });
    try {
      const result = await subscribe({
        schema: own,
        document: parse(`subscription { nsUserChanged { id } }`),
        contextValue: {},
      });
      expect(Symbol.asyncIterator in result).toBe(false);
      expect((result as ExecutionResult).errors?.[0]?.message).toContain(
        "GraphQL subscriptions need Neo4j Change Data Capture (CDC)",
      );
    } finally {
      reader.close();
    }
  });
});
