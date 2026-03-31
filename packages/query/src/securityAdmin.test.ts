import { describe, expect, it } from "vitest";
import {
  compileDenyAccessOnDatabase,
  compileGrantRole,
  compileRevokeRole,
} from "./securityAdmin.js";

describe("securityAdmin", () => {
  it("GRANT / REVOKE ROLE", () => {
    expect(compileGrantRole("reader", "alice")).toEqual({
      text: "GRANT ROLE reader TO alice",
      params: {},
    });
    expect(compileRevokeRole("reader", "alice")).toEqual({
      text: "REVOKE ROLE reader FROM alice",
      params: {},
    });
  });

  it("DENY ACCESS ON DATABASE", () => {
    expect(compileDenyAccessOnDatabase("neo4j", "guest")).toEqual({
      text: "DENY ACCESS ON DATABASE neo4j TO guest",
      params: {},
    });
  });

  it("rejects invalid identifiers", () => {
    expect(() => compileGrantRole("1role", "u")).toThrow(/invalid identifier/);
    expect(() => compileDenyAccessOnDatabase("neo4j", "bad-user")).toThrow(/invalid identifier/);
  });
});
