/**
 * Neo4j Query API typed JSON (`application/vnd.neo4j.query`): every value is `{ $type, _value }`.
 *
 * Parameters are encoded from JS values, {@link CypherInteger} & co. (what the ORM produces) or
 * `neo4j-driver` values (recognised by their structural markers). Results decode into the
 * driver-agnostic classes of `cypher-values.ts`, which the ORM's decoders read the same way as
 * `neo4j-driver` values.
 *
 * Only `fetch`-era globals are used (`btoa`, `atob`, `TextEncoder`): no `Buffer`.
 *
 * @packageDocumentation
 */

import { parseDuration } from "@cyphra/schema";
import {
  CypherDate,
  CypherDateTime,
  CypherDuration,
  CypherInteger,
  CypherLocalDateTime,
  CypherLocalTime,
  CypherNode,
  CypherPath,
  CypherPathSegment,
  CypherPoint,
  CypherRelationship,
  CypherTime,
  isDate,
  isDateTime,
  isDuration,
  isInt,
  isLocalDateTime,
  isLocalTime,
  isNode,
  isPath,
  isPoint,
  isRelationship,
  isTime,
  offsetText,
} from "../cypher-values.js";

/** One typed JSON value. */
export type TypedValue = { $type: string; _value: unknown };

/** Thrown when a value cannot be sent as a Query API parameter, or a result is malformed. */
export class TypedJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypedJsonError";
  }
}

// ---------------------------------------------------------------------------------------------
// Base64 (bytes)

/** Bytes as standard base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Standard base64 as bytes. */
export function base64ToBytes(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** UTF-8 text as base64 (`btoa` alone only takes Latin-1). */
export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

// ---------------------------------------------------------------------------------------------
// Encoding

type AnyRecord = Record<string, unknown>;

const num = (v: unknown): number =>
  typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : Number(String(v));

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function frac(ns: number): string {
  return ns ? `.${pad(ns, 9)}` : "";
}

function dateText(year: number, month: number, day: number): string {
  const y =
    year >= 0 && year <= 9999 ? pad(year, 4) : `${year < 0 ? "-" : "+"}${pad(Math.abs(year), 6)}`;
  return `${y}-${pad(month)}-${pad(day)}`;
}

function timeText(v: AnyRecord): string {
  return `${pad(num(v.hour))}:${pad(num(v.minute))}:${pad(num(v.second))}${frac(num(v.nanosecond))}`;
}

function floatText(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  return String(x);
}

function srid(v: AnyRecord): number {
  return num(v.srid);
}

function encodeStructural(v: AnyRecord): TypedValue | undefined {
  if (isInt(v)) return { $type: "Integer", _value: v.toString() };
  if (isDate(v)) {
    return { $type: "Date", _value: dateText(num(v.year), num(v.month), num(v.day)) };
  }
  if (isLocalTime(v)) return { $type: "LocalTime", _value: timeText(v) };
  if (isTime(v)) {
    return { $type: "Time", _value: timeText(v) + offsetText(num(v.timeZoneOffsetSeconds)) };
  }
  if (isLocalDateTime(v)) {
    return {
      $type: "LocalDateTime",
      _value: `${dateText(num(v.year), num(v.month), num(v.day))}T${timeText(v)}`,
    };
  }
  if (isDateTime(v)) {
    const local = `${dateText(num(v.year), num(v.month), num(v.day))}T${timeText(v)}`;
    const offset = v.timeZoneOffsetSeconds;
    const zone = typeof v.timeZoneId === "string" && v.timeZoneId ? v.timeZoneId : undefined;
    if (offset === undefined || offset === null) {
      throw new TypedJsonError(
        `DateTime ${local}[${zone ?? "?"}] has no UTC offset: the Query API needs one.`,
      );
    }
    const off = offsetText(num(offset));
    return zone
      ? { $type: "ZonedDateTime", _value: `${local}${off}[${zone}]` }
      : { $type: "OffsetDateTime", _value: `${local}${off}` };
  }
  if (isDuration(v)) {
    const d = new CypherDuration(
      BigInt(String(v.months)),
      BigInt(String(v.days)),
      BigInt(String(v.seconds)),
      num(v.nanoseconds),
    );
    return { $type: "Duration", _value: d.toString() };
  }
  if (isPoint(v)) {
    const z = v.z;
    const has3d = z !== undefined && z !== null && !Number.isNaN(z);
    return {
      $type: "Point",
      _value: has3d
        ? `SRID=${srid(v)};POINT Z (${floatText(num(v.x))} ${floatText(num(v.y))} ${floatText(num(z))})`
        : `SRID=${srid(v)};POINT (${floatText(num(v.x))} ${floatText(num(v.y))})`,
    };
  }
  if (isNode(v) || isRelationship(v) || isPath(v)) {
    throw new TypedJsonError("Nodes, relationships and paths cannot be sent as parameters.");
  }
  return undefined;
}

/**
 * Encode one parameter value. JS numbers are sent as `Float` (as `neo4j-driver` does); send an
 * `Integer` with a `bigint`, a {@link CypherInteger} or a driver `Integer`. A JS `Date` is sent as
 * an `OffsetDateTime` at UTC.
 */
export function encodeTyped(value: unknown): TypedValue {
  if (value === null || value === undefined) return { $type: "Null", _value: null };
  switch (typeof value) {
    case "boolean":
      return { $type: "Boolean", _value: value };
    case "number":
      return { $type: "Float", _value: floatText(value) };
    case "bigint":
      return { $type: "Integer", _value: new CypherInteger(value).toString() };
    case "string":
      return { $type: "String", _value: value };
    case "object":
      break;
    default:
      throw new TypedJsonError(`Cannot send a ${typeof value} as a query parameter.`);
  }
  if (Array.isArray(value)) return { $type: "List", _value: value.map(encodeTyped) };
  if (value instanceof Int8Array || value instanceof Uint8Array) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { $type: "Base64", _value: bytesToBase64(bytes) };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      $type: "List",
      _value: Array.from(value as unknown as ArrayLike<number>, (x) => encodeTyped(x)),
    };
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypedJsonError("Invalid Date parameter.");
    return { $type: "OffsetDateTime", _value: value.toISOString() };
  }
  const structural = encodeStructural(value as AnyRecord);
  if (structural) return structural;
  const out: Record<string, TypedValue> = {};
  for (const [k, x] of Object.entries(value as AnyRecord)) out[k] = encodeTyped(x);
  return { $type: "Map", _value: out };
}

