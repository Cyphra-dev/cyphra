import type { CompiledCypher } from "@cyphra/query";
import type { CyphraClient } from "@cyphra/runtime";
import { describe, expect, it, vi } from "vitest";
import { runCreateLinkedNodes, runCreateLinkedNodesTx } from "./graphOps.js";

describe("graphOps", () => {
  it("runCreateLinkedNodesTx runs compiled linked create", async () => {
    let seen: CompiledCypher | undefined;
    const tx = {} as Parameters<Parameters<CyphraClient["withWriteTransaction"]>[0]>[0];
    const client = {
      runCompiledTx: vi.fn(async (_tx: unknown, c: CompiledCypher) => {
        seen = c;
      }),
    } as unknown as CyphraClient;
    await runCreateLinkedNodesTx(client, tx, {
      primary: { label: "Post", alias: "p", props: { id: "1" }, serverTimestamp: "createdAt" },
    });
    expect(client.runCompiledTx).toHaveBeenCalledWith(tx, expect.any(Object));
    expect(seen?.text).toContain("p.createdAt = datetime()");
  });

  it("runCreateLinkedNodes wraps withWriteTransaction", async () => {
    const runCompiledTx = vi.fn();
    const client = {
      withWriteTransaction: async (fn: (tx: unknown) => Promise<void>) => {
        await fn({});
      },
      runCompiledTx,
    } as unknown as CyphraClient;
    await runCreateLinkedNodes(client, {
      primary: { label: "N", alias: "n", props: { x: 1 } },
    });
    expect(runCompiledTx).toHaveBeenCalledTimes(1);
  });
});
