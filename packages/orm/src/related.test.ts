import type { CompiledCypher } from "@cyphra/query";
import type { CyphraClient } from "@cyphra/runtime";
import { describe, expect, it, vi } from "vitest";
import { queryRelatedNodes, queryShortestPath } from "./related.js";

describe("queryRelatedNodes", () => {
  it("compiles and runs queryRecords in a session", async () => {
    const rows = [{ b: { labels: ["Post"] } }];
    const queryRecords = vi.fn(async () => rows);
    const client = {
      withSession: async (fn: (s: unknown) => Promise<unknown>) => fn({}),
      queryRecords,
    } as unknown as CyphraClient;
    const out = await queryRelatedNodes(client, {
      fromLabel: "User",
      idField: "id",
      anchorId: "u1",
      relType: "WROTE",
      toLabel: "Post",
      maxHops: 2,
      direction: "OUT",
    });
    expect(out).toBe(rows);
    expect(queryRecords).toHaveBeenCalledTimes(1);
    const call0 = queryRecords.mock.calls[0] as unknown as [unknown, CompiledCypher];
    expect(call0[1].text).toContain("WROTE*1..2");
  });
});

describe("queryShortestPath", () => {
  it("uses queryRecord", async () => {
    const queryRecord = vi.fn(async () => ({ p: [] }));
    const client = {
      withSession: async (fn: (s: unknown) => Promise<unknown>) => fn({}),
      queryRecord,
    } as unknown as CyphraClient;
    const row = await queryShortestPath(client, {
      fromLabel: "User",
      fromIdField: "id",
      fromId: "a",
      toLabel: "User",
      toIdField: "id",
      toId: "b",
      relType: "KNOWS",
      maxHops: 5,
    });
    expect(row).toEqual({ p: [] });
    expect(queryRecord).toHaveBeenCalledTimes(1);
  });
});
