import { describe, expect, it } from "vitest";
import { parseSchema } from "./parseSchema.js";
import { printSchemaDocument } from "./printSchema.js";
import { formatSchema } from "./formatSchema.js";
import { resolveSchema, type ResolvedScalarField } from "./model.js";
import { renderCyphraGenSource } from "./renderCyphraGen.js";
import { checkRules, formatRule, listRequiresElements } from "./rules.js";

const resolve = (src: string) => resolveSchema(parseSchema(src));

function field(src: string, name: string): ResolvedScalarField {
  const n = resolve(src).nodes[0]!;
  return n.fields.find((f) => f.name === name) as ResolvedScalarField;
}

/** A one-field node `T` with `decl` as its field line. */
const one = (decl: string) => `node T {\n  id String @id\n  ${decl}\n}\n`;

const SRC = `
node User {
  id       String   @id
  name     String   @length(2, 40) @nonEmpty
  bio      String?  @length(max: 280)
  email    String   @email
  site     String?  @url
  handle   String   @regex("^[a-z0-9_]+$", "i")
  age      Int?     @min(13) @max(130)
  score    Float    @min(-1.5) @max(1.5)
  big      BigInt?  @min(-9223372036854775808) @max(9223372036854775807)
  born     Date?    @min("1900-01-01")
  seen     DateTime? @max("2100-01-01T00:00:00Z")
  tags     String[] @size(1, 5)
  roles    Int[]    @nonEmpty
}

relationship Follows {
  type "FOLLOWS"
  from User
  to User
  note String? @length(max: 10)
}
`;

