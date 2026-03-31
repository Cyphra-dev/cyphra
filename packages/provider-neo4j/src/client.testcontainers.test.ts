import { cypher } from "@cyphra/query";
import { Neo4jContainer, type StartedNeo4jContainer } from "@testcontainers/neo4j";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CyphraClient } from "./client.js";

/**
 * Spawns a real Neo4j 5 container via Testcontainers. Requires Docker.
 *
 * Opt out: `CYPHRA_SKIP_TESTCONTAINERS=1 pnpm test`
 */
const skip = process.env.CYPHRA_SKIP_TESTCONTAINERS === "1";

describe.skipIf(skip)("CyphraClient + Testcontainers (Neo4j 5)", () => {
  let neo4j: StartedNeo4jContainer;

  beforeAll(async () => {
    neo4j = await new Neo4jContainer("neo4j:5-community").start();
  }, 240_000);

  afterAll(async () => {
    await neo4j?.stop();
  }, 120_000);

  it("runs parameterized Cypher", async () => {
    const client = new CyphraClient({
      uri: neo4j.getBoltUri(),
      user: neo4j.getUsername(),
      password: neo4j.getPassword(),
    });
    try {
      await client.withSession(async (session) => {
        const r = await client.runCompiled(session, cypher`RETURN ${42} AS n`);
        const n = r.records[0]?.get("n");
        const val = typeof n?.toNumber === "function" ? n.toNumber() : n;
        expect(val).toBe(42);
      });
    } finally {
      await client.close();
    }
  });

  it("shortestPath and graph read", async () => {
    const client = new CyphraClient({
      uri: neo4j.getBoltUri(),
      user: neo4j.getUsername(),
      password: neo4j.getPassword(),
    });
    try {
      await client.withWriteTransaction(async (tx) => {
        await client.runCompiledTx(
          tx,
          cypher`CREATE (a:CyphraTc { id: ${"a"} }) CREATE (b:CyphraTc { id: ${"b"} }) CREATE (a)-[:CyphraTcLink]->(b)`,
        );
      });
      await client.withSession(async (session) => {
        const rec = await client.queryRecord(
          session,
          cypher`
            MATCH p = shortestPath(
              (x:CyphraTc { id: ${"a"} })-[:CyphraTcLink*1..5]-(y:CyphraTc { id: ${"b"} })
            )
            RETURN p
          `,
        );
        expect(rec).toBeDefined();
        expect(rec!.p).toBeDefined();
      });
    } finally {
      await client.close();
    }
  });
});
