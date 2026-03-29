import { describe, expect, it } from "vitest";
import type { Session } from "neo4j-driver";
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
});
