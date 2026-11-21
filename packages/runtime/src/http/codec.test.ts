import neo4j from "neo4j-driver";
import { describe, expect, it } from "vitest";
import {
  CypherDate,
  CypherDateTime,
  CypherDuration,
  CypherInteger,
  CypherLocalDateTime,
  CypherLocalTime,
  CypherNode,
  CypherPath,
  CypherPoint,
  CypherRelationship,
  CypherTime,
} from "../cypher-values.js";
import { toNative } from "../orm/values.js";
import {
  TypedJsonError,
  base64ToBytes,
  bytesToBase64,
  decodeTyped,
  encodeParameters,
  encodeTyped,
  utf8ToBase64,
} from "./codec.js";

const t = ($type: string, _value: unknown) => ({ $type, _value });

describe("encodeTyped", () => {
  it("encodes JSON primitives", () => {
    expect(encodeTyped(null)).toEqual(t("Null", null));
    expect(encodeTyped(undefined)).toEqual(t("Null", null));
    expect(encodeTyped(true)).toEqual(t("Boolean", true));
    expect(encodeTyped("héllo")).toEqual(t("String", "héllo"));
  });

  it("sends JS numbers as Float (like neo4j-driver) and integers as Integer", () => {
    expect(encodeTyped(3)).toEqual(t("Float", "3"));
    expect(encodeTyped(1.5)).toEqual(t("Float", "1.5"));
    expect(encodeTyped(1e21)).toEqual(t("Float", "1e+21"));
    expect(encodeTyped(NaN)).toEqual(t("Float", "NaN"));
    expect(encodeTyped(-Infinity)).toEqual(t("Float", "-Infinity"));
    expect(encodeTyped(42n)).toEqual(t("Integer", "42"));
    expect(encodeTyped(new CypherInteger(-(2n ** 63n)))).toEqual(
      t("Integer", "-9223372036854775808"),
    );
    // A driver Integer (structural marker) is an Integer too.
    expect(encodeTyped(neo4j.int("9007199254740993"))).toEqual(t("Integer", "9007199254740993"));
    expect(() => encodeTyped(2n ** 63n)).toThrow(RangeError);
  });

  it("encodes lists, maps and bytes", () => {
    expect(encodeTyped([1n, "a", [null]])).toEqual(
      t("List", [t("Integer", "1"), t("String", "a"), t("List", [t("Null", null)])]),
    );
    expect(encodeTyped({ a: 1n, b: { c: false } })).toEqual(
      t("Map", { a: t("Integer", "1"), b: t("Map", { c: t("Boolean", false) }) }),
    );
    expect(encodeTyped(new Int8Array([1, 2, 3, -1]))).toEqual(t("Base64", "AQID/w=="));
    expect(encodeTyped(new Uint8Array([255]))).toEqual(t("Base64", "/w=="));
    expect(encodeTyped(new Float32Array([0.5]))).toEqual(t("List", [t("Float", "0.5")]));
  });

  it("encodes temporal values (Cyphra and neo4j-driver)", () => {
    expect(encodeTyped(new CypherDate(2024, 1, 2))).toEqual(t("Date", "2024-01-02"));
    expect(encodeTyped(new neo4j.types.Date(2024, 1, 2))).toEqual(t("Date", "2024-01-02"));
    expect(encodeTyped(new CypherDate(12024, 1, 2))).toEqual(t("Date", "+012024-01-02"));
    expect(encodeTyped(new CypherLocalTime(12, 0, 5, 500_000_000))).toEqual(
      t("LocalTime", "12:00:05.500000000"),
    );
    expect(encodeTyped(new CypherTime(12, 0, 0, 0, 3600))).toEqual(t("Time", "12:00:00+01:00"));
    expect(encodeTyped(new neo4j.types.Time(12, 0, 0, 1, -19800))).toEqual(
      t("Time", "12:00:00.000000001-05:30"),
    );
    expect(encodeTyped(new CypherLocalDateTime(2024, 1, 2, 3, 4, 5, 0))).toEqual(
      t("LocalDateTime", "2024-01-02T03:04:05"),
    );
    expect(encodeTyped(new CypherDateTime(2024, 1, 2, 3, 4, 5, 123_000_000, 0))).toEqual(
      t("OffsetDateTime", "2024-01-02T03:04:05.123000000Z"),
    );
    expect(
      encodeTyped(new neo4j.types.DateTime(2024, 1, 2, 3, 4, 5, 0, 3600, "Europe/Paris")),
    ).toEqual(t("ZonedDateTime", "2024-01-02T03:04:05+01:00[Europe/Paris]"));
    expect(() =>
      encodeTyped(new neo4j.types.DateTime(2024, 1, 2, 3, 4, 5, 0, undefined, "Europe/Paris")),
    ).toThrow(TypedJsonError);
    expect(encodeTyped(new Date("2024-01-02T03:04:05.006Z"))).toEqual(
      t("OffsetDateTime", "2024-01-02T03:04:05.006Z"),
    );
  });

  it("encodes durations and points", () => {
    expect(encodeTyped(new CypherDuration(14n, 3n, 14706n, 700_000_000))).toEqual(
      t("Duration", "P1Y2M3DT4H5M6.7S"),
    );
    expect(encodeTyped(new neo4j.types.Duration(0, 0, -2, 500_000_000))).toEqual(
      t("Duration", "-PT1.5S"),
    );
    expect(encodeTyped(new CypherPoint(4326, 1.5, 2))).toEqual(
      t("Point", "SRID=4326;POINT (1.5 2)"),
    );
    expect(encodeTyped(new neo4j.types.Point(9157, 1, 2, 3))).toEqual(
      t("Point", "SRID=9157;POINT Z (1 2 3)"),
    );
  });

  it("rejects values that cannot be parameters", () => {
    expect(() => encodeTyped(new CypherNode("4:x:0", [], {}))).toThrow(TypedJsonError);
    expect(() => encodeTyped(() => 1)).toThrow(TypedJsonError);
    expect(() => encodeTyped(Symbol("s"))).toThrow(TypedJsonError);
    expect(() => encodeTyped(new Date(NaN))).toThrow(TypedJsonError);
  });

  it("encodes a parameter map", () => {
    expect(encodeParameters({ a: 1n, b: "x" })).toEqual({
      a: t("Integer", "1"),
      b: t("String", "x"),
    });
    expect(encodeParameters(undefined)).toEqual({});
  });
});

