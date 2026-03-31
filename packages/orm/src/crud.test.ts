import { parseSchema } from "@cyphra/schema";
import { describe, expect, it } from "vitest";
import { createNodeCrud } from "./crud.js";

const sample = `
node Post {
  id String @id
  slug String @unique
  title String
}
`;

describe("createNodeCrud", () => {
  it("throws for unknown node", () => {
    const doc = parseSchema(sample);
    const fake = { withSession: async () => {} } as never;
    expect(() => createNodeCrud(fake, doc, "Nope")).toThrow(/unknown node/);
  });

  it("throws when where uses non-unique field", async () => {
    const doc = parseSchema(sample);
    const fake = { withSession: async () => {} } as never;
    const crud = createNodeCrud(fake, doc, "Post");
    await expect(crud.findUnique({ title: "x" })).rejects.toThrow(/@id or @unique/);
  });
});
