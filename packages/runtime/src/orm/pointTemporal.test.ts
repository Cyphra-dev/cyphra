import neo4j5 from "neo4j-driver-5";
import neo4j6 from "neo4j-driver-6";
import { isDuration, isLocalDateTime, isLocalTime, isPoint, isTime } from "neo4j-driver";
import { describe, expect, it } from "vitest";
import { schemaModel } from "./__fixtures__/geo.gen.js";
import { compileAggregate } from "./aggregate.js";
import { QueryContext, compileOrderBy, compileWhere } from "./compile.js";
import { CyphraValidationError } from "./errors.js";
import { decodeScalar, encodeFilterValue, encodeScalar, nowValue } from "./values.js";

const place = schemaModel.nodes.find((n) => n.name === "GeoPlace")!;
const field = (name: string) => {
  const f = place.fields.find((x) => x.name === name);
  if (f?.kind !== "scalar") throw new Error(name);
  return f;
};

function where(w: unknown) {
  const ctx = new QueryContext(schemaModel);
  return { text: compileWhere(ctx, place, "n", w), params: ctx.params };
}

function orderBy(o: unknown) {
  const ctx = new QueryContext(schemaModel);
  return { text: compileOrderBy(ctx, place, "n", o), params: ctx.params };
}

const PARIS = { longitude: 2.3522, latitude: 48.8566 };

/** Driver modules of both majors: values Neo4j returns through either one must decode alike. */
const drivers = [
  ["neo4j-driver 5", neo4j5],
  ["neo4j-driver 6", neo4j6],
] as const;

describe("point values", () => {
  it("encodes WGS-84 and Cartesian points (2D and 3D) as driver Points", () => {
    const p = encodeScalar(field("location"), PARIS, "GeoPlace") as Record<string, unknown>;
    expect(isPoint(p)).toBe(true);
    expect(p).toMatchObject({ srid: 4326, x: 2.3522, y: 48.8566 });
    const p3 = encodeScalar(field("location"), { ...PARIS, height: 35 }, "GeoPlace");
    expect(p3).toMatchObject({ srid: 4979, z: 35 });
    expect(encodeScalar(field("grid"), { x: 1, y: 2 }, "GeoPlace")).toMatchObject({
      srid: 7203,
      x: 1,
      y: 2,
    });
    expect(encodeScalar(field("grid"), { x: 1, y: 2, z: 3 }, "GeoPlace")).toMatchObject({
      srid: 9157,
    });
    const route = encodeScalar(field("route"), [PARIS, PARIS], "GeoPlace") as unknown[];
    expect(route.every((x) => isPoint(x))).toBe(true);
  });

  it.each([
    ["location", { x: 1, y: 2 }, /expected a Point \{ longitude, latitude, height\? \}/],
    ["location", { longitude: 1 }, /expected a Point/],
    ["location", { longitude: 1, latitude: 2, extra: 3 }, /expected a Point/],
    ["location", { longitude: 200, latitude: 0 }, /longitude must be within \[-180, 180\]/],
    ["location", { longitude: 0, latitude: 91 }, /latitude within \[-90, 90\]/],
    ["location", { longitude: Number.NaN, latitude: 0 }, /finite numbers/],
    ["location", "2.35,48.85", /got string/],
    ["grid", PARIS, /expected a CartesianPoint \{ x, y, z\? \}/],
  ])("rejects %s = %j", (name, value, message) => {
    expect(() => encodeScalar(field(name), value, "GeoPlace")).toThrow(message);
  });

  it.each(drivers)("decodes points returned through %s", (_name, mod) => {
    expect(decodeScalar(field("location"), new mod.types.Point(4326, 2.5, 48.5))).toEqual({
      longitude: 2.5,
      latitude: 48.5,
    });
    expect(decodeScalar(field("location"), new mod.types.Point(mod.int(4979), 2, 48, 30))).toEqual({
      longitude: 2,
      latitude: 48,
      height: 30,
    });
    expect(decodeScalar(field("grid"), new mod.types.Point(7203, 1, 2))).toEqual({ x: 1, y: 2 });
    expect(decodeScalar(field("grid"), new mod.types.Point(9157, 1, 2, 3))).toEqual({
      x: 1,
      y: 2,
      z: 3,
    });
    expect(decodeScalar(field("route"), [new mod.types.Point(4326, 1, 2)])).toEqual([
      { longitude: 1, latitude: 2 },
    ]);
    expect(decodeScalar(field("grid"), null)).toBeNull();
  });
});

