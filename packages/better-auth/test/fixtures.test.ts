import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseSchema, renderCyphraGenSource } from "@cyphra/schema";
import { authSchema, mergeAuthSchema } from "../src/index.js";

const dir = new URL("./fixtures/", import.meta.url);
const read = (name: string) => readFile(new URL(name, dir), "utf8");

/**
 * `app.cyphra` is what `npx @better-auth/cli generate` writes over `app.before.cyphra`, and
 * `app.gen.ts` is `cyphra generate` on it. Run with UPDATE_FIXTURES=1 to rewrite them.
 */
describe("generated fixtures", () => {
  it("are in sync with the adapter and the generator", async () => {
    const merged = mergeAuthSchema(await read("app.before.cyphra"), authSchema({}).document);
    const gen = renderCyphraGenSource(parseSchema(merged), { runtimeImport: "@cyphra/runtime" });
    if (process.env.UPDATE_FIXTURES) {
      await writeFile(new URL("app.cyphra", dir), merged);
      await writeFile(new URL("app.gen.ts", dir), gen);
    }
    expect(await read("app.cyphra")).toBe(merged);
    expect(await read("app.gen.ts")).toBe(gen);
  });
});
