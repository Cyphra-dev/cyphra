import { describe, expect, it } from "vitest";
import { defineCyphraConfig } from "./cyphraUserConfig.js";

describe("defineCyphraConfig", () => {
  it("returns the same object", () => {
    const c = defineCyphraConfig({
      schema: "./s.cyphra",
      migrations: "./migrations",
      provider: "neo4j",
      targetNeo4j: "5",
    });
    expect(c.schema).toBe("./s.cyphra");
    expect(c.provider).toBe("neo4j");
  });

  it("accepts migrations as { path } and datasource", () => {
    const c = defineCyphraConfig({
      schema: "./s.cyphra",
      migrations: { path: "./m" },
      datasource: { provider: "neo4j", url: process.env.NEO4J_URI },
    });
    expect(c.migrations).toEqual({ path: "./m" });
    expect(c.datasource?.provider).toBe("neo4j");
  });
});
