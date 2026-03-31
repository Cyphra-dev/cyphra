import { describe, expect, it } from "vitest";
import { usingPeriodicCommitClause } from "./periodicCommit.js";

describe("periodicCommit", () => {
  it("prefixes LOAD CSV batch size", () => {
    expect(usingPeriodicCommitClause(500)).toBe("USING PERIODIC COMMIT 500 ");
  });

  it("validates batch size", () => {
    expect(() => usingPeriodicCommitClause(0)).toThrow(/positive integer/);
    expect(() => usingPeriodicCommitClause(1.5)).toThrow(/positive integer/);
  });
});
