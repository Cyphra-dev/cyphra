import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SchemaDocument } from "./ast.js";
import { formatSchema } from "./formatSchema.js";
import { parseSchemaSyntax } from "./parseSchema.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Every `.cyphra` file tracked in the repository (examples and test fixtures). */
function fixtureSchemas(): string[] {
  return execSync("git ls-files '*.cyphra'", { cwd: repoRoot, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
}

function strip(doc: SchemaDocument): unknown {
  return JSON.parse(
    JSON.stringify(doc, (k, v) =>
      k === "comments" || k === "loc" || k.endsWith("Loc") || k.endsWith("Locs") ? undefined : v,
    ),
  );
}

describe("formatSchema", () => {
  const files = fixtureSchemas();

  it("finds the repository fixtures", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)("round-trips %s (same AST, same comments, idempotent)", (file) => {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    const out = formatSchema(source);
    const a = parseSchemaSyntax(source, { locations: true });
    const b = parseSchemaSyntax(out, { locations: true });
    expect(strip(b)).toEqual(strip(a));
    expect(b.comments?.map((c) => c.text.trimEnd())).toEqual(
      a.comments?.map((c) => c.text.trimEnd()),
    );
    expect(formatSchema(out)).toBe(out);
  });

  it("keeps comments, single blank lines and literals as written", () => {
    const source = `// header

// about users
node User { // header line
  id String @id // the id
  email   String @unique   @default("a // not a comment")


  posts Post[] @relationship(type: "X",
     // inside the decorator
     direction: OUT)
  @@fulltext([email]) // index
  score Float @default(1.50)
  // last
} // end
enum R { A, B // b
  C }
node Post { id String @id }
// eof
`;
    expect(formatSchema(source)).toBe(`// header

// about users
node User { // header line
  id    String @id // the id
  email String @unique @default("a // not a comment")

  posts Post[] @relationship(type: "X", direction: OUT) // inside the decorator
  score Float  @default(1.50)

  @@fulltext([email]) // index
  // last
} // end

enum R {
  A
  B // b
  C
}

node Post {
  id String @id
}

// eof
`);
  });

  it("formats relationships with their header lines first", () => {
    const out = formatSchema(`node A { id String @id }
relationship R { type "T" from A to A
  since DateTime @index
  note String? }`);
    expect(out).toContain(`relationship R {
  type "T"
  from A
  to A
  since DateTime @index
  note  String?
}`);
  });

  it("formats an empty document", () => {
    expect(formatSchema("")).toBe("");
    expect(formatSchema("// only a comment\n")).toBe("// only a comment\n");
  });

  it("throws a SyntaxError on text that does not parse", () => {
    expect(() => formatSchema("node {")).toThrow(/Expected/);
  });
});
