import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { organization } from "better-auth/plugins";
import type { CyphraClient } from "@cyphra/runtime";
import { cyphraAdapter } from "./index.js";

/** createSchema never touches the database, so a stub client is enough. */
const adapterFor = (options: Parameters<ReturnType<typeof cyphraAdapter>>[0]) =>
  cyphraAdapter({ client: {} as CyphraClient })(options);

describe("createSchema (npx @better-auth/cli generate)", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("returns the merged schema.cyphra with overwrite: true", async () => {
    dir = await mkdtemp(join(tmpdir(), "cyphra-better-auth-"));
    const file = join(dir, "schema.cyphra");
    await writeFile(
      file,
      `node User {
  id String @id
  teams Team[] @relationship(type: "IN_TEAM", direction: OUT)
}

node Team {
  id String @id
}
`,
    );
    const options = { plugins: [organization()] };
    const result = await adapterFor(options).createSchema!(options, file);
    expect(result).toMatchObject({ path: file, overwrite: true });
    expect(result.code).toContain('  teams Team[] @relationship(type: "IN_TEAM", direction: OUT)');
    expect(result.code).toContain("node Team {");
    expect(result.code).toContain("node Organization {");
    expect(result.code).toContain("  email String @unique");
    // The file itself is written by the Better Auth CLI, not by the adapter.
    expect(await readFile(file, "utf8")).not.toContain("Organization");
  });

  it("starts a new file when there is none", async () => {
    dir = await mkdtemp(join(tmpdir(), "cyphra-better-auth-"));
    const file = join(dir, "auth.cyphra");
    const result = await adapterFor({}).createSchema!({}, file);
    expect(result.path).toBe(file);
    expect(result.code).toMatch(/^\/\/ Better Auth models/);
    expect(result.code).toContain("node Verification {");
  });

  it("writes numberFields: float as Float", async () => {
    dir = await mkdtemp(join(tmpdir(), "cyphra-better-auth-"));
    const file = join(dir, "schema.cyphra");
    await writeFile(file, "node Wallet {\n  id String @id\n  balance Int\n}\n");
    const plugin = {
      id: "wallet",
      schema: { wallet: { fields: { balance: { type: "number", required: true } } } },
    } as const;
    const options = { plugins: [plugin] };
    const adapter = cyphraAdapter({
      client: {} as CyphraClient,
      numberFields: { wallet: { balance: "float" } },
    })(options);
    const result = await adapter.createSchema!(options, file);
    expect(result.code).toContain("  balance Float\n");
    expect(result.code).not.toContain("balance Int");
  });
});
