import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * TypeScript modules the CLI imports (`graphql.config.ts`, `--typedefs typeDefs.ts`) that import
 * siblings NodeNext style (`./rules.js` for `rules.ts`), #308. This runs the built CLI (`dist/`)
 * in a child process: under vitest, Vite would resolve `.js` to `.ts` itself.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "../dist/index.js");

type CliResult = { code: number; stdout: string; stderr: string };

function cli(cwd: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env: { PATH: process.env.PATH ?? "", TMPDIR: tmpdir() } },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe("TypeScript modules with .js specifiers (#308)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cyphra-ts-modules-"));
    await writeFile(
      path.join(dir, "cyphra.json"),
      JSON.stringify({ schema: "schema.cyphra", migrations: "migrations" }),
    );
    await writeFile(
      path.join(dir, "schema.cyphra"),
      "node User {\n  id           String @id\n  email        String @unique\n  passwordHash String\n}\n",
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads graphql.config.ts importing ./rules.js (rules.ts)", async () => {
    await writeFile(
      path.join(dir, "graphql.config.ts"),
      `import { rules } from "./rules.js";
import { Hidden } from "./nested/hidden.mjs";
export default { models: { User: { fields: { ...rules, [Hidden.Field]: false } } } };
`,
    );
    await writeFile(
      path.join(dir, "rules.ts"),
      `type Toggles = Record<string, boolean>;
export const rules: Toggles = { passwordHash: false };
`,
    );
    await mkdir(path.join(dir, "nested"));
    // An enum: TypeScript syntax Node's type stripping alone refuses.
    await writeFile(
      path.join(dir, "nested", "hidden.mts"),
      `export enum Hidden { Field = "email" }\n`,
    );
    const res = await cli(dir, ["graphql", "print"]);
    expect(res.stderr).toBe("");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("type User {");
    expect(res.stdout).not.toContain("passwordHash");
    expect(res.stdout).not.toMatch(/type User \{[^}]*email/);
    // Nothing is written next to the modules.
    expect((await readdir(dir)).sort()).toEqual([
      "cyphra.json",
      "graphql.config.ts",
      "nested",
      "rules.ts",
      "schema.cyphra",
    ]);
  });

  it("loads a typeDefs module importing ./types.js (types.ts)", async () => {
    await writeFile(
      path.join(dir, "typeDefs.ts"),
      `import { user } from "./types.js";
export const typeDefs: string = user;
`,
    );
    await writeFile(
      path.join(dir, "types.ts"),
      "export const user: string = `type User @node @authentication { id: ID! @id name: String }`;\n",
    );
    const res = await cli(dir, ["graphql", "migrate-rules", "typeDefs.ts"]);
    expect(res.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("defineGraphQL");
  });

  it("still fails on a sibling that does not exist", async () => {
    await writeFile(
      path.join(dir, "graphql.config.ts"),
      `import { rules } from "./missing.js";\nexport default { models: { User: { fields: rules } } };\n`,
    );
    const res = await cli(dir, ["graphql", "print"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/missing\.js/);
  });
});