describe("point filters", () => {
  it("compiles equality, distance and bounding boxes", () => {
    expect(where({ location: PARIS }).text).toBe("n.`location` = $p0");
    expect(where({ location: { equals: PARIS, not: null } }).text).toBe(
      "(n.`location` = $p0) AND (n.`location` IS NOT NULL)",
    );
    expect(where({ grid: null }).text).toBe("n.`grid` IS NULL");
    const near = where({ location: { distance: { from: PARIS, lt: 5000, gte: 10 } } });
    expect(near.text).toBe(
      "(point.distance(n.`location`, $p0) < $p1) AND (point.distance(n.`location`, $p0) >= $p2)",
    );
    expect(isPoint(near.params.p0)).toBe(true);
    expect(near.params.p1).toBe(5000);
    const box = where({
      location: {
        withinBBox: {
          lowerLeft: { longitude: 2, latitude: 48 },
          upperRight: { longitude: 3, latitude: 49 },
        },
      },
    });
    expect(box.text).toBe("point.withinBBox(n.`location`, $p0, $p1)");
  });

  it.each([
    [{ location: { lt: PARIS } }, /Unknown filter "lt"/],
    [{ location: { distance: { lt: 5 } } }, /distance takes \{ from/],
    [{ location: { distance: { from: PARIS } } }, /needs a bound/],
    [{ location: { distance: { from: PARIS, near: 5 } } }, /Unknown distance filter "near"/],
    [{ location: { distance: { from: PARIS, lt: "5" } } }, /must be a finite number/],
    [{ location: { distance: { from: { x: 1, y: 2 }, lt: 5 } } }, /distance.from must be a Point/],
    [{ location: { withinBBox: { lowerLeft: PARIS } } }, /upperRight must be a Point/],
    [{ grid: { distance: { from: PARIS, lt: 1 } } }, /must be a CartesianPoint/],
    [{ location: "paris" }, /point filters take/],
  ])("rejects %j", (w, message) => {
    expect(() => where(w)).toThrow(message);
  });

  it("sorts by distance from a point (nearest first by default)", () => {
    const o = orderBy({ location: { distanceFrom: PARIS } });
    expect(o.text).toBe("point.distance(n.`location`, $p0) ASC");
    expect(isPoint(o.params.p0)).toBe(true);
    expect(
      orderBy([{ location: { distanceFrom: PARIS, sort: "desc" } }, { name: "asc" }]).text,
    ).toBe("point.distance(n.`location`, $p0) DESC, n.`name` ASC");
    expect(() => orderBy({ location: "asc" })).toThrow(/sort by distance/);
    expect(() => orderBy({ location: { distanceFrom: PARIS, sort: "up" } })).toThrow(
      CyphraValidationError,
    );
    expect(() => orderBy({ location: { distanceFrom: { x: 1, y: 1 } } })).toThrow(
      /sort by distance/,
    );
  });
});

describe("temporal values", () => {
  it("encodes ISO 8601 text as driver temporal values", () => {
    const ldt = encodeScalar(field("starts"), "2024-05-01T10:30:00.5", "GeoPlace");
    expect(isLocalDateTime(ldt)).toBe(true);
    expect(ldt).toMatchObject({ year: 2024, month: 5, day: 1, hour: 10, nanosecond: 500_000_000 });
    const lt = encodeScalar(field("opens"), "09:15", "GeoPlace");
    expect(isLocalTime(lt)).toBe(true);
    expect(lt).toMatchObject({ hour: 9, minute: 15, second: 0 });
    const t = encodeScalar(field("slot"), "10:30:00+02:00", "GeoPlace");
    expect(isTime(t)).toBe(true);
    expect(t).toMatchObject({ hour: 10, timeZoneOffsetSeconds: 7200 });
    const d = encodeScalar(field("stay"), "P1Y2M3DT4H5M6.5S", "GeoPlace") as Record<
      string,
      unknown
    >;
    expect(isDuration(d)).toBe(true);
    expect([d.months, d.days, d.seconds, d.nanoseconds].map(String)).toEqual([
      "14",
      "3",
      "14706",
      "500000000",
    ]);
    const ws = encodeScalar(field("windows"), ["PT1H", "P1D"], "GeoPlace") as unknown[];
    expect(ws.every((x) => isDuration(x))).toBe(true);
  });

  it.each([
    [
      "starts",
      "2024-05-01",
      /expected LocalDateTime as ISO 8601 text \(e\.g\. "2024-05-01T10:30:00"\)/,
    ],
    ["starts", new Date(), /got Date/],
    ["opens", "9am", /expected LocalTime/],
    ["slot", "10:30", /expected Time .*"10:30:00\+02:00"/],
    ["stay", "1h", /expected Duration .*"P1DT2H30M"/],
    ["stay", 3600, /got number/],
  ])("rejects %s = %j", (name, value, message) => {
    expect(() => encodeScalar(field(name), value, "GeoPlace")).toThrow(message);
  });

  it.each(drivers)("decodes temporal values returned through %s", (_name, mod) => {
    const { LocalDateTime, LocalTime, Time, Duration } = mod.types;
    expect(decodeScalar(field("starts"), new LocalDateTime(2024, 5, 1, 10, 30, 0, 5_000_000))).toBe(
      "2024-05-01T10:30:00.005",
    );
    expect(
      decodeScalar(field("opens"), new LocalTime(mod.int(9), mod.int(0), mod.int(0), mod.int(0))),
    ).toBe("09:00:00");
    expect(decodeScalar(field("slot"), new Time(10, 30, 0, 0, -18000))).toBe("10:30:00-05:00");
    expect(decodeScalar(field("slot"), new Time(10, 30, 0, 0, 0))).toBe("10:30:00Z");
    expect(decodeScalar(field("stay"), new Duration(14, 3, 14706, 500_000_000))).toBe(
      "P1Y2M3DT4H5M6.5S",
    );
    expect(
      decodeScalar(field("stay"), new Duration(mod.int(0), mod.int(0), mod.int(-90), mod.int(0))),
    ).toBe("-PT1M30S");
    expect(decodeScalar(field("windows"), [new Duration(0, 1, 0, 0)])).toEqual(["P1D"]);
    expect(decodeScalar(field("windows"), null)).toEqual([]);
  });

  it("round-trips through encode → decode", () => {
    const cases: [string, string, string][] = [
      ["starts", "2024-05-01T10:30", "2024-05-01T10:30:00"],
      ["opens", "23:59:59.999999999", "23:59:59.999999999"],
      ["slot", "08:00+01:00", "08:00:00+01:00"],
      ["stay", "PT90M", "PT1H30M"],
      ["stay", "P1M-3D", "P1M-3D"],
    ];
    for (const [name, input, output] of cases) {
      expect(decodeScalar(field(name), encodeScalar(field(name), input, "GeoPlace"))).toBe(output);
    }
  });

  it("gives now() as UTC wall-clock text for local types", () => {
    const at = new Date("2024-05-01T10:30:00.123Z");
    expect(nowValue(field("seen"), at)).toBe("2024-05-01T10:30:00.123");
    expect(nowValue(field("opens"), at)).toBe("10:30:00.123");
    expect(nowValue(field("slot"), at)).toBe("10:30:00.123Z");
  });
});

describe("temporal filters", () => {
  it("compares ordered temporal fields as temporal values", () => {
    const w = where({ starts: { gte: "2024-01-01T00:00", lt: "2025-01-01T00:00" } });
    expect(w.text).toBe("(n.`starts` >= $p0) AND (n.`starts` < $p1)");
    expect(isLocalDateTime(w.params.p0)).toBe(true);
    expect(where({ opens: { in: ["09:00", "10:00"] } }).text).toBe("n.`opens` IN $p0");
    expect(where({ slot: "10:00Z" }).text).toBe("n.`slot` = $p0");
    expect(() => where({ opens: { contains: "09" } })).toThrow(/only valid on String/);
    expect(() => where({ opens: { gt: "nine" } })).toThrow(/expected LocalTime/);
  });

  it("only takes equality on durations", () => {
    expect(where({ stay: "PT1H" }).text).toBe("n.`stay` = $p0");
    expect(where({ stay: { in: ["PT1H"], not: { equals: "PT2H" } } }).text).toBe(
      "(n.`stay` IN $p0) AND (NOT (n.`stay` = $p1))",
    );
    expect(() => where({ stay: { gt: "PT1H" } })).toThrow(
      /"gt" is not valid on a Duration field \(durations have no total order/,
    );
    expect(where({ windows: { has: "P1D" } }).text).toBe("$p0 IN n.`windows`");
  });

  it("sorts ordered temporal fields, not durations", () => {
    expect(orderBy({ starts: "desc" }).text).toBe("n.`starts` DESC");
    expect(() => orderBy({ stay: "asc" })).toThrow(/Duration fields cannot be sorted/);
  });

  it("aggregates _min / _max of ordered temporal fields into ISO text", () => {
    const ctx = new QueryContext(schemaModel);
    const c = compileAggregate(ctx, place, {
      _min: { starts: true, opens: true },
      _max: { slot: true },
    });
    const mod = neo4j6;
    expect(
      c.decode([
        {
          a0: new mod.types.LocalDateTime(2024, 1, 2, 3, 4, 5, 0),
          a1: new mod.types.LocalTime(8, 0, 0, 0),
          a2: new mod.types.Time(18, 0, 0, 0, 3600),
        },
      ]),
    ).toEqual({
      _min: { starts: "2024-01-02T03:04:05", opens: "08:00:00" },
      _max: { slot: "18:00:00+01:00" },
    });
    for (const bad of [
      { _max: { stay: true } },
      { _min: { location: true } },
      { _sum: { opens: true } },
    ]) {
      expect(() => compileAggregate(new QueryContext(schemaModel), place, bad)).toThrow(
        CyphraValidationError,
      );
    }
  });

  it("encodes filter values of every new type", () => {
    expect(isTime(encodeFilterValue(field("slot"), "10:00Z", "GeoPlace"))).toBe(true);
    expect(isPoint(encodeFilterValue(field("grid"), { x: 0, y: 0 }, "GeoPlace"))).toBe(true);
  });
});
