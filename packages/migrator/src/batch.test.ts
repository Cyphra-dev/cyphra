import { describe, expect, it } from "vitest";
import { wrapInTransactions } from "./batch.js";

describe("wrapInTransactions", () => {
  it("wraps inner Cypher with CALL … IN TRANSACTIONS", () => {
    const out = wrapInTransactions("MATCH (n) RETURN n", 500);
    expect(out).toContain("CALL {");
    expect(out).toContain("MATCH (n) RETURN n");
    expect(out).toContain("IN TRANSACTIONS OF 500 ROWS");
  });

  it("rejects invalid batch size", () => {
    expect(() => wrapInTransactions("RETURN 1", 0)).toThrow(/batchSize/);
    expect(() => wrapInTransactions("RETURN 1", 1.5)).toThrow(/batchSize/);
  });
});
