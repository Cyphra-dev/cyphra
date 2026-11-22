import { describe, expect, it } from "vitest";
import { connectionEnv, connectionFromEnv, hasTestDatabase } from "../src/index.js";

describe("connectionFromEnv", () => {
  it("reads Neo4j and Memgraph settings", () => {
    const env = {
      NEO4J_TEST_URI: "bolt://127.0.0.1:7687",
      NEO4J_TEST_USER: "neo4j",
      NEO4J_TEST_PASSWORD: "secret-password",
    };
    expect(connectionFromEnv(env)).toEqual({
      dialect: "neo4j",
      uri: "bolt://127.0.0.1:7687",
      user: "neo4j",
      password: "secret-password",
    });
    expect(connectionFromEnv({ ...env, CYPHRA_TEST_DIALECT: "memgraph" })?.dialect).toBe(
      "memgraph",
    );
    expect(connectionFromEnv({ NEO4J_TEST_URI: "bolt://x" })).toBeUndefined();
    expect(hasTestDatabase({})).toBe(false);
  });

  it("reads FalkorDB settings", () => {
    expect(
      connectionFromEnv({ CYPHRA_TEST_DIALECT: "falkordb", FALKORDB_TEST_URL: "redis://h:1" }),
    ).toEqual({ dialect: "falkordb", falkordb: { url: "redis://h:1", graph: "cyphra_test" } });
    expect(connectionFromEnv({ CYPHRA_TEST_DIALECT: "falkordb" })).toBeUndefined();
  });

  it("rejects an unknown dialect", () => {
    expect(() => connectionFromEnv({ CYPHRA_TEST_DIALECT: "postgres" })).toThrow();
  });

  it("round-trips through connectionEnv", () => {
    for (const connection of [
      {
        dialect: "memgraph" as const,
        uri: "bolt://h:1",
        user: "u",
        password: "p",
        database: "d",
      },
      { dialect: "falkordb" as const, falkordb: { url: "redis://h:2", graph: "g" } },
    ]) {
      expect(connectionFromEnv(connectionEnv(connection))).toEqual(connection);
    }
  });
});