describe("decodeTyped", () => {
  it("decodes scalars", () => {
    expect(decodeTyped(t("Null", null))).toBeNull();
    expect(decodeTyped(t("Boolean", false))).toBe(false);
    expect(decodeTyped(t("String", "x"))).toBe("x");
    expect(decodeTyped(t("Float", "1.0E20"))).toBe(1e20);
    expect(decodeTyped(t("Float", "NaN"))).toBeNaN();
    expect(decodeTyped(t("Float", "-Infinity"))).toBe(-Infinity);
    const i = decodeTyped(t("Integer", "9007199254740993")) as CypherInteger;
    expect(i).toBeInstanceOf(CypherInteger);
    expect(i.toBigInt()).toBe(9007199254740993n);
    expect(i.inSafeRange()).toBe(false);
    expect(Array.from(decodeTyped(t("Base64", "AQID/w==")) as Int8Array)).toEqual([1, 2, 3, -1]);
  });

  it("decodes temporal values", () => {
    expect(decodeTyped(t("Date", "2024-01-02"))).toEqual(new CypherDate(2024, 1, 2));
    expect(decodeTyped(t("Date", "+12024-01-02"))).toEqual(new CypherDate(12024, 1, 2));
    expect(decodeTyped(t("LocalTime", "12:00:00.5"))).toEqual(
      new CypherLocalTime(12, 0, 0, 500_000_000),
    );
    expect(decodeTyped(t("LocalTime", "12:00"))).toEqual(new CypherLocalTime(12, 0, 0, 0));
    expect(decodeTyped(t("Time", "12:00:00+05:30:15"))).toEqual(new CypherTime(12, 0, 0, 0, 19815));
    expect(decodeTyped(t("Time", "12:00:00Z"))).toEqual(new CypherTime(12, 0, 0, 0, 0));
    expect(decodeTyped(t("LocalDateTime", "2024-01-02T03:04:05"))).toEqual(
      new CypherLocalDateTime(2024, 1, 2, 3, 4, 5, 0),
    );
    const odt = decodeTyped(t("OffsetDateTime", "2024-01-02T03:04:05.123456789Z"));
    expect(odt).toEqual(new CypherDateTime(2024, 1, 2, 3, 4, 5, 123_456_789, 0));
    expect((odt as CypherDateTime).toStandardDate().toISOString()).toBe("2024-01-02T03:04:05.123Z");
    const zdt = decodeTyped(t("ZonedDateTime", "2024-01-02T03:04:05+01:00[Europe/Paris]"));
    expect(zdt).toEqual(new CypherDateTime(2024, 1, 2, 3, 4, 5, 0, 3600, "Europe/Paris"));
    expect((zdt as CypherDateTime).toStandardDate().toISOString()).toBe("2024-01-02T02:04:05.000Z");
    const d = decodeTyped(t("Duration", "P1Y2M3DT4H5M6.7S")) as CypherDuration;
    expect([d.months, d.days, d.seconds, d.nanoseconds].map(String)).toEqual([
      "14",
      "3",
      "14706",
      "700000000",
    ]);
    const neg = decodeTyped(t("Duration", "PT-1.5S")) as CypherDuration;
    expect([neg.seconds, neg.nanoseconds].map(String)).toEqual(["-2", "500000000"]);
  });

  it("decodes points", () => {
    expect(decodeTyped(t("Point", "SRID=4326;POINT (1.5 2.0)"))).toEqual(
      new CypherPoint(4326, 1.5, 2),
    );
    expect(decodeTyped(t("Point", "SRID=9157;POINT Z (1.0 2.0 3.0)"))).toEqual(
      new CypherPoint(9157, 1, 2, 3),
    );
  });

  it("decodes nodes, relationships, paths, lists and maps", () => {
    const node = (id: string, props = {}) =>
      t("Node", { _element_id: id, _labels: ["T"], _properties: props });
    const rel = t("Relationship", {
      _element_id: "5:x:0",
      _start_node_element_id: "4:x:0",
      _end_node_element_id: "4:x:1",
      _type: "R",
      _properties: { w: t("Integer", "2") },
    });
    const n = decodeTyped(node("4:x:0", { i: t("Integer", "1") })) as CypherNode;
    expect(n).toBeInstanceOf(CypherNode);
    expect(n.elementId).toBe("4:x:0");
    expect(n.labels).toEqual(["T"]);
    expect(String(n.properties.i)).toBe("1");
    const r = decodeTyped(rel) as CypherRelationship;
    expect([r.type, r.startNodeElementId, r.endNodeElementId]).toEqual(["R", "4:x:0", "4:x:1"]);
    const p = decodeTyped(t("Path", [node("4:x:0"), rel, node("4:x:1")])) as CypherPath;
    expect(p).toBeInstanceOf(CypherPath);
    expect(p.length).toBe(1);
    expect(p.start.elementId).toBe("4:x:0");
    expect(p.end.elementId).toBe("4:x:1");
    expect(p.segments[0]!.relationship.type).toBe("R");
    expect(decodeTyped(t("List", [t("Integer", "1"), t("Null", null)]))).toEqual([
      new CypherInteger(1),
      null,
    ]);
    expect(decodeTyped(t("Map", { k: t("String", "v") }))).toEqual({ k: "v" });
    // Node → properties, Integer → number: the ORM's `toNative` reads Query API values.
    expect(toNative({ n, list: [new CypherInteger(3)] })).toEqual({ n: { i: 1 }, list: [3] });
  });

  it("rejects malformed values and passes unknown types through", () => {
    expect(() => decodeTyped(t("Date", "2024/01/02"))).toThrow(TypedJsonError);
    expect(() => decodeTyped(t("Integer", 1))).toThrow(TypedJsonError);
    expect(() => decodeTyped(t("Point", "POINT (1 2)"))).toThrow(TypedJsonError);
    expect(decodeTyped(t("UUID", "550e8400-e29b-41d4-a716-446655440000"))).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(decodeTyped(42)).toBe(42);
  });
});

