import { describe, expect, it } from "vitest";
import {
  assertGraphProviderId,
  DEFAULT_GRAPH_PROVIDER,
  GRAPH_PROVIDER_META,
  isGraphProviderId,
} from "./provider.js";

describe("graph provider", () => {
  it("isGraphProviderId", () => {
    expect(isGraphProviderId("neo4j")).toBe(true);
    expect(isGraphProviderId("postgres")).toBe(false);
  });

  it("assertGraphProviderId accepts neo4j", () => {
    expect(assertGraphProviderId("neo4j")).toBe("neo4j");
  });

  it("assertGraphProviderId rejects unknown", () => {
    expect(() => assertGraphProviderId("unknown")).toThrow(/Unknown Cyphra graph provider/);
  });

  it("meta and default", () => {
    expect(DEFAULT_GRAPH_PROVIDER).toBe("neo4j");
    expect(GRAPH_PROVIDER_META.neo4j.queryDialect).toBe("cypher");
  });
});
