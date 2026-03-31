import { describe, expect, it } from "vitest";
import { compileShowAdmin } from "./showAdmin.js";

describe("compileShowAdmin", () => {
  it("emits whitelisted SHOW commands", () => {
    expect(compileShowAdmin("CONSTRAINTS")).toEqual({
      text: "SHOW CONSTRAINTS",
      params: {},
    });
    expect(compileShowAdmin("INDEXES")).toEqual({ text: "SHOW INDEXES", params: {} });
    expect(compileShowAdmin("DATABASES")).toEqual({ text: "SHOW DATABASES", params: {} });
    expect(compileShowAdmin("USERS")).toEqual({ text: "SHOW USERS", params: {} });
    expect(compileShowAdmin("ROLES")).toEqual({ text: "SHOW ROLES", params: {} });
    expect(compileShowAdmin("CURRENT_USER")).toEqual({
      text: "SHOW CURRENT USER",
      params: {},
    });
  });
});
