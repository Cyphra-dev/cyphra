import { describe, expect, it } from "vitest";
import { normalizeResult } from "../src/normalize.js";
import { seedStatements } from "../src/runner.js";

const now = Date.parse("2026-01-01T12:00:00Z");

describe("normalizeResult", () => {
  it("masks generated ids and recent datetimes, keeps seeded values", () => {
    const out = normalizeResult(
      {
        data: {
          a: {
            id: "0b6f8f7e-8d0c-4f43-9a51-2b0b2a6e7a11",
            seeded: "m-matrix",
            createdAt: "2026-01-01T11:59:59.123Z",
            old: "2024-01-10T09:00:00.000Z",
          },
        },
      },
      { ordered: true, now },
    );
    expect(out.data).toEqual({
      a: {
        id: "<generated-id>",
        seeded: "m-matrix",
        createdAt: "<generated-datetime>",
        old: "2024-01-10T09:00:00.000Z",
      },
    });
  });

  it("sorts arrays unless ordered", () => {
    const data = { xs: [{ n: "b" }, { n: "a" }] };
    expect(normalizeResult({ data }, { ordered: false, now }).data).toEqual({
      xs: [{ n: "a" }, { n: "b" }],
    });
    expect(normalizeResult({ data }, { ordered: true, now }).data).toEqual(data);
  });

  it("keeps the code and non-empty validation issues of errors", () => {
    const issue = { path: ["data", "title"], rule: "length" };
    const out = normalizeResult(
      {
        errors: [
          { message: "a", path: ["x"], extensions: { code: "BAD_USER_INPUT", issues: [issue] } },
          { message: "b", path: ["y"], extensions: { code: "BAD_USER_INPUT", issues: [] } },
        ] as never,
      },
      { ordered: true, now },
    );
    expect(out.errors).toEqual([
      { message: "a", path: ["x"], code: "BAD_USER_INPUT", issues: [issue] },
      { message: "b", path: ["y"], code: "BAD_USER_INPUT" },
    ]);
  });

  it("rounds floats", () => {
    const out = normalizeResult({ data: { avg: 7.359999999999999 } }, { ordered: true, now });
    expect(out.data).toEqual({ avg: 7.36 });
  });
});

describe("seedStatements", () => {
  it("splits on trailing semicolons and drops comment lines", () => {
    expect(seedStatements("// c\nCREATE (a);\nCREATE (b)\nCREATE (c);\n")).toEqual([
      "CREATE (a)",
      "CREATE (b)\nCREATE (c)",
    ]);
  });
});
