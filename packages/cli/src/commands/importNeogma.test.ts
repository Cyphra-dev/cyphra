import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NEOGMA_NEXT_STEPS, runImportNeogma } from "./importNeogma.js";

const MODELS = `
import { Node, NodeEntity, PrimaryKey, Property, Relationship, Type } from "neogma";
import type { Related } from "neogma";

@Node({ label: "User" })
export class UserNode extends NodeEntity {
  @PrimaryKey(Type.String()) id!: string;
  @Property(Type.String({ format: "email" })) email!: string;
  @Property(Type.Integer({ minimum: 0 })) age!: number;
  @Relationship({ name: "PLACED", direction: "out", model: () => OrderNode })
  Orders!: Related<typeof OrderNode>;
  greet() {
    return "hi";
  }
}

@Node({ label: "Order" })
export class OrderNode extends NodeEntity {
  @PrimaryKey(Type.String()) id!: string;
}
`;

describe("cyphra import neogma", () => {
  let dir: string;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cyphra-import-neogma-"));
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void out.push(String(m)));
    vi.spyOn(console, "warn").mockImplementation((m: unknown) => void err.push(String(m)));
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void err.push(String(m)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes schema.cyphra, prints the report and the next steps", async () => {
    await writeFile(join(dir, "models.ts"), MODELS);
    expect(await runImportNeogma(dir, ["models.ts"])).toBe(0);
    const schema = await readFile(join(dir, "schema.cyphra"), "utf8");
    expect(schema).toMatch(/^\/\/ Imported from neogma models with `cyphra import neogma`\./);
    expect(schema).toContain("  email String @email\n  age Int @min(0)\n");
    expect(schema).toContain('  Orders Order[] @relationship(type: "PLACED", direction: OUT)');
    expect(out.join("\n")).toBe("Wrote schema.cyphra (2 node(s), 0 relationship model(s))");
    const report = err.join("\n");
    expect(report).toMatch(/User\s+method greet: instance method: not converted/);
    expect(report).toMatch(/User\.age\s+Integer: became Int/);
    expect(report).toContain(NEOGMA_NEXT_STEPS);
  }, 30_000);

  it("reads the model files of a folder, skipping tests and node_modules", async () => {
    await mkdir(join(dir, "src", "models"), { recursive: true });
    await mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await writeFile(join(dir, "src", "models", "user.ts"), MODELS);
    await writeFile(join(dir, "src", "models", "user.test.ts"), "this is not { valid");
    await writeFile(join(dir, "src", "util.ts"), "export const unrelated = (;");
    await writeFile(join(dir, "node_modules", "x", "neogma.ts"), "not valid (");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await runImportNeogma(dir, ["src"], { print: true })).toBe(0);
    expect(out).toEqual([]);
    expect(String(write.mock.calls[0]?.[0])).toContain("node Order {\n  id String @id\n}");
  }, 30_000);

  it("refuses to overwrite without --force, merges with --merge", async () => {
    await writeFile(join(dir, "models.ts"), MODELS);
    await writeFile(
      join(dir, "schema.cyphra"),
      "node User {\n  id String @id\n  nickname String?\n}\n",
    );
    expect(await runImportNeogma(dir, ["models.ts"])).toBe(1);
    expect(err.join("\n")).toContain("schema.cyphra already exists");
    expect(await runImportNeogma(dir, ["models.ts"], { merge: true })).toBe(0);
    const merged = await readFile(join(dir, "schema.cyphra"), "utf8");
    expect(merged).toContain("  nickname String?\n  email String @email\n");
    expect(merged).toContain("node Order {");
    expect(await runImportNeogma(dir, ["models.ts"], { merge: true, force: true })).toBe(1);
  }, 30_000);

  it("exits 1 on a syntax error, no model or a missing file", async () => {
    await writeFile(join(dir, "bad.ts"), "@Node({ label: 'A' })\nclass A {\n  x = ;\n}\n");
    expect(await runImportNeogma(dir, ["bad.ts"])).toBe(1);
    expect(err.join("\n")).toMatch(/^Cannot import the neogma models: bad\.ts:3:7: /);
    await writeFile(join(dir, "empty.ts"), "export const x = 1;\n");
    expect(await runImportNeogma(dir, ["empty.ts"])).toBe(1);
    expect(err.join("\n")).toContain("No neogma model found");
    expect(await runImportNeogma(dir, ["nope.ts"])).toBe(1);
    expect(err.join("\n")).toContain("Cannot read nope.ts.");
    await expect(readFile(join(dir, "schema.cyphra"), "utf8")).rejects.toThrow();
  }, 30_000);
});