describe("validation rules: resolution", () => {
  it("resolves every rule with its arguments, in declaration order", () => {
    const model = resolve(SRC);
    const user = model.nodes[0]!;
    const rules = Object.fromEntries(
      user.fields.map((f) => [f.name, (f as ResolvedScalarField).rules]),
    );
    expect(rules).toEqual({
      id: undefined,
      name: [{ rule: "length", min: 2, max: 40 }, { rule: "nonEmpty" }],
      bio: [{ rule: "length", max: 280 }],
      email: [{ rule: "email" }],
      site: [{ rule: "url" }],
      handle: [{ rule: "regex", pattern: "^[a-z0-9_]+$", flags: "i" }],
      age: [
        { rule: "min", value: 13 },
        { rule: "max", value: 130 },
      ],
      score: [
        { rule: "min", value: -1.5 },
        { rule: "max", value: 1.5 },
      ],
      big: [
        { rule: "min", value: "-9223372036854775808" },
        { rule: "max", value: "9223372036854775807" },
      ],
      born: [{ rule: "min", value: "1900-01-01" }],
      seen: [{ rule: "max", value: "2100-01-01T00:00:00.000Z" }],
      tags: [{ rule: "size", min: 1, max: 5 }],
      roles: [{ rule: "nonEmpty" }],
    });
    expect(model.relationships[0]!.properties[0]!.rules).toEqual([{ rule: "length", max: 10 }]);
  });

  it("accepts named arguments", () => {
    expect(field(one("n String @length(min: 1, max: 3)"), "n").rules).toEqual([
      { rule: "length", min: 1, max: 3 },
    ]);
    expect(field(one("n Int @min(value: 1)"), "n").rules).toEqual([{ rule: "min", value: 1 }]);
    expect(field(one('n String @regex(pattern: "a", flags: "im")'), "n").rules).toEqual([
      { rule: "regex", pattern: "a", flags: "im" },
    ]);
  });

  it.each([
    ["n String @min(1)", "@min is not valid on a String field"],
    ["n Int @length(1, 2)", "@length is not valid on a Int field"],
    ["n String[] @length(1, 2)", "use @size for the number of elements"],
    ["n String @size(1)", "@size is not valid on a String field (only on list fields)"],
    ["n Int @email", "@email is not valid on a Int field"],
    ["n String[] @url", "@url is not valid on a String[] field"],
    ["n Json @nonEmpty", "@nonEmpty is not valid on a Json field"],
    ["n Boolean @nonEmpty", "@nonEmpty is not valid on a Boolean field"],
    ["n Int[] @min(0)", "@min is not valid on a Int[] field"],
    ["n String @length(5, 2)", "@length min (5) is above max (2)"],
    ["n String @length", "@length needs a min and/or a max"],
    ["n String @length(-1)", "@length min must be a non-negative integer (got -1)"],
    ["n String @length(1.5)", "@length min must be a non-negative integer (got 1.5)"],
    ['n String @length("3")', '@length min must be a non-negative integer (got "3")'],
    ["n String @length(1, 2, 3)", "@length takes at most 2 positional arguments (min, max)"],
    ["n String @length(min: 1, min: 2)", "@length min given twice"],
    ["n String @length(least: 1)", 'unknown @length argument "least" (expected min, max)'],
    ["n String @email(1)", "@email takes no arguments"],
    ["n Int @min(5) @max(1)", "@min (5) is above @max (1)"],
    ["n Int @min(1.5)", "@min value must be a safe integer (got 1.5)"],
    ['n Float @max("1")', '@max value must be a number (got "1")'],
    ["n Int @min", "@min needs a value"],
    ["n BigInt @min(99999999999999999999)", "@min value must be a 64-bit integer"],
    ['n DateTime @min("yesterday")', "@min value must be an ISO 8601 date-time string"],
    ['n Date @min("2020-02-30")', "@min value must be an ISO 8601 date string"],
    ['n Date @min("2020-01-01") @max("2019-12-31")', "is above @max"],
    ['n String @regex("(")', "@regex pattern does not compile"],
    ['n String @regex("a", "g")', '@regex flags must be a string of distinct flags among "imsu"'],
    ['n String @regex("a", "ii")', "@regex flags must be a string of distinct flags"],
    ["n String @regex(1)", "@regex needs a pattern string"],
    ["n String @email @email", "at most one @email allowed"],
    ['n String @length(5) @default("ab")', 'default "ab" breaks @length: it must be at least'],
    ["n Int @max(3) @default(4)", "default 4 breaks @max: it must be at most 3."],
    ['n String @unique("x")', "@unique takes named arguments only"],
  ])("rejects %s", (decl, message) => {
    expect(() => resolve(one(decl))).toThrow(message);
  });

  it("rejects rules on Vector fields and positional @relationship arguments", () => {
    expect(() => resolve(one("v Vector(3) @nonEmpty"))).toThrow(
      "@nonEmpty is not valid on a Vector field",
    );
    expect(() => resolve(`node A {\n  id String @id\n  b A? @relationship("X")\n}\n`)).toThrow(
      "@relationship takes named arguments only",
    );
  });

  it("rejects positional arguments after named ones at parse time", () => {
    expect(() => parseSchema(one("n String @length(min: 1, 2)"))).toThrow(
      "positional arguments must come before named ones",
    );
  });
});

describe("validation rules: printing and formatting", () => {
  it("prints rules positionally and round-trips", () => {
    const printed = printSchemaDocument(parseSchema(SRC));
    expect(printed).toContain("name String @length(2, 40) @nonEmpty");
    expect(printed).toContain("bio String? @length(max: 280)");
    expect(printed).toContain('handle String @regex("^[a-z0-9_]+$", flags: "i")');
    expect(printed).toContain("age Int? @min(13) @max(130)");
    expect(printed).toContain('born Date? @min("1900-01-01")');
    expect(printed).toContain("tags String[] @size(1, 5)");
    expect(resolveSchema(parseSchema(printed))).toEqual(resolve(SRC));
    const named = printSchemaDocument(parseSchema(one("n String @length(min: 1, max: 3)")));
    expect(named).toContain("@length(1, 3)");
  });

  it("formats keeping positional and named arguments as written", () => {
    const out = formatSchema(one('n   String @length( 1,3 )  @regex(pattern: "a")'));
    expect(out).toContain('n  String @length(1, 3) @regex(pattern: "a")');
  });

  it("formats rules as decorator text", () => {
    expect(formatRule({ rule: "length", min: 1 })).toBe("@length(1)");
    expect(formatRule({ rule: "size", max: 3 })).toBe("@size(max: 3)");
    expect(formatRule({ rule: "min", value: "2020-01-01" })).toBe('@min("2020-01-01")');
    expect(formatRule({ rule: "max", value: "42" })).toBe("@max(42)");
    expect(formatRule({ rule: "regex", pattern: 'a"b', flags: "i" })).toBe('@regex("a\\"b", "i")');
  });

  it("documents the rules on generated fields", () => {
    const out = renderCyphraGenSource(parseSchema(one('n String @length(1, 3) @regex("^a*/b$")')));
    expect(out).toContain('/** Validation: `@length(1, 3)`, `@regex("^a*\\/b$")`. */');
    expect(out).toContain('"rule": "length",');
  });
});

