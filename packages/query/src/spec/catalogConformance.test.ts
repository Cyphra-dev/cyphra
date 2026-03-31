import { describe, expect, it } from "vitest";
import { normalizeCypher } from "./normalizeCypher.js";
import { catalogEntries } from "./catalog/index.js";

describe("Cypher DSL conformance catalog", () => {
  for (const entry of catalogEntries) {
    if (entry.status === "implemented") {
      it(`${entry.id} — ${entry.manualSection}`, () => {
        const got = entry.compile();
        expect(normalizeCypher(got.text)).toBe(entry.expectedText);
        expect(got.params).toEqual(entry.expectedParams);
      });
    } else {
      it.skip(`${entry.id} — ${entry.manualSection} (pending DSL: ${entry.note})`, () => {
        expect.fail("Implement DSL then move row to implemented catalog");
      });
    }
  }
});
