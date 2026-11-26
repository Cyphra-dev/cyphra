import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CyphraConfig } from "../config.js";
import { runGraphqlPrint } from "./graphqlPrint.js";

const SCHEMA = `node User {
  id           String @id
  email        String @unique
  passwordHash String
}
`;

describe("cyphra graphql print", () => {
  let dir: string;
  let config: CyphraConfig;
  let out: string[];
  let stdout: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cyphra-graphql-print-"));
    await writeFile(join(dir, "schema.cyphra"), SCHEMA);
    config = {
      schema: join(dir, "schema.cyphra"),
      migrations: join(dir, "migrations"),
      generate: join(dir, "cyphra.gen.ts"),
      runtimeImport: "cyphra",
    };
    out = [];
    stdout = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void out.push(String(m)));
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void out.push(String(m)));
    vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
      stdout.push(String(s));
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("prints the sorted SDL without a config", async () => {
    expect(await runGraphqlPrint(dir, config)).toBe(0);
    const sdl = stdout.join("");
    expect(sdl).toContain("userFindMany(");
    expect(sdl).toContain("passwordHash: String!");
  });

  it("reads graphql.config.ts (TypeScript), writes --out and checks it", async () => {
    await writeFile(
      join(dir, "graphql.config.ts"),
      `type Config = { models: Record<string, unknown> };
export const api: Config = { models: { User: { fields: { passwordHash: false } } } };
`,
    );
    expect(await runGraphqlPrint(dir, config, { out: "schema.graphql" })).toBe(0);
    const written = await readFile(join(dir, "schema.graphql"), "utf8");
    expect(written).not.toContain("passwordHash");
    expect(await runGraphqlPrint(dir, config, { check: true })).toBe(0);
    expect(out.at(-1)).toMatch(/up to date/);

    // A schema edit removing a field is a breaking change.
    await writeFile(config.schema, SCHEMA.replace("  email        String @unique\n", ""));
    expect(await runGraphqlPrint(dir, config, { check: true })).toBe(1);
    expect(out.join("\n")).toMatch(/BREAKING .*User\.email was removed/);
  });

  it("fails --check when the committed file is missing, and on unknown config keys", async () => {
    expect(await runGraphqlPrint(dir, config, { check: true })).toBe(1);
    await writeFile(join(dir, "api.mjs"), `export default { models: { Usr: {} } };\n`);
    await expect(runGraphqlPrint(dir, config, { config: "api.mjs" })).rejects.toThrow(
      /unknown model "Usr"/,
    );
  });
});
