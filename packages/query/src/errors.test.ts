import { describe, expect, it } from "vitest";
import { CyphraQueryError } from "./errors.js";

describe("CyphraQueryError", () => {
  it("exposes code and message", () => {
    const e = new CyphraQueryError("TEST_CODE", "hello");
    expect(e.name).toBe("CyphraQueryError");
    expect(e.code).toBe("TEST_CODE");
    expect(e.message).toBe("hello");
    expect(e).toBeInstanceOf(Error);
  });
});