/** Encode a parameter map (`{ name: value }` → `{ name: { $type, _value } }`). */
export function encodeParameters(params: AnyRecord | undefined): Record<string, TypedValue> {
  const out: Record<string, TypedValue> = {};
  if (!params) return out;
  for (const [k, v] of Object.entries(params)) out[k] = encodeTyped(v);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Decoding

const DATE_RE = /^([+-]?\d{4,})-(\d{2})-(\d{2})$/;
const TIME_PART = String.raw`(\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?`;
const OFFSET_PART = String.raw`(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)`;
const LOCAL_TIME_RE = new RegExp(`^${TIME_PART}$`);
const TIME_RE = new RegExp(`^${TIME_PART}${OFFSET_PART}$`);
const LOCAL_DATE_TIME_RE = new RegExp(String.raw`^([+-]?\d{4,})-(\d{2})-(\d{2})T${TIME_PART}$`);
const DATE_TIME_RE = new RegExp(
  String.raw`^([+-]?\d{4,})-(\d{2})-(\d{2})T${TIME_PART}${OFFSET_PART}?(?:\[([^\]]+)\])?$`,
);
const POINT_RE =
  /^SRID=(\d+);\s*POINT\s*(Z\s*)?\(\s*([^\s()]+)\s+([^\s()]+)(?:\s+([^\s()]+))?\s*\)$/i;

function fail(type: string, value: unknown): never {
  throw new TypedJsonError(`Malformed ${type} value from the Query API: ${JSON.stringify(value)}.`);
}

function nanos(fraction: string | undefined): number {
  return fraction ? Number(fraction.padEnd(9, "0")) : 0;
}

function timeOf(m: RegExpExecArray, at: number) {
  return {
    hour: Number(m[at]),
    minute: Number(m[at + 1]),
    second: m[at + 2] === undefined ? 0 : Number(m[at + 2]),
    nanosecond: nanos(m[at + 3]),
  };
}

function offsetSeconds(text: string): number {
  if (text === "Z" || text === "z") return 0;
  const digits = text.slice(1).replace(/:/g, "");
  const s =
    Number(digits.slice(0, 2)) * 3600 +
    Number(digits.slice(2, 4) || "0") * 60 +
    Number(digits.slice(4, 6) || "0");
  return text[0] === "-" ? -s : s;
}

function str(type: string, v: unknown): string {
  return typeof v === "string" ? v : fail(type, v);
}

function decodeNode(v: unknown): CypherNode {
  const o = (v ?? {}) as AnyRecord;
  if (typeof o._element_id !== "string") fail("Node", v);
  return new CypherNode(
    o._element_id as string,
    Array.isArray(o._labels) ? (o._labels as string[]) : [],
    decodeMap(o._properties),
  );
}

function decodeRelationship(v: unknown): CypherRelationship {
  const o = (v ?? {}) as AnyRecord;
  if (typeof o._element_id !== "string") fail("Relationship", v);
  return new CypherRelationship(
    o._element_id as string,
    String(o._type),
    String(o._start_node_element_id),
    String(o._end_node_element_id),
    decodeMap(o._properties),
  );
}

function decodeMap(v: unknown): AnyRecord {
  const out: AnyRecord = {};
  if (typeof v !== "object" || v === null) return out;
  for (const [k, x] of Object.entries(v as AnyRecord)) out[k] = decodeTyped(x);
  return out;
}

function decodePath(v: unknown): CypherPath {
  if (!Array.isArray(v) || v.length === 0) fail("Path", v);
  const items = (v as unknown[]).map(decodeTyped);
  const nodes = items.filter((_, i) => i % 2 === 0) as CypherNode[];
  const rels = items.filter((_, i) => i % 2 === 1) as CypherRelationship[];
  if (!nodes.every((x) => x instanceof CypherNode)) fail("Path", v);
  if (!rels.every((x) => x instanceof CypherRelationship)) fail("Path", v);
  const segments = rels.map((r, i) => new CypherPathSegment(nodes[i]!, r, nodes[i + 1]!));
  return new CypherPath(nodes[0]!, nodes[nodes.length - 1]!, segments);
}

/**
 * Decode one typed JSON value. Integers become {@link CypherInteger}, temporal values, points and
 * graph entities the matching `Cypher*` class, bytes an `Int8Array` (like `neo4j-driver`).
 * A value without `$type` is returned as is (plain JSON).
 */
export function decodeTyped(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("$type" in value)) return value;
  const { $type: type, _value: v } = value as TypedValue;
  switch (type) {
    case "Null":
      return null;
    case "Boolean":
    case "String":
      return v;
    case "Integer":
      return new CypherInteger(str(type, v));
    case "Float":
      return typeof v === "number" ? v : Number(str(type, v));
    case "Base64": {
      const bytes = base64ToBytes(str(type, v));
      return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    case "List":
      return Array.isArray(v) ? v.map(decodeTyped) : fail(type, v);
    case "Map":
      return decodeMap(v);
    case "Date": {
      const m = DATE_RE.exec(str(type, v)) ?? fail(type, v);
      return new CypherDate(Number(m[1]), Number(m[2]), Number(m[3]));
    }
    case "LocalTime": {
      const m = LOCAL_TIME_RE.exec(str(type, v)) ?? fail(type, v);
      const t = timeOf(m, 1);
      return new CypherLocalTime(t.hour, t.minute, t.second, t.nanosecond);
    }
    case "Time": {
      const m = TIME_RE.exec(str(type, v)) ?? fail(type, v);
      const t = timeOf(m, 1);
      return new CypherTime(t.hour, t.minute, t.second, t.nanosecond, offsetSeconds(m[5]!));
    }
    case "LocalDateTime": {
      const m = LOCAL_DATE_TIME_RE.exec(str(type, v)) ?? fail(type, v);
      const t = timeOf(m, 4);
      return new CypherLocalDateTime(
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
        t.hour,
        t.minute,
        t.second,
        t.nanosecond,
      );
    }
    case "DateTime":
    case "OffsetDateTime":
    case "ZonedDateTime": {
      const m = DATE_TIME_RE.exec(str(type, v)) ?? fail(type, v);
      if (m[8] === undefined && m[9] === undefined) fail(type, v);
      const t = timeOf(m, 4);
      return new CypherDateTime(
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
        t.hour,
        t.minute,
        t.second,
        t.nanosecond,
        m[8] === undefined ? undefined : offsetSeconds(m[8]),
        m[9],
      );
    }
    case "Duration": {
      const d = parseDuration(str(type, v)) ?? fail(type, v);
      return new CypherDuration(d.months, d.days, d.seconds, d.nanoseconds);
    }
    case "Point": {
      const m = POINT_RE.exec(str(type, v)) ?? fail(type, v);
      const [x, y] = [Number(m[3]), Number(m[4])];
      return m[5] === undefined
        ? new CypherPoint(Number(m[1]), x, y)
        : new CypherPoint(Number(m[1]), x, y, Number(m[5]));
    }
    case "Node":
      return decodeNode(v);
    case "Relationship":
      return decodeRelationship(v);
    case "Path":
      return decodePath(v);
    case "Vector": {
      const o = (v ?? {}) as { coordinates?: unknown };
      return Array.isArray(o.coordinates) ? o.coordinates.map((c) => Number(c)) : fail(type, v);
    }
    default:
      // Types newer than this client (e.g. `UUID`): keep the raw value.
      return v;
  }
}
