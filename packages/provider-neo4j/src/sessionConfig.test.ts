import type { Driver } from "neo4j-driver";
import { describe, expect, it } from "vitest";
import { CyphraNeo4j } from "./adapter.js";
import { mergeSessionConfig } from "./sessionConfig.js";

const fakeDriver = {} as Driver;

describe("mergeSessionConfig", () => {
  it("uses adapter database when override omits it", () => {
    const adapter = new CyphraNeo4j({
      driver: fakeDriver,
      database: "neo4j",
    });
    expect(mergeSessionConfig(adapter, { fetchSize: 100 })).toEqual({
      fetchSize: 100,
      database: "neo4j",
    });
  });

  it("override database wins", () => {
    const adapter = new CyphraNeo4j({
      driver: fakeDriver,
      database: "neo4j",
    });
    expect(mergeSessionConfig(adapter, { database: "other" })).toEqual({ database: "other" });
  });

  it("omits database key when neither adapter nor override set it", () => {
    const adapter = new CyphraNeo4j({
      driver: fakeDriver,
    });
    expect(mergeSessionConfig(adapter, undefined)).toEqual({});
  });
});
