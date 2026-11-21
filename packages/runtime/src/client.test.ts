import { describe, expect, it } from "vitest";
import type { ManagedTransaction, Session } from "neo4j-driver";
import type { CompiledCypher } from "@cyphra/query";
import { select } from "@cyphra/query";
import { CyphraClient, type CyphraClientOptions, type TransactionLike } from "./client.js";

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

  it("uses a supplied driver, forwards the database, and never closes it", async () => {
    const calls: string[] = [];
    const tx: TransactionLike = { run: async () => ({ records: [] }) };
    const session = {
      run: async () => ({ records: [] }),
      executeRead: async <T>(work: (tx: TransactionLike) => Promise<T> | T) => work(tx),
      executeWrite: async <T>(work: (tx: TransactionLike) => Promise<T> | T) => work(tx),
      close: async () => {
        calls.push("session.close");
      },
    };
    const driver = {
      session: (config?: { database?: string }) => {
        calls.push(`session(${config?.database})`);
        return session;
      },
      close: async () => {
        calls.push("driver.close");
      },
    };
    const c = new CyphraClient({ driver, database: "graph" });
    expect(c.rawDriver).toBe(driver);
    expect(await c.withReadTransaction(async () => 42)).toBe(42);
    await c.close();
    expect(calls).toEqual(["session(graph)", "session.close"]);
  });

  it("rejects mixing a driver with connection options at the type level", () => {
    const driver = { session: () => ({}) as never, close: async () => {} };
    // @ts-expect-error `driver` and `uri` are mutually exclusive
    const opts: CyphraClientOptions = { driver, uri: "bolt://x", user: "u", password: "p" };
    expect(opts.driver).toBe(driver);
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
