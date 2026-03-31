import type { CompiledCypher } from "@cyphra/query";
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

  it("create returns created row even when id is not provided", async () => {
    const doc = parseSchema(sample);
    const queryRecord = async (_session: unknown, compiled: CompiledCypher) => ({
      n: { id: "generated-id", slug: "s-1", title: "Hello", _query: compiled.text },
    });
    const runCompiled = async () => ({ records: [] });
    const client = {
      withSession: async (fn: (session: unknown) => Promise<unknown>) => fn({}),
      queryRecord,
      runCompiled,
    } as never;

    const crud = createNodeCrud(client, doc, "Post");
    const row = await crud.create({ slug: "s-1", title: "Hello" });

    expect(row).toEqual({
      n: {
        id: "generated-id",
        slug: "s-1",
        title: "Hello",
        _query: "CREATE (n:Post) SET n += $props RETURN n AS n",
      },
    });
  });
});
