import { cypher } from "@cyphra/query";
import { describe, expect, it, vi } from "vitest";
import { CyphraClient } from "./client.js";
import { hasTestDb, testConnection } from "./orm/__fixtures__/testDialect.js";

// Each test makes many round trips to Neo4j: the default 5 s is too tight on a busy CI runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hasNeo = hasTestDb;

describe.skipIf(!hasNeo)("CyphraClient integration", () => {
  it("runs a parameterized query", async () => {
    const client = new CyphraClient(testConnection());
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
});
