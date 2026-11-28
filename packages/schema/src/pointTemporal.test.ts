import { describe, expect, it } from "vitest";
import type { NodeDeclaration } from "./ast.js";
import { SchemaValidationError } from "./errors.js";
import { getNodeModel, resolveSchema } from "./model.js";
import { parseSchema } from "./parseSchema.js";
import { printSchemaDocument } from "./printSchema.js";
import { renderCyphraGenSource } from "./renderCyphraGen.js";
import {
  formatDuration,
  formatLocalDateTime,
  formatLocalTime,
  formatTime,
  parseDuration,
  parseLocalDateTime,
  parseLocalTime,
  parseTime,
} from "./temporal.js";

const schema = `
node Place {
  id        String @id
  location  Point  @index
  grid      CartesianPoint?
  route     Point[]
  opens     LocalTime @default("09:00")
  closes    LocalTime?
  slot      Time @default(now())
  updated   LocalDateTime @default(now())
  starts    LocalDateTime? @default("2024-05-01T10:30")
  stay      Duration @default("PT90M")
  windows   Duration[]
  next      Place[] @relationship(type: "VISITED", direction: OUT)
}

relationship Visit {
  type "VISITED"
  from Place
  to   Place
  at   Point?
  when LocalDateTime?
  took Duration?
}
`;

describe("point and temporal types", () => {
  it("parses and resolves every new type, with lists and defaults", () => {
    const model = resolveSchema(parseSchema(schema));
    const place = getNodeModel(model, "Place")!;
    const field = (name: string) => place.fields.find((f) => f.name === name);
    expect(field("location")).toMatchObject({ type: "Point", index: true, optional: false });
    expect(field("grid")).toMatchObject({ type: "CartesianPoint", optional: true });
    expect(field("route")).toMatchObject({ type: "Point", list: true });
    // Temporal literal defaults are normalized to the form the runtime returns.
    expect(field("opens")).toMatchObject({
      type: "LocalTime",
      default: { kind: "literal", value: "09:00:00" },
    });
    expect(field("slot")).toMatchObject({ type: "Time", default: { kind: "fn", fn: "now" } });
    expect(field("updated")).toMatchObject({ default: { kind: "fn", fn: "now" } });
    expect(field("starts")).toMatchObject({
      default: { kind: "literal", value: "2024-05-01T10:30:00" },
    });
    expect(field("stay")).toMatchObject({
      type: "Duration",
      default: { kind: "literal", value: "PT1H30M" },
    });
    expect(model.relationships[0]!.properties.map((p) => p.type)).toEqual([
      "Point",
      "LocalDateTime",
      "Duration",
    ]);
  });

  it("round-trips through the printer", () => {
    const doc = parseSchema(schema);
    expect(parseSchema(printSchemaDocument(doc))).toEqual(doc);
  });

  it.each([
    [`d Duration @default(now())`, /@default\(now\(\)\) is not valid for type Duration/],
    [`p Point @default(now())`, /not valid for type Point/],
    [`t LocalTime @default("25:00")`, /not a valid LocalTime/],
    [`t Time @default("10:00")`, /not a valid Time .*"10:30:00\+02:00"/],
    [`t LocalDateTime @default("2024-02-30T10:00")`, /not a valid LocalDateTime/],
    [`d Duration @default("1 hour")`, /not a valid Duration/],
    [`p Point @default("0,0")`, /does not match type Point/],
  ])("rejects %s", (field, message) => {
    expect(() => resolveSchema(parseSchema(`node N { id String @id\n ${field} }`))).toThrow(
      message,
    );
  });

  it("keeps a node named like a new type usable as a relation target", () => {
    const doc = parseSchema(`
      node Point { id String @id }
      node Time { id String @id }
      node Map {
        id String @id
        points Point[] @relationship(type: "HAS", direction: OUT)
        time Time? @relationship(type: "AT", direction: OUT)
      }
    `);
    const map = doc.declarations[2] as NodeDeclaration;
    expect(map.fields[1]).toMatchObject({
      kind: "Relational",
      target: "Point",
      cardinality: "many",
    });
    expect(map.fields[2]).toMatchObject({ kind: "Relational", target: "Time", optional: true });
    expect(() => resolveSchema(doc)).not.toThrow();
  });

  it("rejects an enum named like a new type", () => {
    expect(() => resolveSchema(parseSchema(`enum Duration { SHORT LONG }`))).toThrow(
      SchemaValidationError,
    );
  });

  it("imports the runtime value types the fields use (aliased on a name clash)", () => {
    const out = renderCyphraGenSource(parseSchema(schema));
    expect(out).toContain(
      'import { createOrm, type LocalDateTime, type LocalTime, type Time, type Duration, type Point, type CartesianPoint, type OrmClient, type OrmOptions, type SchemaModel } from "cyphra";',
    );
    expect(out).toContain("  location: Point;");
    expect(out).toContain("  grid: CartesianPoint | null;");
    expect(out).toContain("  route: Point[];");
    expect(out).toContain("  stay: Duration;");
    expect(out).toContain("  when: LocalDateTime | null;");
  });

  it("aliases a runtime type whose name a declaration takes", () => {
    const out = renderCyphraGenSource(
      parseSchema(`
        node Shop { id String @id\n loc Point?\n near Shop[] @out(P) }
        relationship Point { type "P"\n from Shop\n to Shop\n at LocalTime? }
      `),
    );
    expect(out).toContain("type LocalTime, type Point as CyphraPoint, type OrmClient");
    expect(out).toContain("  loc: CyphraPoint | null;");
    expect(out).toContain("export type Point = {");
  });

  it("does not import value types when no field uses them", () => {
    const out = renderCyphraGenSource(parseSchema(`node A { id String @id }`));
    expect(out).toContain(
      'import { createOrm, type OrmClient, type OrmOptions, type SchemaModel } from "cyphra";',
    );
  });
});

