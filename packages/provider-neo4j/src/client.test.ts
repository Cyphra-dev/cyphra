import type { Driver, ManagedTransaction, Session } from "neo4j-driver";
import neo4j, { int } from "neo4j-driver";
import { describe, expect, it, vi } from "vitest";
import type { CompiledCypher } from "@cyphra/query";
import { select } from "@cyphra/query";
import { CyphraClient } from "./client.js";
import { CyphraNeo4j } from "./adapter.js";

describe("CyphraClient", () => {
  it("accepts CyphraNeo4j adapter", () => {
    const adapter = new CyphraNeo4j({
      uri: "bolt://localhost:7687",
      user: "neo4j",
      password: "test",
    });
    const c = new CyphraClient({ adapter });
    expect(c.neo4jAdapter).toBe(adapter);
    expect(c.rawDriver).toBe(adapter.driver);
    return c.close();
  });

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

  it("invokes onQuery after runCompiled with timing", async () => {
    const calls: Array<{ cypher: string; paramKeys: string[]; durationMs: number }> = [];
    const client = new CyphraClient({
      uri: "bolt://localhost:7687",
      user: "neo4j",
      password: "test",
      onQuery: (info) => {
        calls.push({
          cypher: info.cypher,
          paramKeys: [...info.paramKeys],
          durationMs: info.durationMs,
        });
      },
    });
    const session = {
      run: async () => Promise.resolve({ records: [] }),
    } as unknown as Session;
    const compiled: CompiledCypher = { text: "RETURN $p0", params: { p0: 1 } };
    await client.runCompiled(session, compiled);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cypher).toBe("RETURN $p0");
    expect(calls[0]!.paramKeys).toEqual(["p0"]);
    expect(calls[0]!.durationMs).toBeGreaterThanOrEqual(0);
    await client.close();
  });

  it("session() merges adapter database into SessionConfig", () => {
    const session = vi.fn(() => ({ close: vi.fn() }));
    const driver = { session } as unknown as Driver;
    const adapter = new CyphraNeo4j({ driver, database: "neo4j" });
    const client = new CyphraClient({ adapter });
    client.session();
    expect(session).toHaveBeenCalledWith({ database: "neo4j" });
    client.session({ database: "other" });
    expect(session).toHaveBeenLastCalledWith({ database: "other" });
  });

  it("sessionRead uses READ access mode", () => {
    const session = vi.fn(() => ({ close: vi.fn() }));
    const driver = { session } as unknown as Driver;
    const adapter = new CyphraNeo4j({ driver, database: "db1" });
    const client = new CyphraClient({ adapter });
    client.sessionRead();
    expect(session).toHaveBeenCalledWith({
      database: "db1",
      defaultAccessMode: neo4j.session.READ,
    });
  });

  it("sessionWrite uses WRITE access mode", () => {
    const session = vi.fn(() => ({ close: vi.fn() }));
    const driver = { session } as unknown as Driver;
    const adapter = new CyphraNeo4j({ driver });
    const client = new CyphraClient({ adapter });
    client.sessionWrite();
    expect(session).toHaveBeenCalledWith({
      defaultAccessMode: neo4j.session.WRITE,
    });
  });

  it("executeCompiledQuery calls driver.executeQuery with merged database", async () => {
    const executeQuery = vi.fn().mockResolvedValue({
      records: [],
      keys: [],
      summary: {},
    });
    const session = vi.fn(() => ({ close: vi.fn() }));
    const driver = { session, executeQuery } as unknown as Driver;
    const adapter = new CyphraNeo4j({ driver, database: "neo4j" });
    const client = new CyphraClient({ adapter });
    await client.executeCompiledQuery(
      { text: "RETURN $n AS n", params: { n: 1 } },
      { routing: neo4j.routing.READ },
    );
    expect(executeQuery).toHaveBeenCalledWith(
      "RETURN $n AS n",
      { n: int(1) },
      expect.objectContaining({ database: "neo4j", routing: neo4j.routing.READ }),
    );
  });

  it("runCompiled coerces LIMIT/SKIP params to Integer", async () => {
    const run = vi.fn().mockResolvedValue({ records: [] });
    const session = { run } as unknown as Session;
    const client = new CyphraClient({
      uri: "bolt://localhost:7687",
      user: "neo4j",
      password: "test",
    });
    const compiled: CompiledCypher = {
      text: "MATCH (n:Post) RETURN n LIMIT $p0",
      params: { p0: 1 },
    };
    await client.runCompiled(session, compiled);
    expect(run).toHaveBeenCalledTimes(1);
    const passedParams = run.mock.calls[0]![1] as Record<string, unknown>;
    expect(neo4j.isInt(passedParams.p0)).toBe(true);
    await client.close();
  });

  it("runCompiled passes transactionConfig to session.run", async () => {
    const run = vi.fn().mockResolvedValue({ records: [] });
    const session = { run } as unknown as Session;
    const client = new CyphraClient({
      uri: "bolt://localhost:7687",
      user: "neo4j",
      password: "test",
    });
    const compiled: CompiledCypher = { text: "RETURN 1", params: {} };
    await client.runCompiled(session, compiled, { transactionConfig: { timeout: 5000 } });
    expect(run).toHaveBeenCalledWith("RETURN 1", {}, { timeout: 5000 });
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
