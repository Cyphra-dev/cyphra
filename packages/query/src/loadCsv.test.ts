import { describe, expect, it } from "vitest";
import { compileLoadCsvFrom } from "./loadCsv.js";

describe("compileLoadCsvFrom", () => {
  it("defaults to WITH HEADERS and csvUrl param", () => {
    const c = compileLoadCsvFrom("https://example.com/x.csv", "row");
    expect(c.text).toBe("LOAD CSV WITH HEADERS FROM $csvUrl AS row");
    expect(c.params).toEqual({ csvUrl: "https://example.com/x.csv" });
  });

  it("can omit WITH HEADERS", () => {
    const c = compileLoadCsvFrom("file:///import/lines.csv", "line", { withHeaders: false });
    expect(c.text).toBe("LOAD CSV FROM $csvUrl AS line");
  });

  it("supports custom url param key", () => {
    const c = compileLoadCsvFrom("/x", "row", { urlParamKey: "src" });
    expect(c.text).toBe("LOAD CSV WITH HEADERS FROM $src AS row");
    expect(c.params).toEqual({ src: "/x" });
  });

  it("adds allowlisted FIELDTERMINATOR", () => {
    const c = compileLoadCsvFrom("u", "row", { fieldTerminator: "semicolon" });
    expect(c.text).toBe("LOAD CSV WITH HEADERS FROM $csvUrl AS row FIELDTERMINATOR ';'");
  });

  it("rejects invalid identifiers", () => {
    expect(() => compileLoadCsvFrom("u", "1bad")).toThrow(/rowAlias/);
    expect(() => compileLoadCsvFrom("u", "row", { urlParamKey: "bad-key" })).toThrow(/urlParamKey/);
  });
});
