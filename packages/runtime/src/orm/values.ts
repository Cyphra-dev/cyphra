import neo4j, { isDate, isDateTime, isInt, isLocalDateTime, type Integer } from "neo4j-driver";
import type { ResolvedScalarField, ScalarTypeName } from "@cyphra/schema";
import { CyphraValidationError } from "./errors.js";

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
export function utcDateTime(d: Date): InstanceType<typeof neo4j.types.DateTime> {
  return new neo4j.types.DateTime(
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

function encodeOne(type: ScalarTypeName, value: unknown, where: string): unknown {
  switch (type) {
    case "String":
      if (typeof value !== "string") break;
      return value;
    case "Boolean":
      if (typeof value !== "boolean") break;
      return value;
    case "Float":
      if (typeof value !== "number") break;
      return value;
    case "Int":
      if (typeof value === "number" && Number.isInteger(value)) return neo4j.int(value);
      if (typeof value === "bigint") return neo4j.int(value.toString());
      break;
    case "DateTime": {
      const d = typeof value === "string" ? new Date(value) : value;
      if (!(d instanceof Date) || Number.isNaN(d.getTime())) break;
      return utcDateTime(d);
    }
    case "Date": {
      const d = typeof value === "string" ? new Date(value) : value;
      if (!(d instanceof Date) || Number.isNaN(d.getTime())) break;
      return new neo4j.types.Date(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
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
  return arr as number[];
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
    return value.map((v, i) => encodeOne(field.type, v, `${where}[${i}]`));
  }
  return encodeOne(field.type, value, where);
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
  return encodeOne(field.type, value, `${owner}.${field.name}`);
}

function decodeOne(type: ScalarTypeName, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (isInt(value)) {
    return integerToNumber(value);
  }
  if (type === "Date" && isDate(value as object)) {
    const d = value as InstanceType<typeof neo4j.types.Date>;
    return new Date(Date.UTC(Number(d.year), Number(d.month) - 1, Number(d.day)));
  }
  if (isDateTime(value as object) || isLocalDateTime(value as object)) {
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
