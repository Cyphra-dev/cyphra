import { describe, expect, it } from "vitest";
import { compileShowTransactions, compileTerminateTransactions } from "./transactionAdmin.js";

describe("transactionAdmin", () => {
  it("compileShowTransactions", () => {
    expect(compileShowTransactions()).toEqual({
      text: "SHOW TRANSACTIONS",
      params: {},
    });
  });

  it("compileTerminateTransactions with quoted ids", () => {
    expect(compileTerminateTransactions(["neo4j-transaction-1", "mydb-transaction-2"])).toEqual({
      text: 'TERMINATE TRANSACTIONS "neo4j-transaction-1", "mydb-transaction-2"',
      params: {},
    });
  });

  it("rejects empty and invalid ids", () => {
    expect(() => compileTerminateTransactions([])).toThrow(/at least one/);
    expect(() => compileTerminateTransactions(["bad id"])).toThrow(/invalid transaction id/);
  });
});
