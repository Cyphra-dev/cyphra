import { describe, expect, it } from "vitest";
import type { Result } from "neo4j-driver";
import { toPlainRecord, toPlainRecords } from "./records.js";

describe("toPlainRecords", () => {
  it("maps driver records to plain objects", async () => {
    const fakeResult = Promise.resolve({
      records: [{ toObject: () => ({ n: 1 }) }, { toObject: () => ({ n: 2 }) }],
    }) as unknown as Result;
    await expect(toPlainRecords(fakeResult)).resolves.toEqual([{ n: 1 }, { n: 2 }]);
  });
});

describe("toPlainRecord", () => {
  it("returns first row or undefined", async () => {
    const empty = Promise.resolve({ records: [] }) as unknown as Result;
    await expect(toPlainRecord(empty)).resolves.toBeUndefined();

    const one = Promise.resolve({
      records: [{ toObject: () => ({ ok: true }) }],
    }) as unknown as Result;
    await expect(toPlainRecord(one)).resolves.toEqual({ ok: true });
  });
});
