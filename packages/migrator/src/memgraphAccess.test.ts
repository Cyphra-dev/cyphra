import { describe, expect, it, vi } from "vitest";
import { isMemgraphStorageAccessError, withMemgraphStorageAccess } from "./memgraphAccess.js";

const accessError = (kind: string) =>
  Object.assign(
    new Error(
      `Cannot get ${kind} access to the storage. Try stopping other parallel queries. Note: Periodic snapshots also hold storage access.`,
    ),
    { code: "Memgraph.TransientError.MemgraphError.MemgraphError" },
  );

describe("Memgraph storage access on DDL", () => {
  it("recognises the unique and read-only access errors only", () => {
    expect(isMemgraphStorageAccessError(accessError("unique"))).toBe(true);
    expect(isMemgraphStorageAccessError(accessError("read-only"))).toBe(true);
    expect(
      isMemgraphStorageAccessError(
        Object.assign(new Error("Cannot resolve conflicting transactions."), {
          code: "Memgraph.TransientError.MemgraphError.MemgraphError",
        }),
      ),
    ).toBe(false);
    expect(isMemgraphStorageAccessError(new Error("Cannot get unique access to the storage"))).toBe(
      false,
    );
    expect(isMemgraphStorageAccessError(null)).toBe(false);
  });

  it("runs the statement again with exponential backoff until it gets access", async () => {
    const sleeps: number[] = [];
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(accessError("unique"))
      .mockRejectedValueOnce(accessError("unique"))
      .mockRejectedValueOnce(accessError("read-only"))
      .mockResolvedValue("done");
    const out = await withMemgraphStorageAccess(run, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(out).toBe("done");
    expect(run).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it("raises other errors at once", async () => {
    const run = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("syntax"));
    await expect(withMemgraphStorageAccess(run, { sleep: async () => {} })).rejects.toThrow(
      "syntax",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("gives up with the last error after the timeout, with delays capped at 2 s", async () => {
    const sleeps: number[] = [];
    const run = vi.fn<() => Promise<void>>().mockRejectedValue(accessError("unique"));
    await expect(
      withMemgraphStorageAccess(run, {
        timeoutMs: 6_000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).rejects.toThrow(/unique access/);
    expect(sleeps).toEqual([100, 200, 400, 800, 1600, 2000]);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(6_000);
  });
});
