import { parse, subscribe, type ExecutionResult } from "graphql";
import neo4j, { type Driver } from "neo4j-driver";
import { describe, expect, it, vi } from "vitest";
import { compat, CDCSubscriptionsEngine } from "../../index.js";
import { readTypeDefs } from "../model.js";
import { matchesWhere } from "./filter.js";

const typeDefs = /* GraphQL */ `
  type Movie @node @subscription {
    title: String!
    released: Int
    tags: [String!]
    available: Boolean
    owner: String
  }
  type Secret
    @node
    @subscription(events: [CREATED])
    @authentication(operations: [SUBSCRIBE])
    @subscriptionsAuthorization(filter: [{ where: { node: { owner: { eq: "$jwt.sub" } } } }]) {
    owner: String!
  }
  type Plain @node {
    name: String
  }
`;

type Change = {
  operation: "c" | "u" | "d";
  labels: string[];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  eventType?: "n" | "r";
};

/** A driver answering `db.cdc.current()` / `db.cdc.query()` from a list of pending changes. */
function cdcDriver(opts: { unavailable?: boolean } = {}) {
  let seq = 0;
  const pending: Change[] = [];
  const queries: { cypher: string; params: Record<string, unknown> }[] = [];
  const record = (o: Record<string, unknown>) => ({ toObject: () => o });
  const driver = {
    executeQuery: async (cypher: string, params: Record<string, unknown>) => {
      queries.push({ cypher, params });
      if (opts.unavailable) {
        throw new Error("There is no procedure with the name `db.cdc.current` registered");
      }
      if (cypher.includes("db.cdc.current")) return { records: [record({ id: `id-${seq}` })] };
      const changes = pending.splice(0);
      return {
        records: changes.map((c) =>
          record({
            id: `id-${++seq}`,
            event: {
              eventType: c.eventType ?? "n",
              operation: c.operation,
              labels: c.labels,
              elementId: `e${seq}`,
              state: {
                before: c.before ? { properties: c.before } : null,
                after: c.after ? { properties: c.after } : null,
              },
            },
            metadata: {
              txStartTime: neo4j.types.DateTime.fromStandardDate(new Date(1_000_000)),
            },
          }),
        ),
      };
    },
    session: () => ({ close: async () => {} }),
  } as unknown as Driver;
  return { driver, pending, queries };
}

async function open(
  schema: ReturnType<typeof compat.v7.makeSchema>,
  document: string,
  contextValue: Record<string, unknown> = {},
) {
  const result = await subscribe({ schema, document: parse(document), contextValue });
  if (!(Symbol.asyncIterator in result)) return { errors: (result as ExecutionResult).errors };
  return { iterator: result[Symbol.asyncIterator]() };
}

const next = async (it: AsyncIterator<unknown>, ms = 500) =>
  Promise.race([
    it.next().then((r) => (r.done ? "done" : r.value)),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), ms)),
  ]);