describe("round trips", () => {
  const values: [string, unknown][] = [
    ["Integer", new CypherInteger(-(2n ** 63n))],
    ["Integer max", new CypherInteger(2n ** 63n - 1n)],
    ["Date", new CypherDate(1, 12, 31)],
    ["Date (negative year)", new CypherDate(-44, 3, 15)],
    ["LocalTime", new CypherLocalTime(23, 59, 59, 999_999_999)],
    ["Time", new CypherTime(0, 0, 0, 1, -64800)],
    ["LocalDateTime", new CypherLocalDateTime(2024, 2, 29, 12, 30, 0, 1)],
    ["OffsetDateTime", new CypherDateTime(2024, 2, 29, 12, 30, 0, 0, 0)],
    ["ZonedDateTime", new CypherDateTime(2024, 7, 1, 12, 0, 0, 0, 7200, "Europe/Paris")],
    ["Duration", new CypherDuration(-14n, 3n, -1n, 999_999_999)],
    ["Point 2D", new CypherPoint(7203, -1.25, 1e-7)],
    ["Point 3D", new CypherPoint(4979, 2.35, 48.85, 35)],
    ["List", [new CypherInteger(1), 1.5, "x", null, [true]]],
    ["Map", { a: new CypherDate(2024, 1, 1), b: { c: new CypherInteger(2) } }],
  ];
  it.each(values)("%s", (_, v) => {
    // Through JSON, as on the wire.
    const wire = JSON.parse(JSON.stringify(encodeTyped(v))) as unknown;
    expect(decodeTyped(wire)).toEqual(v);
  });

  it("bytes", () => {
    const bytes = new Int8Array(70_000).map((_, i) => (i % 256) - 128);
    const back = decodeTyped(JSON.parse(JSON.stringify(encodeTyped(bytes)))) as Int8Array;
    expect(back).toEqual(bytes);
  });
});

describe("base64 helpers", () => {
  it("matches standard base64", () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe("aGk=");
    expect(Array.from(base64ToBytes("aGk="))).toEqual([104, 105]);
    expect(utf8ToBase64("neo4j:pässwörd")).toBe("bmVvNGo6cMOkc3N3w7ZyZA==");
  });
});
