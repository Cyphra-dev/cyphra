import { describe, expect, it } from "vitest";
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
});
