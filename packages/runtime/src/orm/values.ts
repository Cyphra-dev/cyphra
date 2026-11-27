import {
  CypherDate,
  CypherDateTime,
  CypherDuration,
  CypherInteger,
  CypherLocalDateTime,
  CypherLocalTime,
  CypherPoint,
  CypherTime,
  isDate,
  isDateTime,
  isDuration,
  isInt,
  isLocalDateTime,
  isLocalTime,
  isPoint,
  isTime,
  markVector,
  type IntegerLike as Integer,
} from "../cypher-values.js";
import {
  TEMPORAL_EXAMPLES,
  formatDuration,
  formatLocalDateTime,
  formatLocalTime,
  formatTime,
  parseDuration,
  parseLocalDateTime,
  parseLocalTime,
  parseTime,
  type DefaultValueSpec,
  type IsoTemporalType,
  type ResolvedScalarField,
  type ScalarTypeName,
} from "@cyphra/schema";
import { CyphraValidationError } from "./errors.js";

/**
 * A `DateTime` value given as text and parsed by the database (`datetime($text)`), keeping the
 * offset and the precision the text has (a JS `Date` is UTC milliseconds). Internal, for
 * `@cyphra/graphql`'s `compat.v7`, whose v7 statements pass DateTime inputs that way; accepted
 * wherever the client takes a `DateTime` value (filters, `createMany` / `updateMany` data). Not
 * covered by semantic versioning.
 *
 * @internal
 */
export class CypherDateTimeText {
  constructor(readonly text: string) {
    if (typeof text !== "string") {
      throw new CyphraValidationError("CypherDateTimeText: the text must be a string.");
    }
  }
}

/**
 * Convert a driver Integer to a JS number, refusing silent precision loss.
 *
 * @throws {RangeError} When the value is outside `Number.MAX_SAFE_INTEGER`.
 */
export function integerToNumber(v: Integer): number {
  if (!v.inSafeRange()) {
    throw new RangeError(`Neo4j integer ${v.toString()} is outside the JS safe integer range.`);
  }
  return v.toNumber();
}

/** A Cypher `count()` / `COUNT {}` result as a JS number (`0` when absent). */
export function decodeCount(v: unknown): number {
  return isInt(v) ? integerToNumber(v) : Number(v ?? 0);
}

/**
 * A driver `DateTime` for the instant `d`, always at UTC offset 0.
 *
 * `DateTime.fromStandardDate` uses the offset of the process's local time zone, and Cypher's `=`
 * and ordering on datetimes take the offset into account: `2024-01-01T00:00Z` is not equal to the
 * same instant written as `2023-12-31T19:00-05:00`. Writing every value (and every filter
 * parameter) in UTC keeps comparisons independent of the server's `TZ`.
 */
export function utcDateTime(d: Date): CypherDateTime {
  return new CypherDateTime(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds() * 1_000_000,
    0,
  );
}

/** Smallest and largest `BigInt` values (a Neo4j 64-bit `INTEGER`). */
export const BIGINT_MIN = -(2n ** 63n);
export const BIGINT_MAX = 2n ** 63n - 1n;

/**
 * Check a `BigInt` value: a JS `bigint` (or a safe-integer `number`) from -2^63 to 2^63-1.
 * It goes over the wire as a driver `Integer`, so the property is stored as a Cypher `INTEGER`.
 */
function encodeBigInt(value: unknown, where: string): unknown {
  let b: bigint | undefined;
  if (typeof value === "bigint") b = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) b = BigInt(value);
  else if (isInt(value)) b = BigInt((value as Integer).toString());
  if (b === undefined) {
    throw new CyphraValidationError(
      `${where}: expected BigInt (a bigint), got ${describe(value)}.`,
    );
  }
  if (b < BIGINT_MIN || b > BIGINT_MAX) {
    throw new CyphraValidationError(
      `${where}: ${b} is outside the 64-bit integer range (-2^63 to 2^63-1).`,
    );
  }
  return new CypherInteger(b);
}

