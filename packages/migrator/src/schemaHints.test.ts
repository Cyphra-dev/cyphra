import { describe, expect, it } from "vitest";
import { parseSchema } from "@cyphra/schema";
import { schemaIntegrationHints } from "./schemaHints.js";

describe("schemaIntegrationHints", () => {
  it("mentions relationship models", () => {
    const doc = parseSchema(`
      node User { id String @id }
      relationship R { type "KNOWS" from User to User }
    `);
    const hints = schemaIntegrationHints(doc);
    expect(hints.some((h) => h.includes("KNOWS") && h.includes("R"))).toBe(true);
  });
});
