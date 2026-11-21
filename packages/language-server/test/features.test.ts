import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSchema, resolveSchema, SCALAR_TYPE_NAMES, validateSchema } from "@cyphra/schema";
import { describe, expect, it } from "vitest";
import {
  analyze,
  completionsAt,
  definitionAt,
  formatText,
  hoverAt,
  outline,
  referencesAt,
  renameEdits,
} from "../src/index.js";
import { BUILTIN_TYPES } from "../src/docs.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Text with a `|` cursor marker: returns the text without it and the cursor offset. */
function at(marked: string): { text: string; offset: number } {
  const offset = marked.indexOf("|");
  if (offset < 0) throw new Error("no cursor marker");
  return { text: marked.slice(0, offset) + marked.slice(offset + 1), offset };
}

function labels(marked: string): string[] {
  const { text, offset } = at(marked);
  return completionsAt(analyze(text), offset).map((c) => c.label);
}

/** What `cyphra validate` reports for a schema (parse, validate, resolve). */
function cliError(text: string): string | undefined {
  try {
    const doc = parseSchema(text);
    validateSchema(doc);
    resolveSchema(doc);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

/** The diagnostic's message and the source text it underlines. */
function problem(text: string): { message: string; underlined: string } | undefined {
  const p = analyze(text).problem;
  return p && { message: p.message, underlined: text.slice(p.span.start, p.span.end) };
}

const BASE = `enum Role { ADMIN USER }

node User {
  id    String @id @default(cuid())
  email String @unique
  bio   String?
  role  Role   @default(ADMIN)
  posts Post[] @relationship(type: "AUTHORED", direction: OUT)
}

node Post {
  id     String @id
  title  String
  tags   String[]
  author User?  @relationship(type: "AUTHORED", direction: IN)

  @@fulltext([title])
}

relationship Authored {
  type "AUTHORED"
  from User
  to Post
  since DateTime
}
`;

describe("diagnostics", () => {
  const fixtures = execSync("git ls-files '*.cyphra'", { cwd: repoRoot, encoding: "utf8" })
    .trim()
    .split("\n");

  it.each(fixtures)("reports no problem on %s", (file) => {
    expect(analyze(readFileSync(path.join(repoRoot, file), "utf8")).problem).toBeUndefined();
  });

  it("reports a syntax error at its position", () => {
    const text = "node User {\n  id String @id\n  = \n}\n";
    const p = analyze(text).problem!;
    expect(p.kind).toBe("syntax");
    expect(text.slice(p.span.start, p.span.end)).toBe("=");
  });

  const cases: [string, string, string][] = [
    ["unknown relation target", BASE.replace("posts Post[]", "posts Pots[]"), "Pots"],
    ["unknown type on a relationship", BASE.replace("since DateTime", "since Dat"), "Dat"],
    ["duplicate field", BASE.replace("  bio   String?", "  bio   String?\n  bio Int"), "bio"],
    ["@index with @unique", BASE.replace("@unique", "@unique @index"), "@index"],
    ["unknown decorator", BASE.replace("bio   String?", "bio   String? @foo"), "@foo"],
    ["bad default", BASE.replace("@default(ADMIN)", "@default(OWNER)"), "OWNER"],
    ["bad default function", BASE.replace("@default(cuid())", "@default(now())"), "now()"],
    ["literal of the wrong type", BASE.replace("bio   String?", 'bio   Int @default("x")'), '"x"'],
    ["fulltext field", BASE.replace("@@fulltext([title])", "@@fulltext([title, nope])"), "nope"],
    [
      "fulltext non-String field",
      BASE.replace("@@fulltext([title])", "@@fulltext([title, author])"),
      "author",
    ],
    [
      "fulltext analyzer",
      BASE.replace("@@fulltext([title])", '@@fulltext([title], analyzer: "klingon")'),
      '"klingon"',
    ],
    [
      "unknown model attribute",
      BASE.replace("@@fulltext([title])", "@@search([title])"),
      "@@search([title])",
    ],
    ["unique field", BASE.replace("@@fulltext([title])", "@@unique([title, nope])"), "nope"],
    [
      "unique on a relation",
      BASE.replace("@@fulltext([title])", "@@unique([title, author])"),
      "author",
    ],
    [
      "index needs two fields",
      BASE.replace("@@fulltext([title])", "@@index([title])"),
      "@@index([title])",
    ],
    [
      "duplicate @@unique",
      BASE.replace(
        "@@fulltext([title])",
        '@@unique([id, title], name: "a")\n  @@unique([title, id], name: "b")',
      ),
      '@@unique([title, id], name: "b")',
    ],
    [
      "@@unique key clashing with a field",
      BASE.replace("@@fulltext([title])", '@@unique([id, title], name: "tags")'),
      '"tags"',
    ],
    ["duplicate enum value", BASE.replace("ADMIN USER", "ADMIN USER ADMIN"), "ADMIN"],
    ["duplicate declaration", BASE + "\nnode User { id String @id }\n", "User"],
    ["unknown relationship end", BASE.replace("from User", "from Usr"), "Usr"],
    ["direction", BASE.replace("direction: IN", "direction: UP"), "UP"],
    [
      "missing relationship type",
      BASE.replace('@relationship(type: "AUTHORED", direction: IN)', ""),
      "User",
    ],
    ["vector dimensions", BASE.replace("bio   String?", "bio   Vector(0)"), "Vector"],
    ["two ids", BASE.replace("email String @unique", "email String @id"), "@id"],
    ["optional id", BASE.replace("id     String @id", "id     String? @id"), "String?"],
    [
      "vector index similarity",
      BASE.replace("bio   String?", "bio   Vector(3) @vectorIndex(similarity: dot)"),
      "dot",
    ],
    ["Json list", BASE.replace("bio   String?", "bio   Json[]"), "Json"],
  ];

  it.each(cases)("%s: same message as cyphra validate, exact range", (_name, text, underlined) => {
    const expected = cliError(text);
    expect(expected).toBeDefined();
    const p = problem(text);
    expect(p?.message).toBe(expected);
    // The second occurrence for duplicates.
    expect(p?.underlined).toBe(underlined);
  });

  it("points duplicates at the second occurrence", () => {
    const text = BASE.replace("ADMIN USER", "ADMIN USER ADMIN");
    const p = analyze(text).problem!;
    expect(p.span.start).toBe(text.lastIndexOf("ADMIN", text.indexOf("}")));
  });
});

describe("completion", () => {
  it("offers declaration keywords at the top level", () => {
    expect(labels("|")).toEqual(["node", "relationship", "enum"]);
    expect(labels(BASE + "\nno|")).toEqual(["node", "relationship", "enum"]);
    expect(labels("node |")).toEqual([]);
  });

  it("offers every built-in type, enums and node models after a field name", () => {
    const l = labels(BASE.replace("  bio   String?", "  bio   S|"));
    for (const t of SCALAR_TYPE_NAMES) expect(l).toContain(t);
    expect(l).toContain("Vector(N)");
    expect(l).toEqual(expect.arrayContaining(["Role", "User", "Post"]));
    expect(l).not.toContain("Authored");
  });

  it("offers no node models as relationship property types", () => {
    const l = labels(BASE.replace("  since DateTime", "  since |"));
    expect(l).toContain("DateTime");
    expect(l).toContain("Role");
    expect(l).not.toContain("User");
  });

  it("offers decorators that fit the field", () => {
    expect(labels(BASE.replace("bio   String?", "bio   String? @|"))).toEqual([
      "@id",
      "@unique",
      "@index",
      "@default",
    ]);
    expect(labels(BASE.replace("email String @unique", "email String @unique @|"))).not.toContain(
      "@unique",
    );
    expect(labels(BASE.replace("bio   String?", "bio   Post @|"))).toEqual(["@relationship"]);
    expect(labels(BASE.replace("bio   String?", "bio   Vector(3) @|"))).toEqual(["@vectorIndex"]);
    expect(labels(BASE.replace("since DateTime", "since DateTime @|"))).toEqual([
      "@unique",
      "@index",
      "@default",
    ]);
    // Without typing `@` first.
    expect(labels(BASE.replace("bio   String?", "bio   String? |"))).toContain("@unique");
  });

  it("offers decorator arguments and their values", () => {
    expect(
      labels(
        BASE.replace(
          'posts Post[] @relationship(type: "AUTHORED", direction: OUT)',
          "posts Post[] @relationship(|",
        ),
      ),
    ).toEqual(["type", "direction"]);
    expect(labels(BASE.replace("direction: OUT", "direction: |"))).toEqual(["OUT", "IN"]);
    expect(labels(BASE.replace('type: "AUTHORED", direction: OUT', 'type: "AUTHORED", |'))).toEqual(
      ["direction"],
    );
    expect(labels(BASE.replace('type: "AUTHORED", direction: OUT', "type: |"))).toEqual([
      '"AUTHORED"',
    ]);
    expect(
      labels(BASE.replace("bio   String?", "bio   Vector(3) @vectorIndex(similarity: |")),
    ).toEqual(["cosine", "euclidean"]);
  });

  it("offers defaults for the field type", () => {
    expect(labels(BASE.replace("bio   String?", "at DateTime @default(|"))).toEqual(["now()"]);
    expect(labels(BASE.replace("bio   String?", "bio String @default(|"))).toEqual([
      "cuid()",
      "uuid()",
    ]);
    expect(labels(BASE.replace("@default(ADMIN)", "@default(|)"))).toEqual(["ADMIN", "USER"]);
    expect(labels(BASE.replace("bio   String?", "ok Boolean @default(|"))).toEqual([
      "true",
      "false",
    ]);
  });

  it("offers String fields inside @@fulltext([…]) and its arguments", () => {
    expect(labels(BASE.replace("@@fulltext([title])", "@@fulltext([title, |])"))).toEqual([
      "id",
      "tags",
    ]);
    expect(labels(BASE.replace("@@fulltext([title])", "@@fulltext([title], |)"))).toEqual([
      "name",
      "analyzer",
      "eventuallyConsistent",
    ]);
    const analyzers = labels(
      BASE.replace("@@fulltext([title])", '@@fulltext([title], analyzer: "|'),
    );
    expect(analyzers).toContain("english");
    expect(labels(BASE.replace("@@fulltext([title])", "@@|"))).toEqual([
      "@@fulltext",
      "@@unique",
      "@@index",
    ]);
  });

  it("offers single-value scalar fields inside @@unique([…]) / @@index([…]) and name", () => {
    const withExtra = BASE.replace(
      "  tags   String[]\n",
      "  tags   String[]\n  views  Int\n  meta   Json?\n  emb    Vector(3)\n",
    );
    expect(labels(withExtra.replace("@@fulltext([title])", "@@unique([title, |])"))).toEqual([
      "id",
      "views",
    ]);
    expect(labels(withExtra.replace("@@fulltext([title])", "@@index([|])"))).toEqual([
      "id",
      "title",
      "views",
    ]);
    expect(labels(BASE.replace("@@fulltext([title])", "@@unique([id, title], |)"))).toEqual([
      "name",
    ]);
  });

  it("offers type / from / to and node names in relationship blocks", () => {
    expect(labels(BASE.replace("  from User\n", "  |\n"))).toEqual(["from"]);
    expect(labels(BASE.replace("from User", "from |"))).toEqual(["User", "Post"]);
  });

  it("works on text that does not parse yet", () => {
    const text = "enum Role { A }\nnode User {\n  id String @id\n  role |\n";
    expect(labels(text)).toContain("Role");
    expect(labels("node User {\n  x String @default(|")).toEqual(["cuid()", "uuid()"]);
  });

  it("offers nothing in comments and plain strings", () => {
    expect(labels("// node |")).toEqual([]);
    expect(labels(BASE.replace('type "AUTHORED"', 'type "AUT|HORED"'))).toEqual([]);
  });

  it("replaces the identifier being typed", () => {
    const { text, offset } = at(BASE.replace("  bio   String?", "  bio   Str|"));
    const c = completionsAt(analyze(text), offset).find((x) => x.label === "String")!;
    expect(text.slice(c.replace.start, c.replace.end)).toBe("Str");
  });
});

describe("hover", () => {
  const hover = (marked: string) => {
    const { text, offset } = at(marked);
    return hoverAt(analyze(text), offset)?.markdown;
  };

  it("documents built-in types and decorators", () => {
    expect(hover(BASE.replace("since DateTime", "since Date|Time"))).toContain("ZONED DATETIME");
    expect(hover(BASE.replace("@unique", "@uni|que"))).toContain("**@unique**");
    expect(hover(BASE.replace("direction: IN", "direc|tion: IN"))).toContain("`OUT`");
    expect(hover(BASE.replace("@@fulltext", "@@full|text"))).toContain("full-text index");
  });

  it("documents @@unique / @@index on hover", () => {
    const text = BASE.replace("@@fulltext([title])", "@@uni|que([id, title])");
    expect(hover(text)).toContain("composite uniqueness constraint");
    expect(hover(text)).toContain("#composite-constraints-and-indexes");
    expect(hover(BASE.replace("@@fulltext([title])", "@@ind|ex([id, title])"))).toContain(
      "composite range index",
    );
  });

  it("summarizes relation targets and enums", () => {
    const h = hover(BASE.replace("posts Post[]", "po|sts Post[]"))!;
    expect(h).toContain("Relation to many **Post** through `AUTHORED` (OUT)");
    expect(h).toContain("node Post {");
    expect(hover(BASE.replace("author User?", "author Us|er?"))).toContain("node User {");
    expect(hover(BASE.replace("role  Role", "role  Ro|le"))).toContain("enum Role { ADMIN USER }");
  });

  it("documents keywords", () => {
    expect(hover(BASE.replace("relationship Authored", "relation|ship Authored"))).toContain(
      "typed properties",
    );
  });
});

describe("definition, references and rename", () => {
  it("goes to model and enum declarations", () => {
    const { text, offset } = at(BASE.replace("author User?", "author Us|er?"));
    const def = definitionAt(analyze(text), offset)!;
    expect(def.start).toBe(text.indexOf("node User") + 5);
    expect(text.slice(def.start, def.end)).toBe("User");
  });

  it("goes from a @@fulltext field to the field", () => {
    const { text, offset } = at(BASE.replace("@@fulltext([title])", "@@fulltext([ti|tle])"));
    const def = definitionAt(analyze(text), offset)!;
    expect(def.start).toBe(text.indexOf("title  String"));
  });

  it("finds every reference, including from / to", () => {
    const { text, offset } = at(BASE.replace("node User", "node Us|er"));
    const refs = referencesAt(analyze(text), offset, true);
    expect(refs).toHaveLength(3);
    expect(refs.every((r) => text.slice(r.start, r.end) === "User")).toBe(true);
    expect(referencesAt(analyze(text), offset, false)).toHaveLength(2);
  });

  it("renames a model and an enum everywhere", () => {
    const apply = (text: string, spans: { start: number; end: number }[], name: string) =>
      [...spans]
        .sort((x, y) => y.start - x.start)
        .reduce((t, s) => t.slice(0, s.start) + name + t.slice(s.end), text);
    let { text, offset } = at(BASE.replace("posts Post[]", "posts Po|st[]"));
    let out = apply(text, renameEdits(analyze(text), offset, "Article", BUILTIN_TYPES)!, "Article");
    expect(analyze(out).problem).toBeUndefined();
    expect(out).toContain("node Article {");
    expect(out).toContain("to Article");
    expect(out).not.toMatch(/\bPost\b/);

    ({ text, offset } = at(BASE.replace("enum Role", "enum Ro|le")));
    out = apply(text, renameEdits(analyze(text), offset, "Level", BUILTIN_TYPES)!, "Level");
    expect(out).toContain("role  Level   @default(ADMIN)");
    expect(analyze(out).problem).toBeUndefined();
  });

  it("rejects invalid and taken names", () => {
    const { text, offset } = at(BASE.replace("node Post", "node Po|st"));
    const a = analyze(text);
    expect(() => renameEdits(a, offset, "1x", BUILTIN_TYPES)).toThrow(/not a valid name/);
    expect(() => renameEdits(a, offset, "String", BUILTIN_TYPES)).toThrow(/built-in/);
    expect(() => renameEdits(a, offset, "User", BUILTIN_TYPES)).toThrow(/already declared/);
    expect(renameEdits(a, text.indexOf("title"), "x", BUILTIN_TYPES)).toBeUndefined();
  });
});

describe("outline", () => {
  it("lists declarations with their fields, values and attributes", () => {
    const symbols = outline(analyze(BASE));
    expect(symbols.map((s) => `${s.kind} ${s.name}`)).toEqual([
      "enum Role",
      "node User",
      "node Post",
      "relationship Authored",
    ]);
    expect(symbols[0]!.children.map((c) => c.name)).toEqual(["ADMIN", "USER"]);
    expect(symbols[2]!.children.map((c) => c.name)).toEqual([
      "id",
      "title",
      "tags",
      "author",
      "@@fulltext",
    ]);
    expect(symbols[3]!.detail).toBe("User -[AUTHORED]-> Post");
  });

  it("still lists declarations when the text does not parse", () => {
    const symbols = outline(analyze("node User {\n  id String @\n}\n\nnode Post {\n"));
    expect(symbols.map((s) => s.name)).toEqual(["User", "Post"]);
  });
});

describe("formatting", () => {
  it("formats and keeps comments; leaves unparseable text alone", () => {
    expect(formatText("// c\nnode A { id String @id // key\n}")).toBe(
      "// c\nnode A {\n  id String @id // key\n}\n",
    );
    expect(formatText("node A {\n  id String @id\n}\n")).toBeUndefined();
    expect(formatText("node A {")).toBeUndefined();
  });
});
