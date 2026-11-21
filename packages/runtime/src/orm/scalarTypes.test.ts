import neo4j5 from "neo4j-driver-5";
import neo4j6 from "neo4j-driver-6";
import { isInt } from "neo4j-driver";
import { describe, expect, it } from "vitest";
import { schemaModel } from "./__fixtures__/types.gen.js";
import { compileAggregate, compileGroupBy } from "./aggregate.js";
import { QueryContext, compileOrderBy, compileWhere } from "./compile.js";
import { CyphraValidationError } from "./errors.js";
import { decodeScalar, defaultLiteralValue, encodeFilterValue, encodeScalar } from "./values.js";

const account = schemaModel.nodes.find((n) => n.name === "TyAccount")!;
const field = (name: string) => {
  const f = account.fields.find((x) => x.name === name);
  if (f?.kind !== "scalar") throw new Error(name);
  return f;
};

function where(w: unknown) {
  const ctx = new QueryContext(schemaModel);
  return { text: compileWhere(ctx, account, "n", w), params: ctx.params };
}

const MAX = 2n ** 63n - 1n;
const MIN = -(2n ** 63n);

describe("enum values", () => {
  it("encodes enum values as strings and rejects anything else", () => {
    expect(encodeScalar(field("role"), "ADMIN", "TyAccount")).toBe("ADMIN");
    expect(encodeScalar(field("roles"), ["ADMIN", "VIEWER"], "TyAccount")).toEqual([
      "ADMIN",
      "VIEWER",
    ]);
    expect(encodeScalar(field("level"), null, "TyAccount")).toBeNull();
    expect(() => encodeScalar(field("role"), "OWNER", "TyAccount")).toThrow(
      /TyAccount\.role: expected one of "ADMIN", "EDITOR", "VIEWER" \(enum TyRole\), got "OWNER"/,
    );
    expect(() => encodeScalar(field("role"), "admin", "TyAccount")).toThrow(CyphraValidationError);
    expect(() => encodeScalar(field("roles"), ["ADMIN", "X"], "TyAccount")).toThrow(
      /TyAccount\.roles\[1\]/,
    );
    expect(() => encodeScalar(field("role"), 1, "TyAccount")).toThrow(/got number/);
  });

  it("validates enum filter values", () => {
    expect(where({ role: "ADMIN" })).toEqual({ text: "n.`role` = $p0", params: { p0: "ADMIN" } });
    expect(where({ role: { in: ["ADMIN", "EDITOR"] } }).params).toEqual({
      p0: ["ADMIN", "EDITOR"],
    });
    expect(where({ roles: { has: "EDITOR" } }).text).toBe("$p0 IN n.`roles`");
    expect(() => where({ role: { notIn: ["NOPE"] } })).toThrow(/expected one of/);
    expect(() => where({ role: { contains: "AD" } })).toThrow(/only valid on String/);
    expect(() => where({ role: { equals: "ADMIN", mode: "insensitive" } })).toThrow(
      /only valid on String/,
    );
  });
});

describe("Json values", () => {
  it("stores JSON text and parses it back", () => {
    const value = { a: [1, "two", null, { b: true }], c: 1.5 };
    const text = encodeScalar(field("settings"), value, "TyAccount");
    expect(text).toBe(JSON.stringify(value));
    expect(decodeScalar(field("settings"), text)).toEqual(value);
    expect(encodeScalar(field("settings"), "plain", "TyAccount")).toBe('"plain"');
    expect(encodeScalar(field("settings"), 0, "TyAccount")).toBe("0");
    expect(encodeScalar(field("settings"), false, "TyAccount")).toBe("false");
    expect(decodeScalar(field("settings"), '"plain"')).toBe("plain");
    expect(decodeScalar(field("settings"), null)).toBeNull();
    // Text that is not JSON (written outside Cyphra) is returned as is.
    expect(decodeScalar(field("settings"), "{oops")).toBe("{oops");
  });

  it("rejects values JSON.stringify cannot encode", () => {
    expect(() => encodeScalar(field("settings"), { n: 1n }, "TyAccount")).toThrow(
      /TyAccount\.settings: value is not JSON-serializable/,
    );
    expect(() => encodeScalar(field("settings"), () => 1, "TyAccount")).toThrow(
      /expected a JSON value/,
    );
    expect(() => encodeScalar(field("prefs"), null, "TyAccount")).toThrow(/required/);
  });

  it("applies a JSON-text default as its value", () => {
    const prefs = field("prefs");
    expect(prefs.default).toEqual({ kind: "literal", value: '{"theme":"light"}' });
    expect(defaultLiteralValue(prefs, prefs.default as { kind: "literal"; value: string })).toEqual(
      { theme: "light" },
    );
  });

  it("filters on null and whole-value equality only", () => {
    expect(where({ settings: null }).text).toBe("n.`settings` IS NULL");
    expect(where({ settings: { equals: { a: 1 } } })).toEqual({
      text: "n.`settings` = $p0",
      params: { p0: '{"a":1}' },
    });
    expect(where({ settings: { not: null } }).text).toBe("n.`settings` IS NOT NULL");
    expect(where({ settings: { not: [1] } }).text).toBe("n.`settings` <> $p0");
    expect(where({ settings: { equals: null } }).text).toBe("n.`settings` IS NULL");
    expect(() => where({ settings: "x" })).toThrow(/null, \{ equals \} or \{ not \} only/);
    expect(() => where({ settings: { a: 1 } })).toThrow(/null, \{ equals \} or \{ not \} only/);
    expect(() => where({ settings: { in: [1] } })).toThrow(CyphraValidationError);
  });

  it("cannot be sorted or aggregated beyond _count", () => {
    const ctx = new QueryContext(schemaModel);
    expect(() => compileOrderBy(ctx, account, "n", { settings: "asc" })).toThrow(
      /Json fields cannot be sorted/,
    );
    expect(() => compileAggregate(ctx, account, { _max: { settings: true } })).toThrow(
      /_max is not valid/,
    );
  });
});

