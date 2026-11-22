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
    ["onDelete rule", BASE.replace("direction: IN)", "direction: IN, onDelete: Drop)"), "Drop"],
    [
      "unknown @relationship argument",
      BASE.replace("direction: IN)", "direction: IN, ondelete: Cascade)"),
      "ondelete",
    ],
    [
      "@relationship argument given twice",
      BASE.replace("direction: IN)", "direction: IN, onDelete: Cascade, onDelete: Restrict)"),
      "Restrict",
    ],
    // Validation rules.
    ["rule on the wrong type", BASE.replace("bio   String?", "bio   Int @length(1)"), "@length(1)"],
    ["rule bounds", BASE.replace("bio   String?", "bio   String @length(5, 2)"), "5"],
    ["rule argument type", BASE.replace("bio   String?", "bio   Int @min(1.5)"), "1.5"],
    [
      "regex that does not compile",
      BASE.replace("bio   String?", 'bio   String @regex("(")'),
      '"("',
    ],
    ["regex flags", BASE.replace("bio   String?", 'bio   String @regex("a", flags: "g")'), '"g"'],
    [
      "unknown rule argument",
      BASE.replace("bio   String?", "bio   String @length(least: 1)"),
      "least",
    ],
    ["too many positional arguments", BASE.replace("bio   String?", "bio   Int @min(1, 2)"), "2"],
    [
      "extra positional argument",
      BASE.replace("bio   String?", "bio   String @length(1, 2, 3)"),
      "3",
    ],
    ["min above max", BASE.replace("bio   String?", "bio   Int @min(5) @max(1)"), "@max(1)"],
    ["rule given twice", BASE.replace("bio   String?", "bio   String @email @email"), "@email"],
    [
      "default breaking a rule",
      BASE.replace("bio   String?", 'bio   String @length(3) @default("a")'),
      '"a"',
    ],
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
    expect(labels("|")).toEqual(["node", "interface", "relationship", "enum"]);
    expect(labels(BASE + "\nno|")).toEqual(["node", "interface", "relationship", "enum"]);
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
      "@length",
      "@email",
      "@url",
      "@regex",
      "@nonEmpty",
    ]);
    // Validation rules only where they fit the type.
    expect(labels(BASE.replace("bio   String?", "bio   Int? @|"))).toEqual([
      "@id",
      "@unique",
      "@index",
      "@default",
      "@min",
      "@max",
    ]);
    expect(labels(BASE.replace("bio   String?", "bio   Int[] @|"))).toEqual([
      "@id",
      "@unique",
      "@index",
      "@default",
      "@size",
      "@nonEmpty",
    ]);
    expect(labels(BASE.replace("bio   String?", "bio   Role @|"))).not.toContain("@length");
    expect(labels(BASE.replace("email String @unique", "email String @unique @|"))).not.toContain(
      "@unique",
    );
    expect(labels(BASE.replace("bio   String?", "bio   Post @|"))).toEqual(["@relationship"]);
    expect(labels(BASE.replace("bio   String?", "bio   Vector(3) @|"))).toEqual(["@vectorIndex"]);
    expect(labels(BASE.replace("since DateTime", "since DateTime @|"))).toEqual([
      "@unique",
      "@index",
      "@default",
      "@min",
      "@max",
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
    ).toEqual(["type", "direction", "onDelete"]);
    expect(labels(BASE.replace("direction: OUT", "direction: |"))).toEqual(["OUT", "IN"]);
    expect(labels(BASE.replace("direction: OUT", "direction: OUT, onDelete: |"))).toEqual([
      "Cascade",
      "Restrict",
      "SetNull",
    ]);
    expect(labels(BASE.replace('type: "AUTHORED", direction: OUT', 'type: "AUTHORED", |'))).toEqual(
      ["direction", "onDelete"],
    );
    expect(labels(BASE.replace('type: "AUTHORED", direction: OUT', "type: |"))).toEqual([
      '"AUTHORED"',
    ]);
    expect(
      labels(BASE.replace("bio   String?", "bio   Vector(3) @vectorIndex(similarity: |")),
    ).toEqual(["cosine", "euclidean"]);
    expect(labels(BASE.replace("bio   String?", "bio   String? @length(|"))).toEqual([
      "min",
      "max",
    ]);
    expect(labels(BASE.replace("bio   String?", 'bio   String? @regex("a", |'))).toEqual([
      "pattern",
      "flags",
    ]);
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
    expect(hover(BASE.replace("direction: OUT)", "direction: OUT, onDel|ete: Cascade)"))).toContain(
      "`Restrict` refuses",
    );
    expect(hover(BASE.replace("@@fulltext", "@@full|text"))).toContain("full-text index");
    const rule = hover(BASE.replace("bio   String?", "bio   String? @len|gth(1, 3)"));
    expect(rule).toContain("**@length**");
    expect(rule).toContain("Unicode code points");
    expect(rule).toContain("#validation-rules");
    expect(hover(BASE.replace("bio   String?", "bio   Int? @mi|n(0)"))).toContain("`increment`");
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
    expect(h).toContain("On delete: **SetNull**");
    expect(
      hover(
        BASE.replace("posts Post[]", "po|sts Post[]").replace(
          "direction: OUT)",
          "direction: OUT, onDelete: Cascade)",
        ),
      ),
    ).toContain("On delete: **Cascade** (deleting a User deletes its Post nodes)");
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

const IFACE = `interface Person {
  id      String  @id @default(cuid())
  email   String  @unique
  name    String
  manager Person? @relationship(type: "MANAGES", direction: IN)
}

interface Archivable {}

node Employee implements Person, Archivable {
  salary Int
  team   Team? @relationship(type: "MEMBER_OF", direction: OUT)

  @@index([name, salary])
}

node Team {
  id    String  @id
  owner Person? @relationship(type: "OWNS", direction: IN)
}
`;

describe("interfaces", () => {
  const hover = (marked: string) => {
    const { text, offset } = at(marked);
    return hoverAt(analyze(text), offset)?.markdown;
  };

  it("analyzes interfaces without problems", () => {
    expect(analyze(IFACE).problem).toBeUndefined();
  });

  it("scans the implements clause, also while the text does not parse", () => {
    const a = analyze(IFACE.replace("salary Int", "salary @"));
    const e = a.scanned.find((d) => d.name === "Employee")!;
    expect(e.kind).toBe("node");
    expect(e.open).toBeGreaterThan(0);
    expect(e.implements.map((t) => t.text)).toEqual(["Person", "Archivable"]);
    expect(a.scanned.find((d) => d.name === "Person")!.kind).toBe("interface");
    expect(outline(a).map((s) => `${s.kind} ${s.name}`)).toEqual([
      "interface Person",
      "interface Archivable",
      "node Employee",
      "node Team",
    ]);
  });

  it("offers implements after a node name, then interface names", () => {
    expect(labels(IFACE + "\nnode Customer |")).toEqual(["implements"]);
    expect(labels(IFACE + "\nnode Customer implements |")).toEqual(["Person", "Archivable"]);
    expect(labels(IFACE + "\nnode Customer implements Person, A|")).toEqual(["Archivable"]);
    expect(labels(IFACE + "\nnode Customer implements Person |")).toEqual([]);
  });

  it("offers interfaces as relation targets and inherited fields in @@index([…])", () => {
    const l = labels(IFACE.replace("  salary Int", "  salary Int\n  boss |"));
    expect(l).toEqual(expect.arrayContaining(["Person", "Employee", "Team"]));
    expect(labels(IFACE.replace("@@index([name, salary])", "@@index([|])"))).toEqual([
      "id",
      "email",
      "name",
      "salary",
    ]);
    expect(labels(IFACE.replace("@@index([name, salary])", "@@fulltext([|])"))).toEqual([
      "id",
      "email",
      "name",
    ]);
  });

  it("goes to, finds and renames interfaces named by implements", () => {
    const { text, offset } = at(IFACE.replace("implements Person", "implements Per|son"));
    const a = analyze(text);
    const def = definitionAt(a, offset)!;
    expect(def.start).toBe(text.indexOf("interface Person") + "interface ".length);
    expect(referencesAt(a, offset, false)).toHaveLength(3);
    const edits = renameEdits(a, offset, "Human", BUILTIN_TYPES)!;
    const out = [...edits]
      .sort((x, y) => y.start - x.start)
      .reduce((t, s) => t.slice(0, s.start) + "Human" + t.slice(s.end), text);
    expect(out).toContain("node Employee implements Human, Archivable {");
    expect(analyze(out).problem).toBeUndefined();
  });

  it("documents interface and implements keywords and interface fields", () => {
    expect(hover(IFACE.replace("interface Person", "inter|face Person"))).toContain(
      "abstract node model",
    );
    expect(hover(IFACE.replace("implements Person", "imple|ments Person"))).toContain(
      "inherits the fields",
    );
    expect(hover(IFACE.replace("  email   String", "  em|ail   String"))).toContain(
      "Field of interface **Person**",
    );
    const symbols = outline(analyze(IFACE));
    expect(symbols[2]!.detail).toBe("implements Person, Archivable");
  });

  it.each([
    [IFACE.replace("Person, Archivable", "Person, Team"), "Team"],
    [IFACE.replace("Person, Archivable", "Person, Person"), "Person"],
    [IFACE.replace("  salary Int", "  name String"), "name"],
    [
      IFACE.replace("interface Archivable {}", "interface Archivable implements Person {}"),
      "Person",
    ],
  ])("points implements errors at the name they are about (%#)", (text, underlined) => {
    const p = problem(text)!;
    expect(p.message).toBe(cliError(text));
    expect(p.underlined).toBe(underlined);
  });

  it("points a duplicated interface at its second occurrence", () => {
    const text = IFACE.replace("Person, Archivable", "Person, Person");
    const p = analyze(text).problem!;
    expect(p.span.start).toBe(text.indexOf("Person, Person") + "Person, ".length);
  });
});

const NESTED = `interface Person {
  id    String @id @default(cuid())
  email String @unique
}

interface Contact {
  phone String?
}

interface Staff extends Person, Contact {
  team String
}

node Employee implements Staff {
  salary Int

  @@index([email, salary])
}
`;

describe("interfaces extending interfaces", () => {
  const hover = (marked: string) => {
    const { text, offset } = at(marked);
    return hoverAt(analyze(text), offset)?.markdown;
  };

  it("analyzes nested interfaces without problems", () => {
    expect(analyze(NESTED).problem).toBeUndefined();
  });

  it("scans the extends clause, also while the text does not parse", () => {
    const a = analyze(NESTED.replace("salary Int", "salary @"));
    const s = a.scanned.find((d) => d.name === "Staff")!;
    expect(s.kind).toBe("interface");
    expect(s.open).toBeGreaterThan(0);
    expect(s.extends.map((t) => t.text)).toEqual(["Person", "Contact"]);
    expect(s.implements).toEqual([]);
    expect(a.scanned.map((d) => d.name)).toEqual(["Person", "Contact", "Staff", "Employee"]);
  });

  it("offers extends after an interface name, then other interfaces", () => {
    expect(labels(NESTED + "\ninterface Manager |")).toEqual(["extends"]);
    expect(labels(NESTED + "\ninterface Manager extends |")).toEqual([
      "Person",
      "Contact",
      "Staff",
    ]);
    expect(labels(NESTED + "\ninterface Manager extends Staff, |")).toEqual(["Person", "Contact"]);
    expect(labels(NESTED + "\ninterface Manager extends Staff |")).toEqual([]);
    // Not itself, nor an interface extending it.
    expect(labels(NESTED.replace("interface Person {", "interface Person extends | {"))).toEqual([
      "Contact",
    ]);
    // `extends` is not offered on a node (nor `implements` on an interface).
    expect(labels(NESTED + "\nnode Customer |")).toEqual(["implements"]);
  });

  it("offers fields inherited through extends in @@index([…])", () => {
    expect(labels(NESTED.replace("@@index([email, salary])", "@@index([|])"))).toEqual([
      "id",
      "email",
      "phone",
      "team",
      "salary",
    ]);
  });

  it("goes to, finds and renames interfaces named by extends", () => {
    const { text, offset } = at(NESTED.replace("extends Person", "extends Per|son"));
    const a = analyze(text);
    const def = definitionAt(a, offset)!;
    expect(def.start).toBe(text.indexOf("interface Person") + "interface ".length);
    expect(referencesAt(a, offset, false)).toHaveLength(1);
    expect(referencesAt(a, offset, true)).toHaveLength(2);
    const edits = renameEdits(a, offset, "Human", BUILTIN_TYPES)!;
    const out = [...edits]
      .sort((x, y) => y.start - x.start)
      .reduce((t, s) => t.slice(0, s.start) + "Human" + t.slice(s.end), text);
    expect(out).toContain("interface Staff extends Human, Contact {");
    expect(analyze(out).problem).toBeUndefined();
  });

  it("documents the extends keyword and shows it in the outline", () => {
    expect(hover(NESTED.replace("extends Person", "ext|ends Person"))).toContain(
      "inherits the fields of interfaces",
    );
    const symbols = outline(analyze(NESTED));
    expect(symbols.map((s) => s.detail)).toEqual([
      undefined,
      undefined,
      "extends Person, Contact",
      "implements Staff",
    ]);
  });

  it.each([
    [NESTED.replace("Person, Contact", "Person, Employee"), "Employee"],
    [NESTED.replace("Person, Contact", "Person, Person"), "Person"],
    [NESTED.replace("interface Contact {", "interface Contact extends Staff {"), "Staff"],
    [NESTED.replace("interface Staff extends", "interface Staff implements"), "Person"],
    [NESTED.replace("node Employee implements", "node Employee extends"), "Staff"],
    // Redeclaring a field inherited from Person (through Staff) points at Staff.
    [
      NESTED.replace("interface Contact {\n  phone String?", "interface Contact {\n  email String"),
      "Contact",
    ],
    [NESTED.replace("  salary Int", "  email String"), "email"],
    // A clash with a field of Person reached through Staff points at Staff.
    [
      NESTED.replace("implements Staff", "implements Mail, Staff") +
        "\ninterface Mail {\n  email String\n}\n",
      "Staff",
    ],
  ])("points extends errors at the name they are about (%#)", (text, underlined) => {
    const p = problem(text)!;
    expect(p.message).toBe(cliError(text));
    expect(p.underlined).toBe(underlined);
  });
});
