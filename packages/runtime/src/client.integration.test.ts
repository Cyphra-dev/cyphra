import { cypher } from "@cyphra/query";
import { describe, expect, it } from "vitest";
import { CyphraClient } from "./client.js";

const hasNeo = Boolean(
  process.env.NEO4J_TEST_URI && process.env.NEO4J_TEST_USER && process.env.NEO4J_TEST_PASSWORD,
);

describe.skipIf(!hasNeo)("CyphraClient integration", () => {
  it("runs a parameterized query", async () => {
    const client = new CyphraClient({
      uri: process.env.NEO4J_TEST_URI!,
      user: process.env.NEO4J_TEST_USER!,
      password: process.env.NEO4J_TEST_PASSWORD!,
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
});
