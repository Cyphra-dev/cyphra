import { describe, expect, it } from "vitest";
import type { ManagedTransaction, Session } from "neo4j-driver";
import type { CompiledCypher } from "@cyphra/query";
import { select } from "@cyphra/query";
import { CyphraClient } from "./client.js";

describe("CyphraClient", () => {
  it("is constructible (driver connects lazily on first use)", () => {
    const c = new CyphraClient({
      uri: "bolt://localhost:7687",
      user: "neo4j",
      password: "test",
    });
    expect(c.rawDriver).toBeDefined();
    return c.close();
  });

  it("accepts neo4j driver Config", () => {
    const c = new CyphraClient({
      uri: "bolt://localhost:7687",
      user: "neo4j",
      password: "test",
      driverConfig: { connectionAcquisitionTimeout: 60_000 },
    });
    expect(c.rawDriver).toBeDefined();
    return c.close();
  });

  it("queryRecords maps driver rows to plain objects", async () => {
    const client = new CyphraClient({
      uri: "bolt://localhost:7687",
      user: "neo4j",
      password: "test",
    });
    const session = {
      run: async () =>
        Promise.resolve({
          records: [{ toObject: () => ({ n: 1 }) }, { toObject: () => ({ n: 2 }) }],
        }),
    } as unknown as Session;
    const compiled: CompiledCypher = { text: "RETURN 1", params: {} };
    await expect(client.queryRecords(session, compiled)).resolves.toEqual([{ n: 1 }, { n: 2 }]);
    await client.close();
  });

  it("selectRecords uses SelectQuery.toCypher", async () => {
    const client = new CyphraClient({
      uri: "bolt://localhost:7687",
      user: "neo4j",
      password: "test",
    });
    const q = select().match("(u:U)").returnStar();
    let seenText = "";
    const session = {
      run: async (text: string) => {
        seenText = text;
        return Promise.resolve({ records: [] });
      },
    } as unknown as Session;
    await client.selectRecords(session, q);
    expect(seenText).toBe(q.toCypher().text);
    await client.close();
  });

  it("runCompiledTx delegates to transaction.run", async () => {
    const client = new CyphraClient({
      uri: "bolt://localhost:7687",
      user: "neo4j",
      password: "test",
    });
    const compiled: CompiledCypher = { text: "RETURN 1 AS n", params: {} };
    const tx = {
      run: async (text: string, params: Record<string, unknown>) => {
        expect(text).toBe(compiled.text);
        expect(params).toEqual({});
        return Promise.resolve({ records: [] });
      },
    } as unknown as ManagedTransaction;
    await client.runCompiledTx(tx, compiled);
    await client.close();
  });

  it("queryRecordsTx maps rows like queryRecords", async () => {
    const client = new CyphraClient({
      uri: "bolt://localhost:7687",
      user: "neo4j",
      password: "test",
    });
    const tx = {
      run: async () =>
        Promise.resolve({
          records: [{ toObject: () => ({ k: "v" }) }],
        }),
    } as unknown as ManagedTransaction;
    const compiled: CompiledCypher = { text: "RETURN 1", params: {} };
    await expect(client.queryRecordsTx(tx, compiled)).resolves.toEqual([{ k: "v" }]);
    await client.close();
  });
});
