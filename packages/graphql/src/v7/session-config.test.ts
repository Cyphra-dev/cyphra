import { CyphraClient, type DriverLike } from "@cyphra/runtime";
import { graphql } from "graphql";
import type { Driver, SessionConfig } from "neo4j-driver";
import { describe, expect, it } from "vitest";
import { makeSchema } from "./index.js";

const typeDefs = /* GraphQL */ `
  type Thing @node {
    id: ID!
    name: String
  }
  type Query {
    thingCount: Int! @cypher(statement: "MATCH (t:Thing) RETURN count(t) AS n", columnName: "n")
  }
  type Mutation {
    renameAll(name: String!): Int!
      @cypher(statement: "MATCH (t:Thing) SET t.name = $name RETURN count(t) AS n", columnName: "n")
  }
`;

/** A driver that records the configuration of every session it opens. */
function recordingDriver(): { driver: Driver; sessions: SessionConfig[] } {
  const sessions: SessionConfig[] = [];
  const tx = {
    run: async (cypher: string) => ({
      records: [{ get: () => (cypher.includes("count(") ? 0 : []) }],
    }),
  };
  const driver = {
    session: (config: SessionConfig) => {
      sessions.push(config);
      return {
        executeRead: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
        executeWrite: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
        close: async () => {},
      };
    },
  } as unknown as Driver;
  return { driver, sessions };
}

async function run(
  schema: ReturnType<typeof makeSchema>,
  source: string,
  contextValue: Record<string, unknown>,
) {
  return graphql({ schema, source, contextValue });
}

describe("context.sessionConfig (v7: spread over the session defaults per request)", () => {
  it("opens the sessions of every generated root field with the request's sessionConfig", async () => {
    const { driver, sessions } = recordingDriver();
    const schema = makeSchema({ typeDefs, driver });
    const sessionConfig = {
      database: "tenant1",
      impersonatedUser: "alice",
      auth: { scheme: "basic", principal: "bob", credentials: "pw" },
    };
    const operations = [
      "{ things { id } }",
      "{ thingsConnection { totalCount } }",
      "{ thingCount }",
      'mutation { createThings(input: [{ id: "t1" }]) { things { id } } }',
      'mutation { updateThings(update: { name_SET: "x" }) { info { nodesCreated } } }',
      "mutation { deleteThings { nodesDeleted } }",
      'mutation { renameAll(name: "x") }',
    ];
    // The fake answers do not fit every selection: only the sessions matter here.
    for (const source of operations) await run(schema, source, { sessionConfig });
    expect(sessions).toHaveLength(operations.length);
    for (const s of sessions) expect(s).toMatchObject(sessionConfig);
    expect(sessions.map((s) => s.defaultAccessMode)).toEqual([
      "READ",
      "READ",
      "READ",
      "WRITE",
      "WRITE",
      "WRITE",
      "WRITE",
    ]);
  });

  it("takes sessionConfig.database over the database passed to makeSchema", async () => {
    const { driver, sessions } = recordingDriver();
    const schema = makeSchema({ typeDefs, driver, database: "main" });
    await run(schema, "{ thingCount }", {});
    await run(schema, "{ thingCount }", { sessionConfig: { database: "tenant1" } });
    await run(schema, "{ thingCount }", { sessionConfig: { database: undefined } });
    await run(schema, "{ thingCount }", { sessionConfig: { impersonatedUser: "alice" } });
    expect(sessions.map((s) => [s.database, s.impersonatedUser])).toEqual([
      ["main", undefined],
      ["tenant1", undefined],
      ["main", undefined],
      ["main", "alice"],
    ]);
  });

  it("keeps the statement's access mode", async () => {
    const { driver, sessions } = recordingDriver();
    const schema = makeSchema({ typeDefs, driver });
    await run(schema, "{ thingCount }", { sessionConfig: { defaultAccessMode: "WRITE" } });
    expect(sessions[0]!.defaultAccessMode).toBe("READ");
  });

  it("rejects a sessionConfig that is not an object", async () => {
    const { driver, sessions } = recordingDriver();
    const schema = makeSchema({ typeDefs, driver });
    const result = await run(schema, "{ things { id } }", { sessionConfig: "tenant1" });
    expect(result.errors?.map((e) => e.message)).toEqual([
      "context.sessionConfig must be an object.",
    ]);
    expect(sessions).toEqual([]);
  });

  it("fails loudly with a CyphraClient instead of using the client's database", async () => {
    let opened = 0;
    const record = { get: () => 0, toObject: () => ({ value: 0 }) };
    const tx = { run: async () => ({ records: [record], summary: {} }) };
    const fake: DriverLike = {
      session: () => {
        opened++;
        return {
          run: tx.run,
          executeRead: async (work) => work(tx),
          executeWrite: async (work) => work(tx),
          close: async () => {},
        };
      },
      close: async () => {},
    };
    const schema = makeSchema({ typeDefs, client: new CyphraClient({ driver: fake }) });
    const rejected = await run(schema, "{ thingCount }", {
      sessionConfig: { database: "tenant1", impersonatedUser: "alice" },
    });
    expect(rejected.errors?.map((e) => e.message)).toEqual([
      "context.sessionConfig (database, impersonatedUser) needs makeSchema({ driver }): a CyphraClient runs every statement in its own sessions.",
    ]);
    const write = await run(schema, 'mutation { renameAll(name: "x") }', {
      sessionConfig: { database: "tenant1" },
    });
    expect(write.errors?.[0]?.message).toMatch(/^context\.sessionConfig \(database\) needs/);
    expect(opened).toBe(0);
    // Nothing set: the client's sessions are used.
    const allowed = await run(schema, "{ thingCount }", { sessionConfig: { database: undefined } });
    expect(allowed).toEqual({ data: { thingCount: 0 } });
  });
});