describe("BigInt values", () => {
  it("encodes bigints (and safe integers) as driver Integers, in the 64-bit range", () => {
    const f = field("balance");
    for (const v of [0n, 1n, -1n, MAX, MIN, 2n ** 53n + 1n]) {
      const enc = encodeScalar(f, v, "TyAccount");
      expect(isInt(enc)).toBe(true);
      expect((enc as { toString(): string }).toString()).toBe(v.toString());
    }
    expect((encodeScalar(f, 42, "TyAccount") as { toString(): string }).toString()).toBe("42");
    expect(() => encodeScalar(f, MAX + 1n, "TyAccount")).toThrow(
      /outside the 64-bit integer range/,
    );
    expect(() => encodeScalar(f, MIN - 1n, "TyAccount")).toThrow(
      /outside the 64-bit integer range/,
    );
    expect(() => encodeScalar(f, 1.5, "TyAccount")).toThrow(/expected BigInt/);
    expect(() => encodeScalar(f, 2 ** 60, "TyAccount")).toThrow(/expected BigInt/);
    expect(() => encodeScalar(f, "1", "TyAccount")).toThrow(/expected BigInt/);
    const list = encodeScalar(field("ids"), [1n, MAX], "TyAccount") as unknown[];
    expect(list.map(String)).toEqual(["1", MAX.toString()]);
  });

  it("decodes Integers of both driver majors, bigints and numbers to bigint", () => {
    const f = field("balance");
    for (const mod of [neo4j5, neo4j6]) {
      expect(decodeScalar(f, mod.int(MAX.toString()))).toBe(MAX);
      expect(decodeScalar(f, mod.int(MIN.toString()))).toBe(MIN);
      expect(decodeScalar(f, mod.int(0))).toBe(0n);
      expect((encodeScalar(f, mod.int("-5"), "TyAccount") as object).toString()).toBe("-5");
    }
    expect(decodeScalar(f, MAX)).toBe(MAX); // driver configured with useBigInt
    expect(decodeScalar(f, 7)).toBe(7n); // driver configured with disableLosslessIntegers
    expect(decodeScalar(field("external"), null)).toBeNull();
    expect(decodeScalar(field("ids"), [neo4j5.int(1), neo4j6.int(2)])).toEqual([1n, 2n]);
    expect(decodeScalar(field("ids"), null)).toEqual([]);
  });

  it("turns the decimal-string default into a bigint", () => {
    const f = field("balance");
    expect(defaultLiteralValue(f, f.default as { kind: "literal"; value: string })).toBe(0n);
  });

  it("filters with bigint parameters", () => {
    const { text, params } = where({ balance: { gt: 0n, lte: MAX }, external: { in: [1n, MIN] } });
    expect(text).toBe("((n.`balance` > $p0) AND (n.`balance` <= $p1)) AND (n.`external` IN $p2)");
    expect(String(params.p1)).toBe(MAX.toString());
    expect((params.p2 as unknown[]).map(String)).toEqual(["1", MIN.toString()]);
    expect(() => encodeFilterValue(field("balance"), MAX + 1n, "TyAccount")).toThrow(
      /outside the 64-bit/,
    );
  });

  it("aggregates: _sum decodes to bigint, _avg to number; having compares bigints", () => {
    const ctx = new QueryContext(schemaModel);
    const c = compileAggregate(ctx, account, {
      _sum: { balance: true },
      _avg: { balance: true },
      _min: { balance: true },
    });
    expect(c.decode([{ a0: neo4j5.int(MAX.toString()), a1: 1.5, a2: neo4j6.int(-3) }])).toEqual({
      _sum: { balance: MAX },
      _avg: { balance: 1.5 },
      _min: { balance: -3n },
    });
    const g = compileGroupBy(new QueryContext(schemaModel), account, {
      by: "role",
      _sum: { balance: true },
      having: { balance: { _sum: { gt: 10n } } },
    });
    expect(g.text).toContain("WHERE a1 > $p0");
    expect(String(g.params.p0)).toBe("10");
  });
});