describe("subscriptions (CDC engine, fake database)", () => {
  it("publishes create / update / delete events of the subscribed type, filtered by where", async () => {
    const { driver, pending } = cdcDriver();
    const engine = new CDCSubscriptionsEngine({ driver, pollTime: 5 });
    const schema = compat.v7.makeSchema({ typeDefs, driver, features: { subscriptions: engine } });
    const created = await open(
      schema,
      `subscription { movieCreated(where: { released: { gte: 2000 } }) { event timestamp createdMovie { title released } } }`,
    );
    const updated = await open(
      schema,
      `subscription { movieUpdated { previousState { title } updatedMovie { title } } }`,
    );
    pending.push(
      { operation: "c", labels: ["Movie"], after: { title: "Old", released: neo4j.int(1990) } },
      { operation: "c", labels: ["Plain"], after: { name: "x" } },
      { operation: "c", labels: ["Movie", "Extra"], after: { title: "Extra", released: 2020 } },
      { operation: "c", labels: ["Movie"], after: { title: "New", released: neo4j.int(2020) } },
      { operation: "u", labels: ["Movie"], before: { title: "A" }, after: { title: "B" } },
      { operation: "u", labels: ["Movie"], before: { title: "Same" }, after: { title: "Same" } },
      { operation: "c", labels: ["Movie"], eventType: "r" },
    );
    expect(await next(created.iterator!)).toEqual({
      data: {
        movieCreated: {
          event: "CREATE",
          timestamp: 1_000_000,
          createdMovie: { title: "New", released: 2020 },
        },
      },
    });
    expect(await next(updated.iterator!)).toEqual({
      data: { movieUpdated: { previousState: { title: "A" }, updatedMovie: { title: "B" } } },
    });
    // The no-op update, the relationship change and the other types are not published.
    expect(await next(updated.iterator!, 100)).toBe("timeout");
    expect(await next(created.iterator!, 50)).toBe("timeout");
    engine.close();
    expect(await next(created.iterator!)).toBe("done");
  });

  it("polls only while a subscription is open", async () => {
    const { driver, queries } = cdcDriver();
    const engine = new CDCSubscriptionsEngine({ driver, pollTime: 5 });
    const schema = compat.v7.makeSchema({ typeDefs, driver, features: { subscriptions: engine } });
    await new Promise((r) => setTimeout(r, 30));
    expect(queries).toHaveLength(0);
    const { iterator } = await open(schema, `subscription { movieDeleted { event } }`);
    await new Promise((r) => setTimeout(r, 30));
    expect(queries.some((q) => q.cypher.includes("db.cdc.query"))).toBe(true);
    const selectors = queries.find((q) => q.cypher.includes("db.cdc.query"))!.params.selectors;
    // The shared CDC reader's selectors: one per label, sorted.
    expect(selectors).toEqual([
      { select: "n", labels: ["Movie"] },
      { select: "n", labels: ["Plain"] },
      { select: "n", labels: ["Secret"] },
    ]);
    await iterator!.return!();
    await new Promise((r) => setTimeout(r, 20));
    const count = queries.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(queries.length).toBe(count);
    engine.close();
  });

  it("onlyGraphQLEvents selects on the transaction metadata of @cyphra/graphql", async () => {
    const { driver, queries } = cdcDriver();
    const schema = compat.v7.makeSchema({
      typeDefs,
      driver,
      features: { subscriptions: { pollTime: 5, onlyGraphQLEvents: true } },
    });
    const { iterator } = await open(schema, `subscription { movieDeleted { event } }`);
    await new Promise((r) => setTimeout(r, 30));
    const q = queries.find((x) => x.cypher.includes("db.cdc.query"))!;
    expect((q.params.selectors as unknown[])[0]).toEqual({
      select: "n",
      labels: ["Movie"],
      txMetadata: { app: "@cyphra/graphql" },
    });
    await iterator!.return!();
  });

  it("fails with a clear error when the database has no CDC", async () => {
    const { driver } = cdcDriver({ unavailable: true });
    const schema = compat.v7.makeSchema({ typeDefs, driver, features: { subscriptions: true } });
    const { errors } = await open(schema, `subscription { movieCreated { event } }`);
    expect(errors?.[0]?.message).toMatch(
      /GraphQL subscriptions need Neo4j Change Data Capture \(CDC\): Neo4j Enterprise Edition or Aura.*txLogEnrichment 'FULL'.*no procedure/,
    );
  });

  it("fails with a clear error when subscriptions are not enabled", async () => {
    const { driver } = cdcDriver();
    const schema = compat.v7.makeSchema({ typeDefs, driver });
    expect(schema.getSubscriptionType()?.getFields().movieCreated).toBeDefined();
    const { errors } = await open(schema, `subscription { movieCreated { event } }`);
    expect(errors?.[0]?.message).toMatch(
      /Subscriptions are not enabled: pass features.subscriptions/,
    );
  });

  it("refuses dialects without CDC", () => {
    const client = { dialect: "memgraph" } as never;
    expect(() =>
      compat.v7.makeSchema({ typeDefs, client, features: { subscriptions: true } }),
    ).toThrow(/dialect "memgraph" does not have/);
    expect(() => new CDCSubscriptionsEngine({ client })).toThrow(/dialect "memgraph"/);
  });

  it("@authentication(SUBSCRIBE) and @subscriptionsAuthorization (token in connectionParams)", async () => {
    const { driver, pending } = cdcDriver();
    const engine = new CDCSubscriptionsEngine({ driver, pollTime: 5 });
    const schema = compat.v7.makeSchema({
      typeDefs,
      driver,
      features: { subscriptions: engine, authorization: { key: "a-test-key-not-a-secret" } },
    });
    const doc = `subscription { secretCreated { createdSecret { owner } } }`;
    expect((await open(schema, doc)).errors?.[0]?.message).toBe("Unauthenticated");
    const { iterator } = await open(schema, doc, { jwt: { sub: "alice" } });
    pending.push(
      { operation: "c", labels: ["Secret"], after: { owner: "bob" } },
      { operation: "c", labels: ["Secret"], after: { owner: "alice" } },
    );
    expect(await next(iterator!)).toEqual({
      data: { secretCreated: { createdSecret: { owner: "alice" } } },
    });
    engine.close();
  });

  it("warns that @authorization does not filter events, like v7", () => {
    const { driver } = cdcDriver();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    compat.v7.makeSchema({
      typeDefs: `type A @node @subscription @authorization(filter: [{ where: { node: { id: { eq: "$jwt.sub" } } } }]) { id: ID! }`,
      driver,
      features: { subscriptions: true },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("'@subscriptionsAuthorization' not found"),
    );
    warn.mockRestore();
  });

  it("rejects invalid @subscription / @subscriptionsAuthorization arguments", () => {
    expect(() => readTypeDefs(`type A @node @subscription(events: [CREATE]) { id: ID }`)).toThrow(
      /invalid event CREATE/,
    );
    expect(() =>
      readTypeDefs(
        `type A @node @subscriptionsAuthorization(filter: [{ where: { node: { nope: { eq: 1 } } } }]) { id: ID }`,
      ),
    ).toThrow(/nope is not a field/);
  });
});

describe("matchesWhere", () => {
  const node = readTypeDefs(`
    type M @node {
      title: String
      n: Int
      big: BigInt
      on: Date
      at: DateTime
      tags: [String!]
      ok: Boolean
    }
  `).node("M");
  const payload = {
    title: "The Matrix",
    n: 0,
    big: "9007199254740993",
    on: neo4j.types.Date.fromStandardDate(new Date("1999-03-31T00:00:00Z")),
    at: new neo4j.types.DateTime(2020, 1, 1, 20, 0, 0, 0, 0),
    tags: ["a", "b"],
    ok: false,
  };
  const m = (where: Record<string, unknown>) => matchesWhere(node, where, payload);

  it("generic and legacy operators", () => {
    expect(m({ title: { startsWith: "The", contains: "Mat", endsWith: "rix" } })).toBe(true);
    expect(m({ title_STARTS_WITH: "Matrix" })).toBe(false);
    expect(m({ title: { in: ["x", "The Matrix"] } })).toBe(true);
    expect(m({ tags: { includes: "b" } })).toBe(true);
    expect(m({ tags: { eq: ["a", "b"] } })).toBe(true);
    expect(m({ tags_INCLUDES: "c" })).toBe(false);
  });

  it("falsy values match (v7 skips them)", () => {
    expect(m({ n: { eq: 0 } })).toBe(true);
    expect(m({ ok: { eq: false } })).toBe(true);
    expect(m({ missing: { eq: null } })).toBe(false);
  });

  it("BigInt, Date and DateTime compare by value", () => {
    expect(m({ big: { gt: neo4j.int("9007199254740992") } })).toBe(true);
    expect(
      m({ on: { lt: neo4j.types.Date.fromStandardDate(new Date("2000-01-01T00:00:00Z")) } }),
    ).toBe(true);
    expect(m({ at: { eq: "2020-01-01T20:00:00.000Z" } })).toBe(true);
    expect(m({ at: { gt: "2020-01-02T00:00:00Z" } })).toBe(false);
  });

  it("AND / OR / NOT", () => {
    expect(m({ OR: [{ n: { gt: 5 } }, { title: { eq: "The Matrix" } }] })).toBe(true);
    expect(m({ AND: [{ n: { gt: 5 } }, { title: { eq: "The Matrix" } }] })).toBe(false);
    expect(m({ NOT: { title: { eq: "The Matrix" } } })).toBe(false);
  });
});
