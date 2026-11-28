import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRISMA_NEXT_STEPS, runImportPrisma } from "./importPrisma.js";

const PRISMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id    String @id @default(cuid())
  email String @unique
  posts Post[]
}

model Post {
  id       String @id @default(cuid())
  title    String
  price    Decimal
  author   User   @relation(fields: [authorId], references: [id], onDelete: Cascade)
  authorId String
  tags     Tag[]
}

model Tag {
  id    String @id
  posts Post[]
}
`;

describe("cyphra import prisma", () => {
  let dir: string;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cyphra-import-prisma-"));
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
    await writeFile(join(dir, "schema.prisma"), PRISMA);
    expect(await runImportPrisma(dir, ["schema.prisma"])).toBe(0);
    const schema = await readFile(join(dir, "schema.cyphra"), "utf8");
    expect(schema).toMatch(/^\/\/ Imported from a Prisma schema with `cyphra import prisma`\./);
    expect(schema).toContain("posts Post[] @out(HAS_POSTS, onDelete: Cascade)");
    expect(schema).toContain("// authorId String (foreign key of author: replaced by the edge)");
    expect(out.join("\n")).toBe("Wrote schema.cyphra (3 node(s), 0 relationship model(s))");
    const report = err.join("\n");
    expect(report).toContain("Converted with differences (2):");
    expect(report).toMatch(/Post\.price\s+Decimal: became Float/);
    expect(report).toContain("Ignored (no effect on the graph) (1):");
    expect(report).toContain(PRISMA_NEXT_STEPS);
  });

  it("reads a multi-file schema folder", async () => {
    await mkdir(join(dir, "prisma", "schema", "models"), { recursive: true });
    await writeFile(join(dir, "prisma", "schema", "schema.prisma"), "enum Role {\n  A\n  B\n}\n");
    await writeFile(
      join(dir, "prisma", "schema", "models", "user.prisma"),
      "model User {\n  id String @id\n  role Role\n}\n",
    );
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await runImportPrisma(dir, ["prisma/schema"], { print: true })).toBe(0);
    expect(out).toEqual([]);
    expect(String(write.mock.calls[0]?.[0])).toContain(
      "node User {\n  id String @id\n  role Role\n}",
    );
  });

  it("refuses to overwrite without --force, merges with --merge", async () => {
    await writeFile(join(dir, "schema.prisma"), PRISMA);
    await writeFile(
      join(dir, "schema.cyphra"),
      "node User {\n  id String @id\n  nickname String?\n}\n",
    );
    expect(await runImportPrisma(dir, ["schema.prisma"])).toBe(1);
    expect(err.join("\n")).toContain("schema.cyphra already exists");
    expect(await runImportPrisma(dir, ["schema.prisma"], { merge: true })).toBe(0);
    const merged = await readFile(join(dir, "schema.cyphra"), "utf8");
    expect(merged).toContain("  nickname String?\n  email String @unique\n");
    expect(merged).toContain("node Post {");
    expect(await runImportPrisma(dir, ["schema.prisma"], { merge: true, force: true })).toBe(1);
    expect(await runImportPrisma(dir, ["schema.prisma"], { force: true, out: "x.cyphra" })).toBe(0);
  });

  it("exits 1 on an invalid schema or a missing file", async () => {
    await writeFile(join(dir, "bad.prisma"), "model A {\n  id String @id(\n}\n");
    expect(await runImportPrisma(dir, ["bad.prisma"])).toBe(1);
    expect(err.join("\n")).toMatch(/^Invalid Prisma schema: bad\.prisma:3:1:/);
    expect(await runImportPrisma(dir, ["nope.prisma"])).toBe(1);
    expect(err.join("\n")).toContain("Cannot read nope.prisma.");
    await expect(readFile(join(dir, "schema.cyphra"), "utf8")).rejects.toThrow();
  });
});