/** A `Json` value as its JSON text (the stored string property). */
function encodeJson(value: unknown, where: string): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (e) {
    throw new CyphraValidationError(
      `${where}: value is not JSON-serializable (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
  if (text === undefined) {
    throw new CyphraValidationError(`${where}: expected a JSON value, got ${describe(value)}.`);
  }
  return text;
}

/** Spatial reference ids of the point types (2D, 3D). */
export const SRID = {
  wgs84: 4326,
  wgs84_3d: 4979,
  cartesian: 7203,
  cartesian_3d: 9157,
} as const;

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function onlyKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(v).every((k) => keys.includes(k) || v[k] === undefined);
}

const WGS84_KEYS = ["longitude", "latitude", "height"] as const;
const CARTESIAN_KEYS = ["x", "y", "z"] as const;

/**
 * `true` when `v` looks like a point value of `type` (only coordinate keys), as opposed to a
 * filter object (`{ distance }`, `{ equals }`, …).
 */
export function isPointValue(type: ScalarTypeName, v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return type === "Point"
    ? "longitude" in o && "latitude" in o && onlyKeys(o, WGS84_KEYS)
    : "x" in o && "y" in o && onlyKeys(o, CARTESIAN_KEYS);
}

/** A `Point` / `CartesianPoint` value as a driver `Point` (2D, or 3D with `height` / `z`). */
function encodePoint(type: "Point" | "CartesianPoint", value: unknown, where: string): unknown {
  const expected = type === "Point" ? "{ longitude, latitude, height? }" : "{ x, y, z? }";
  if (!isPointValue(type, value)) {
    throw new CyphraValidationError(
      `${where}: expected a ${type} ${expected}, got ${describe(value)}.`,
    );
  }
  const o = value as Record<string, unknown>;
  const [a, b, c] = type === "Point" ? [o.longitude, o.latitude, o.height] : [o.x, o.y, o.z];
  if (!finite(a) || !finite(b) || (c !== undefined && c !== null && !finite(c))) {
    throw new CyphraValidationError(`${where}: ${type} coordinates must be finite numbers.`);
  }
  if (type === "Point" && (a < -180 || a > 180 || b < -90 || b > 90)) {
    throw new CyphraValidationError(
      `${where}: longitude must be within [-180, 180] and latitude within [-90, 90] (got ${a}, ${b}).`,
    );
  }
  const has3d = c !== undefined && c !== null;
  const srid =
    type === "Point"
      ? has3d
        ? SRID.wgs84_3d
        : SRID.wgs84
      : has3d
        ? SRID.cartesian_3d
        : SRID.cartesian;
  return has3d ? new CypherPoint(srid, a, b, c) : new CypherPoint(srid, a, b);
}

/**
 * `LocalDateTime` / `LocalTime` / `Time` / `Duration` ISO 8601 text as the driver temporal value
 * (so Neo4j stores, compares and sorts a temporal value, not a string).
 */
function encodeTemporal(type: IsoTemporalType, value: unknown, where: string): unknown {
  const fail = (): never => {
    throw new CyphraValidationError(
      `${where}: expected ${type} as ISO 8601 text (e.g. "${TEMPORAL_EXAMPLES[type]}"), got ${typeof value === "string" ? JSON.stringify(value) : describe(value)}.`,
    );
  };
  if (typeof value !== "string") return fail();
  switch (type) {
    case "LocalDateTime": {
      const p = parseLocalDateTime(value) ?? fail();
      return new CypherLocalDateTime(
        p.year,
        p.month,
        p.day,
        p.hour,
        p.minute,
        p.second,
        p.nanosecond,
      );
    }
    case "LocalTime": {
      const p = parseLocalTime(value) ?? fail();
      return new CypherLocalTime(p.hour, p.minute, p.second, p.nanosecond);
    }
    case "Time": {
      const p = parseTime(value) ?? fail();
      return new CypherTime(p.hour, p.minute, p.second, p.nanosecond, p.offsetSeconds);
    }
    case "Duration": {
      const p = parseDuration(value) ?? fail();
      return new CypherDuration(p.months, p.days, p.seconds, p.nanoseconds);
    }
  }
}

/**
 * The value of `@default(now())` for `field`: a `Date` for `DateTime` / `Date`, the current UTC
 * wall-clock time as ISO 8601 text for `LocalDateTime` / `LocalTime` / `Time` (`Time` at `Z`), the
 * same as Cypher's `localdatetime()` / `localtime()` / `time()` with Neo4j's default time zone
 * (UTC).
 */
export function nowValue(field: ResolvedScalarField, now = new Date()): unknown {
  const iso = now.toISOString(); // 2024-05-01T10:30:00.123Z
  switch (field.type) {
    case "LocalDateTime":
      return iso.slice(0, 23);
    case "LocalTime":
      return iso.slice(11, 23);
    case "Time":
      return `${iso.slice(11, 23)}Z`;
    default:
      return now;
  }
}

function encodeOne(field: ResolvedScalarField, value: unknown, where: string): unknown {
  const type = field.type;
  if (value instanceof CypherDateTimeText) {
    if (type === "DateTime") return value;
    throw new CyphraValidationError(`${where}: a DateTime text for a ${type} field.`);
  }
  switch (type) {
    case "LocalDateTime":
    case "LocalTime":
    case "Time":
    case "Duration":
      return encodeTemporal(type, value, where);
    case "Point":
    case "CartesianPoint":
      return encodePoint(type, value, where);
    case "String":
      if (typeof value !== "string") break;
      return value;
    case "Enum": {
      const values = field.enumValues ?? [];
      if (typeof value === "string" && values.includes(value)) return value;
      throw new CyphraValidationError(
        `${where}: expected one of ${values.map((v) => JSON.stringify(v)).join(", ")} (enum ${field.enum}), got ${typeof value === "string" ? JSON.stringify(value) : describe(value)}.`,
      );
    }
    case "BigInt":
      return encodeBigInt(value, where);
    case "Json":
      return encodeJson(value, where);
    case "Boolean":
      if (typeof value !== "boolean") break;
      return value;
    case "Float":
      if (typeof value !== "number") break;
      return value;
    case "Int":
      if (typeof value === "number" && Number.isInteger(value) && Math.abs(value) < 2 ** 63)
        return new CypherInteger(value);
      if (typeof value === "bigint" && value >= BIGINT_MIN && value <= BIGINT_MAX)
        return new CypherInteger(value);
      break;
    case "DateTime": {
      const d = typeof value === "string" ? new Date(value) : value;
      if (!(d instanceof Date) || Number.isNaN(d.getTime())) break;
      return utcDateTime(d);
    }
    case "Date": {
      const d = typeof value === "string" ? new Date(value) : value;
      if (!(d instanceof Date) || Number.isNaN(d.getTime())) break;
      return new CypherDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
  }
  throw new CyphraValidationError(`${where}: expected ${type}, got ${describe(value)}.`);
}

/**
 * Check a `Vector(N)` value: an array of exactly `dimensions` finite numbers. JS numbers go over
 * the wire as Cypher floats, so the property is stored as `LIST<FLOAT>`, which vector indexes read.
 *
 * @throws {CyphraValidationError} On a wrong length or a non-finite / non-number element.
 */
export function encodeVector(value: unknown, dimensions: number, where: string): number[] {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) {
    throw new CyphraValidationError(
      `${where}: expected a vector (number[] of length ${dimensions}), got ${describe(value)}.`,
    );
  }
  const arr = Array.from(value as ArrayLike<unknown>);
  if (arr.length !== dimensions) {
    throw new CyphraValidationError(
      `${where}: expected a vector of ${dimensions} dimensions, got ${arr.length}.`,
    );
  }
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i];
    if (typeof x !== "number" || !Number.isFinite(x)) {
      throw new CyphraValidationError(`${where}[${i}]: expected a finite number.`);
    }
  }
  // Marked: the FalkorDB transport stores it as a vector (`vecf32`), not as a list.
  return markVector(arr as number[]);
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (v instanceof Date) return "Date";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Encode a JS value for a scalar field into a driver parameter value.
 * `null` / `undefined` encode to `null` (which removes the property when used with `SET n += $map`).
 */
export function encodeScalar(field: ResolvedScalarField, value: unknown, owner: string): unknown {
  const where = `${owner}.${field.name}`;
  if (value === null || value === undefined) {
    if (!field.optional && !field.list && value === null) {
      throw new CyphraValidationError(`${where}: field is required and cannot be null.`);
    }
    return null;
  }
  if (field.type === "Vector") return encodeVector(value, field.dimensions ?? 0, where);
  if (field.list) {
    if (!Array.isArray(value)) {
      throw new CyphraValidationError(`${where}: expected an array.`);
    }
    return value.map((v, i) => encodeOne(field, v, `${where}[${i}]`));
  }
  return encodeOne(field, value, where);
}

/**
 * The JS value of a literal `@default(...)` of `field`, ready for {@link encodeScalar}: a
 * `BigInt` default (decimal digits) becomes a `bigint`, a `Json` default (JSON text) its parsed value.
 */
export function defaultLiteralValue(
  field: ResolvedScalarField,
  d: Extract<DefaultValueSpec, { kind: "literal" }>,
): unknown {
  if (field.type === "BigInt") return BigInt(d.value as string | number);
  if (field.type === "Json") return JSON.parse(String(d.value));
  return d.value;
}

/** Encode a value used inside a filter (compared against `field`), element-wise for lists. */
export function encodeFilterValue(
  field: ResolvedScalarField,
  value: unknown,
  owner: string,
): unknown {
  if (field.type === "Vector") {
    throw new CyphraValidationError(
      `${owner}.${field.name}: Vector fields can only be filtered on null (use findSimilar to search them).`,
    );
  }
  return encodeOne(field, value, `${owner}.${field.name}`);
}

/** A stored `BigInt` as a JS `bigint` (whatever integer representation the driver returns). */
function decodeBigInt(value: unknown): unknown {
  if (isInt(value)) return BigInt((value as Integer).toString());
  if (typeof value === "number") {
    // A float here is a `sum()` that overflowed 64 bits (Neo4j then returns a FLOAT).
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(
        `Neo4j value ${value} is not an exact 64-bit integer (BigInt overflow?).`,
      );
    }
    return BigInt(value);
  }
  return value;
}

/** A stored `Json` string parsed back into its value (text that is not JSON is returned as is). */
function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return toNative(value);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** A driver integer-ish value (`Integer`, `number` or `bigint`) as a `bigint`. */
function big(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  return BigInt(String(v));
}

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(big(v));
}

type DriverTime = {
  hour: unknown;
  minute: unknown;
  second: unknown;
  nanosecond: unknown;
};

function timeOf(v: DriverTime) {
  return {
    hour: num(v.hour),
    minute: num(v.minute),
    second: num(v.second),
    nanosecond: num(v.nanosecond),
  };
}

/** A driver `Point` as `{ longitude, latitude, height? }` (WGS-84) or `{ x, y, z? }` (Cartesian). */
export function decodePoint(value: unknown): unknown {
  const p = value as { srid: unknown; x: number; y: number; z?: number | null };
  const srid = num(p.srid);
  const has3d = p.z !== undefined && p.z !== null && !Number.isNaN(p.z);
  if (srid === SRID.wgs84 || srid === SRID.wgs84_3d) {
    return has3d
      ? { longitude: p.x, latitude: p.y, height: p.z }
      : { longitude: p.x, latitude: p.y };
  }
  return has3d ? { x: p.x, y: p.y, z: p.z } : { x: p.x, y: p.y };
}

/** A driver temporal value of a `LocalDateTime` / `LocalTime` / `Time` / `Duration` field as ISO text. */
function decodeTemporal(type: IsoTemporalType, value: unknown): unknown {
  const v = value as Record<string, unknown>;
  if (type === "Duration" && isDuration(value)) {
    return formatDuration({
      months: big(v.months),
      days: big(v.days),
      seconds: big(v.seconds),
      nanoseconds: num(v.nanoseconds),
    });
  }
  if (type === "LocalTime" && isLocalTime(value)) return formatLocalTime(timeOf(v as DriverTime));
  if (type === "Time" && isTime(value)) {
    return formatTime({ ...timeOf(v as DriverTime), offsetSeconds: num(v.timeZoneOffsetSeconds) });
  }
  if (type === "LocalDateTime" && isLocalDateTime(value)) {
    return formatLocalDateTime({
      year: num(v.year),
      month: num(v.month),
      day: num(v.day),
      ...timeOf(v as DriverTime),
    });
  }
  return toNative(value);
}

/** A `DateTime` / `Date` stored as ISO 8601 text (FalkorDB, which has no zoned datetime type). */
const ISO_DATETIME = /^[+-]?\d{4,6}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ISO_DATE = /^[+-]?\d{4,6}-\d{2}-\d{2}$/;

/** A temporal component (a JS number, or a driver Integer when integers are lossless). */
function part(x: unknown): number {
  if (typeof x === "number") return x;
  return isInt(x) ? (x as Integer).toNumber() : NaN;
}

/**
 * A driver `DateTime` as a JS `Date`, computed from its fields: `neo4j-driver`'s
 * `toStandardDate()` formats the value as ISO text and parses it back, which costs several
 * microseconds per value (most of the time spent decoding a row of datetimes). Falls back to
 * `toStandardDate()` for anything this does not handle (no UTC offset: a zone id only).
 */
function dateTimeToDate(v: object): Date {
  const t = v as Record<string, unknown>;
  const offset = part(t.timeZoneOffsetSeconds);
  const year = part(t.year);
  const ms = Date.UTC(
    2000,
    part(t.month) - 1,
    part(t.day),
    part(t.hour),
    part(t.minute),
    part(t.second),
    Math.floor(part(t.nanosecond) / 1_000_000),
  );
  if (Number.isNaN(ms) || Number.isNaN(offset) || Number.isNaN(year)) {
    return (v as { toStandardDate(): Date }).toStandardDate();
  }
  const d = new Date(ms);
  d.setUTCFullYear(year);
  d.setTime(d.getTime() - offset * 1000);
  return d;
}

function decodeOne(type: ScalarTypeName, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (type === "DateTime" && ISO_DATETIME.test(value)) return new Date(value);
    if (type === "Date" && ISO_DATE.test(value)) return new Date(`${value}T00:00:00.000Z`);
  }
  if (type === "BigInt") return decodeBigInt(value);
  if (type === "Json") return decodeJson(value);
  if (type === "LocalDateTime" || type === "LocalTime" || type === "Time" || type === "Duration") {
    return decodeTemporal(type, value);
  }
  if ((type === "Point" || type === "CartesianPoint") && isPoint(value)) return decodePoint(value);
  if (isInt(value)) {
    return integerToNumber(value);
  }
  if (type === "Date" && isDate(value as object)) {
    const d = value as { year: unknown; month: unknown; day: unknown };
    return new Date(Date.UTC(Number(d.year), Number(d.month) - 1, Number(d.day)));
  }
  if (isDateTime(value as object)) return dateTimeToDate(value as object);
  if (isLocalDateTime(value as object)) {
    return (value as { toStandardDate(): Date }).toStandardDate();
  }
  return value;
}

/** Decode a property value read from Neo4j according to its schema field. */
export function decodeScalar(field: ResolvedScalarField, value: unknown): unknown {
  if (field.type === "Vector") {
    if (value === null || value === undefined) return null;
    return Array.from(value as ArrayLike<unknown>, (x) => (isInt(x) ? integerToNumber(x) : x));
  }
  if (field.list) {
    if (value === null || value === undefined) return [];
    return (value as unknown[]).map((v) => decodeOne(field.type, v));
  }
  return decodeOne(field.type, value);
}

/**
 * Best-effort conversion of arbitrary driver values to plain JS: integers → number,
 * temporal values → `Date`, nodes/relationships → their properties. Used for raw queries.
 */
export function toNative(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (isInt(value)) return integerToNumber(value);
  if (Array.isArray(value)) return value.map(toNative);
  if (typeof value !== "object") return value;
  if (isDate(value)) return decodeOne("Date", value);
  if (isDateTime(value) || isLocalDateTime(value)) return decodeOne("DateTime", value);
  const v = value as Record<string, unknown>;
  if ("properties" in v && ("labels" in v || "type" in v) && "elementId" in v) {
    return toNative(v.properties);
  }
  if (Object.getPrototypeOf(v) !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = toNative(x);
  return out;
}
