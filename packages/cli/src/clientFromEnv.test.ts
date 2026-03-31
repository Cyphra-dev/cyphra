import { afterEach, describe, expect, it, vi } from "vitest";
import { clientFromEnv } from "./clientFromEnv.js";

describe("clientFromEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists only missing variables when some are set", () => {
    vi.stubEnv("NEO4J_URI", "bolt://localhost:7687");
    vi.stubEnv("NEO4J_USER", "");
    vi.stubEnv("NEO4J_PASSWORD", "secret");
    let msg = "";
    try {
      clientFromEnv();
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toBe("Missing Neo4j environment variable(s): NEO4J_USER.");
  });

  it("lists multiple missing variables", () => {
    vi.stubEnv("NEO4J_URI", "");
    vi.stubEnv("NEO4J_USER", "");
    vi.stubEnv("NEO4J_PASSWORD", "");
    let msg = "";
    try {
      clientFromEnv();
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toBe(
      "Missing Neo4j environment variable(s): NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD.",
    );
  });

  it("returns a client when all required vars are set", async () => {
    vi.stubEnv("NEO4J_URI", "bolt://localhost:7687");
    vi.stubEnv("NEO4J_USER", "neo4j");
    vi.stubEnv("NEO4J_PASSWORD", "x");
    vi.stubEnv("NEO4J_DATABASE", "neo4j");
    const c = clientFromEnv();
    expect(c).toBeDefined();
    await c.close();
  });
});
