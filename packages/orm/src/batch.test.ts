import type { CompiledCypher } from "@cyphra/query";
import type { CyphraClient } from "@cyphra/runtime";
import { describe, expect, it, vi } from "vitest";
import { runCompiledBatchWrite } from "./batch.js";

describe("runCompiledBatchWrite", () => {
  it("runs steps in order inside one write transaction", async () => {
    const order: string[] = [];
    const client = {
      withWriteTransaction: async (fn: (tx: unknown) => Promise<void>) => {
        order.push("tx-start");
        const tx = {};
        await fn(tx);
        order.push("tx-end");
      },
      runCompiledTx: vi.fn(async (_tx: unknown, c: CompiledCypher) => {
        order.push(c.text);
      }),
    } as unknown as CyphraClient;
    const a: CompiledCypher = { text: "RETURN 1", params: {} };
    const b: CompiledCypher = { text: "RETURN 2", params: {} };
    await runCompiledBatchWrite(client, [a, b]);
    expect(order).toEqual(["tx-start", "RETURN 1", "RETURN 2", "tx-end"]);
  });

  it("no-ops on empty list", async () => {
    const withWriteTransaction = vi.fn();
    const client = { withWriteTransaction } as unknown as CyphraClient;
    await runCompiledBatchWrite(client, []);
    expect(withWriteTransaction).not.toHaveBeenCalled();
  });
});