describe("checkRules", () => {
  const f = (decl: string, name = "n") => field(one(decl), name);
  const rules = (decl: string, value: unknown) => checkRules(f(decl), value).map((v) => v.rule);

  it("checks string lengths in code points", () => {
    expect(rules("n String @length(2, 3)", "a")).toEqual(["length"]);
    expect(rules("n String @length(2, 3)", "abcd")).toEqual(["length"]);
    expect(rules("n String @length(2, 3)", "ab")).toEqual([]);
    expect(rules("n String @length(max: 1)", "😀")).toEqual([]);
    expect(checkRules(f("n String @length(2)"), "a")[0]!.message).toBe(
      "must be at least 2 characters long (got 1).",
    );
  });

  it("checks list sizes and non-empty values", () => {
    expect(rules("n Int[] @size(1, 2)", [])).toEqual(["size"]);
    expect(rules("n Int[] @size(1, 2)", [1, 2, 3])).toEqual(["size"]);
    expect(rules("n Int[] @nonEmpty", [])).toEqual(["nonEmpty"]);
    expect(rules("n String @nonEmpty", "  \n")).toEqual(["nonEmpty"]);
    expect(rules("n String @nonEmpty", " a ")).toEqual([]);
    expect(listRequiresElements(f("n Int[] @nonEmpty"))).toBe(true);
    expect(listRequiresElements(f("n Int[] @size(0, 2)"))).toBe(false);
    expect(listRequiresElements(f("n String @nonEmpty"))).toBe(false);
  });

  it("checks numeric and temporal bounds", () => {
    expect(rules("n Int @min(1) @max(3)", 0)).toEqual(["min"]);
    expect(rules("n Int @min(1) @max(3)", 4)).toEqual(["max"]);
    expect(rules("n Int @min(1) @max(3)", 3n)).toEqual([]);
    expect(rules("n Float @max(1)", 1.0001)).toEqual(["max"]);
    expect(rules("n BigInt @max(9007199254740993)", 9007199254740994n)).toEqual(["max"]);
    expect(rules("n BigInt @max(9007199254740993)", 9007199254740993n)).toEqual([]);
    expect(rules('n DateTime @min("2020-01-01")', new Date("2019-12-31T23:59:59Z"))).toEqual([
      "min",
    ]);
    expect(rules('n DateTime @min("2020-01-01")', "2020-01-01T00:00:00Z")).toEqual([]);
    expect(rules('n Date @max("2020-01-01")', new Date("2020-01-01T23:00:00Z"))).toEqual([]);
    expect(rules('n Date @max("2020-01-01")', new Date("2020-01-02T00:00:00Z"))).toEqual(["max"]);
  });

  it("checks formats", () => {
    expect(rules("n String @email", "ada@example.com")).toEqual([]);
    expect(rules("n String @email", "ada@example")).toEqual(["email"]);
    expect(rules("n String @email", "a..b@example.org")).toEqual(["email"]);
    expect(rules("n String @url", "https://example.com/a?b")).toEqual([]);
    expect(rules("n String @url", "javascript:alert(1)")).toEqual(["url"]);
    expect(rules("n String @url", "example.com")).toEqual(["url"]);
    expect(rules('n String @regex("^a+$", "i")', "AaA")).toEqual([]);
    expect(rules('n String @regex("^a+$")', "AaA")).toEqual(["regex"]);
  });

  it("reports every broken rule and ignores null and values of another type", () => {
    expect(rules('n String @length(5) @regex("^a") @email', "b")).toEqual([
      "length",
      "regex",
      "email",
    ]);
    expect(rules("n String? @length(5)", null)).toEqual([]);
    expect(rules("n String @length(5)", 42)).toEqual([]);
    expect(rules("n Int @min(5)", "1")).toEqual([]);
  });
});
