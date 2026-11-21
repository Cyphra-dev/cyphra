import neo4j, { isDate, isDateTime, isInt, isLocalDateTime, type Integer } from "neo4j-driver";
import type { DefaultValueSpec, ResolvedScalarField, ScalarTypeName } from "@cyphra/schema";
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
  return neo4j.int(b.toString());
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

function encodeOne(field: ResolvedScalarField, value: unknown, where: string): unknown {
  const type = field.type;
  switch (type) {
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

function decodeOne(type: ScalarTypeName, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (type === "BigInt") return decodeBigInt(value);
  if (type === "Json") return decodeJson(value);
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
