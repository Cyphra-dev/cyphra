import { describe, expect, it } from "vitest";
import { resolveUnderRoot } from "./paths.js";
import path from "node:path";

describe("resolveUnderRoot", () => {
  const root = path.resolve("/proj");

  it("resolves normal relative paths", () => {
    expect(resolveUnderRoot(root, "schema.cyphra")).toBe(path.join(root, "schema.cyphra"));
  });

  it("rejects path traversal", () => {
    expect(() => resolveUnderRoot(root, "../etc/passwd")).toThrow(/escapes/);
  });
});