describe("ISO 8601 temporal text", () => {
  it.each([
    ["2024-05-01T10:30", "2024-05-01T10:30:00"],
    ["2024-05-01T10:30:00.500", "2024-05-01T10:30:00.5"],
    ["2024-02-29T23:59:59.123456789", "2024-02-29T23:59:59.123456789"],
    ["+012024-01-01T00:00:00", "+012024-01-01T00:00:00"],
  ])("LocalDateTime %s → %s", (input, output) => {
    expect(formatLocalDateTime(parseLocalDateTime(input)!)).toBe(output);
  });

  it.each(["2023-02-29T10:00", "2024-13-01T10:00", "2024-05-01", "2024-05-01 10:30", "x"])(
    "rejects LocalDateTime %s",
    (input) => expect(parseLocalDateTime(input)).toBeNull(),
  );

  it.each([
    ["10:30", "10:30:00"],
    ["00:00:00.000000001", "00:00:00.000000001"],
    ["23:59:59,5", "23:59:59.5"],
  ])("LocalTime %s → %s", (input, output) => {
    expect(formatLocalTime(parseLocalTime(input)!)).toBe(output);
  });

  it.each(["24:00", "10:60", "10:30Z", "1:30"])("rejects LocalTime %s", (input) =>
    expect(parseLocalTime(input)).toBeNull(),
  );

  it.each([
    ["10:30Z", "10:30:00Z", 0],
    ["10:30:00+02:00", "10:30:00+02:00", 7200],
    ["10:30:00-0530", "10:30:00-05:30", -19800],
    ["10:30:00+00:00", "10:30:00Z", 0],
  ])("Time %s → %s", (input, output, offset) => {
    const p = parseTime(input)!;
    expect(p.offsetSeconds).toBe(offset);
    expect(formatTime(p)).toBe(output);
  });

  it.each(["10:30", "10:30+19:00", "10:30+02:75"])("rejects Time %s", (input) =>
    expect(parseTime(input)).toBeNull(),
  );

  it.each([
    ["P1Y2M3DT4H5M6.5S", "P1Y2M3DT4H5M6.5S"],
    ["PT90M", "PT1H30M"],
    ["P14M", "P1Y2M"],
    ["P2W", "P14D"],
    ["PT0S", "PT0S"],
    ["P0D", "PT0S"],
    ["-PT5M", "-PT5M"],
    ["-P1DT1.5S", "-P1DT1.5S"],
    ["P1M-3D", "P1M-3D"],
    ["PT-1.5S", "-PT1.5S"],
    ["PT36H", "PT36H"],
  ])("Duration %s → %s", (input, output) => {
    expect(formatDuration(parseDuration(input)!)).toBe(output);
  });

  it("splits a duration into months, days, seconds and nanoseconds like Neo4j", () => {
    expect(parseDuration("P1Y2M3DT4H5M6.5S")).toEqual({
      months: 14n,
      days: 3n,
      seconds: 14706n,
      nanoseconds: 500_000_000,
    });
    // Negative: seconds carry the sign, nanoseconds stay in [0, 1e9).
    expect(parseDuration("-PT1.5S")).toEqual({
      months: 0n,
      days: 0n,
      seconds: -2n,
      nanoseconds: 500_000_000,
    });
  });

  it.each(["P", "PT", "P1H", "PT1D", "1D", "P1.5D", "P1DT"])("rejects Duration %s", (input) =>
    expect(parseDuration(input)).toBeNull(),
  );
});
