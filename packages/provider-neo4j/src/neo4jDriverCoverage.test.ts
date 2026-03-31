import { describe, expect, it } from "vitest";
import { NEO4J_DRIVER_ADAPTER_COVERAGE } from "./neo4jDriverCoverage.js";

describe("NEO4J_DRIVER_ADAPTER_COVERAGE", () => {
  it("has unique stable ids", () => {
    const ids = NEO4J_DRIVER_ADAPTER_COVERAGE.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("classifies every row", () => {
    const allowed = new Set(["first_class", "passthrough", "not_applicable"]);
    for (const row of NEO4J_DRIVER_ADAPTER_COVERAGE) {
      expect(allowed.has(row.support)).toBe(true);
    }
  });
});
