/**
 * Cypher values without `neo4j-driver`: integers, temporal types, points and graph entities.
 *
 * The ORM encodes parameters into these classes, and the HTTP transport decodes Query API results
 * into them, so the ORM runs where `neo4j-driver` cannot be loaded (Vercel Edge, Cloudflare
 * Workers). Each class carries the same structural marker as its `neo4j-driver` counterpart
 * (`__isInteger__`, `__isDateTime__`, …) and exposes the same fields, which is all the driver's
 * Bolt encoder reads: a `CypherInteger` or `CypherDateTime` passed to `neo4j-driver` 5.28+ / 6.x is
 * sent as a Cypher `INTEGER` / `DATETIME`, exactly like `neo4j.int()` / `new neo4j.types.DateTime()`.
 *
 * The `isX` guards below recognise both these classes and the driver's own values.
 *
 * @packageDocumentation
 */

import { formatDuration } from "@cyphra/schema";

function marker(proto: object, name: string): void {
  Object.defineProperty(proto, name, { value: true, enumerable: false, writable: false });
}

function hasMarker(v: unknown, name: string): boolean {
  return typeof v === "object" && v !== null && (v as Record<string, unknown>)[name] === true;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  return BigInt(String(v));
}

/**
 * A 64-bit Cypher `INTEGER`. JS numbers go over the wire as `FLOAT`; wrap a whole number in a
 * `CypherInteger` (or pass a `bigint`) to send an `INTEGER`.
 */
export class CypherInteger {
  readonly value: bigint;

  constructor(value: bigint | number | string) {
    const v = toBigInt(value);
    if (v < INT64_MIN || v > INT64_MAX) {
      throw new RangeError(`${v} is outside the 64-bit integer range.`);
    }
    this.value = v;
  }

  /** Low 32 bits, signed (read by `neo4j-driver`'s `Integer.fromValue` and Bolt encoder). */
  get low(): number {
    return Number(BigInt.asIntN(32, this.value));
  }

  /** High 32 bits, signed. */
  get high(): number {
    return Number(BigInt.asIntN(32, this.value >> 32n));
  }

  /** `true` when the value fits a JS number exactly. */
  inSafeRange(): boolean {
    return (
      this.value >= BigInt(Number.MIN_SAFE_INTEGER) && this.value <= BigInt(Number.MAX_SAFE_INTEGER)
    );
  }

  toNumber(): number {
    return Number(this.value);
  }

  toNumberOrInfinity(): number {
    if (this.inSafeRange()) return Number(this.value);
    return this.value > 0n ? Infinity : -Infinity;
  }

  toInt(): number {
    return Number(BigInt.asIntN(32, this.value));
  }

  toBigInt(): bigint {
    return this.value;
  }

  toString(radix?: number): string {
    return this.value.toString(radix);
  }

  toJSON(): string {
    return this.value.toString();
  }

  valueOf(): bigint {
    return this.value;
  }

  equals(other: unknown): boolean {
    return this.value === toBigInt(other);
  }

  compare(other: unknown): number {
    const o = toBigInt(other);
    return this.value < o ? -1 : this.value > o ? 1 : 0;
  }

  lessThan(other: unknown): boolean {
    return this.compare(other) < 0;
  }

  greaterThanOrEqual(other: unknown): boolean {
    return this.compare(other) >= 0;
  }
}
marker(CypherInteger.prototype, "__isInteger__");

/** Wrap a whole number, `bigint` or decimal string as a Cypher `INTEGER`. */
export function int(value: bigint | number | string): CypherInteger {
  return new CypherInteger(value);
}

function pad(n: number, width = 2): string {
  const s = String(Math.abs(n)).padStart(width, "0");
  return n < 0 ? `-${s}` : s;
}

/** Nanoseconds as `.123000000` (nine digits, like `neo4j-driver`), or `""`. */
function fraction(ns: number): string {
  return ns ? `.${String(ns).padStart(9, "0")}` : "";
}

function yearText(year: number): string {
  return year >= 0 && year <= 9999
    ? pad(year, 4)
    : `${year < 0 ? "-" : "+"}${String(Math.abs(year)).padStart(6, "0")}`;
}

/** `+01:00`, `-05:30`, `Z`, `+05:30:15`. */
export function offsetText(seconds: number): string {
  if (seconds === 0) return "Z";
  const abs = Math.abs(seconds);
  const s = abs % 60;
  const hm = `${pad(Math.floor(abs / 3600))}:${pad(Math.floor((abs % 3600) / 60))}`;
  return `${seconds < 0 ? "-" : "+"}${hm}${s ? `:${pad(s)}` : ""}`;
}

type Num = number | CypherInteger | { toNumber(): number };
const n = (v: Num): number => (typeof v === "number" ? v : v.toNumber());

/** A Cypher `DATE`. */
export class CypherDate {
  constructor(
    readonly year: number,
    readonly month: number,
    readonly day: number,
  ) {}

  /** Midnight UTC of this date. */
  toStandardDate(): Date {
    const d = new Date(Date.UTC(2000, this.month - 1, this.day));
    d.setUTCFullYear(this.year);
    return d;
  }

  toString(): string {
    return `${yearText(this.year)}-${pad(this.month)}-${pad(this.day)}`;
  }
}
marker(CypherDate.prototype, "__isDate__");

/** A Cypher `LOCAL TIME`. */
export class CypherLocalTime {
  constructor(
    readonly hour: number,
    readonly minute: number,
    readonly second: number,
    readonly nanosecond: number,
  ) {}

  toString(): string {
    return `${pad(this.hour)}:${pad(this.minute)}:${pad(this.second)}${fraction(this.nanosecond)}`;
  }
}
marker(CypherLocalTime.prototype, "__isLocalTime__");

/** A Cypher `ZONED TIME` (a time of day with a UTC offset). */
export class CypherTime {
  constructor(
    readonly hour: number,
    readonly minute: number,
    readonly second: number,
    readonly nanosecond: number,
    readonly timeZoneOffsetSeconds: number,
  ) {}

  toString(): string {
    return `${pad(this.hour)}:${pad(this.minute)}:${pad(this.second)}${fraction(this.nanosecond)}${offsetText(this.timeZoneOffsetSeconds)}`;
  }
}
marker(CypherTime.prototype, "__isTime__");

/** A Cypher `LOCAL DATETIME`. */
export class CypherLocalDateTime {
  constructor(
    readonly year: number,
    readonly month: number,
    readonly day: number,
    readonly hour: number,
    readonly minute: number,
    readonly second: number,
    readonly nanosecond: number,
  ) {}

  /** The same wall-clock time in the local time zone of the process (like `neo4j-driver`). */
  toStandardDate(): Date {
    const d = new Date(
      2000,
      this.month - 1,
      this.day,
      this.hour,
      this.minute,
      this.second,
      Math.floor(this.nanosecond / 1_000_000),
    );
    d.setFullYear(this.year);
    return d;
  }

  toString(): string {
    return `${yearText(this.year)}-${pad(this.month)}-${pad(this.day)}T${pad(this.hour)}:${pad(this.minute)}:${pad(this.second)}${fraction(this.nanosecond)}`;
  }
}
marker(CypherLocalDateTime.prototype, "__isLocalDateTime__");

/**
 * A Cypher `ZONED DATETIME`: a local date-time with a UTC offset and / or an IANA time zone id
 * (`Europe/Paris`).
 */
export class CypherDateTime {
  constructor(
    readonly year: number,
    readonly month: number,
    readonly day: number,
    readonly hour: number,
    readonly minute: number,
    readonly second: number,
    readonly nanosecond: number,
    readonly timeZoneOffsetSeconds: number | undefined,
    readonly timeZoneId?: string,
  ) {}

  /** The instant as a JS `Date` (millisecond precision). Needs the UTC offset. */
  toStandardDate(): Date {
    if (this.timeZoneOffsetSeconds === undefined) {
      throw new Error(`DateTime ${this.toString()} has no UTC offset: cannot convert to a Date.`);
    }
    const d = new Date(
      Date.UTC(
        2000,
        this.month - 1,
        this.day,
        this.hour,
        this.minute,
        this.second,
        Math.floor(this.nanosecond / 1_000_000),
      ),
    );
    d.setUTCFullYear(this.year);
    return new Date(d.getTime() - this.timeZoneOffsetSeconds * 1000);
  }

  toString(): string {
    const local = `${yearText(this.year)}-${pad(this.month)}-${pad(this.day)}T${pad(this.hour)}:${pad(this.minute)}:${pad(this.second)}${fraction(this.nanosecond)}`;
    const off =
      this.timeZoneOffsetSeconds === undefined ? "" : offsetText(this.timeZoneOffsetSeconds);
    return `${local}${off}${this.timeZoneId ? `[${this.timeZoneId}]` : ""}`;
  }
}
marker(CypherDateTime.prototype, "__isDateTime__");

/**
 * A Cypher `DURATION`: months, days, seconds and nanoseconds (0 to 999 999 999) are independent
 * components, as Neo4j stores them.
 */
export class CypherDuration {
  readonly months: CypherInteger;
  readonly days: CypherInteger;
  readonly seconds: CypherInteger;
  readonly nanoseconds: CypherInteger;

  constructor(months: Num | bigint, days: Num | bigint, seconds: Num | bigint, nanoseconds: Num) {
    const w = (v: Num | bigint) =>
      v instanceof CypherInteger ? v : new CypherInteger(typeof v === "bigint" ? v : n(v));
    this.months = w(months);
    this.days = w(days);
    this.seconds = w(seconds);
    this.nanoseconds = w(nanoseconds);
  }

  /** ISO 8601, e.g. `"P1Y2M3DT4H5M6.5S"`. */
  toString(): string {
    return formatDuration({
      months: this.months.value,
      days: this.days.value,
      seconds: this.seconds.value,
      nanoseconds: Number(this.nanoseconds.value),
    });
  }
}
marker(CypherDuration.prototype, "__isDuration__");

/** A Cypher `POINT`: `srid` 4326 / 4979 (WGS-84 2D / 3D) or 7203 / 9157 (Cartesian 2D / 3D). */
export class CypherPoint {
  constructor(
    readonly srid: number,
    readonly x: number,
    readonly y: number,
    readonly z?: number,
  ) {}

  toString(): string {
    return this.z === undefined
      ? `SRID=${this.srid};POINT (${this.x} ${this.y})`
      : `SRID=${this.srid};POINT Z (${this.x} ${this.y} ${this.z})`;
  }
}
marker(CypherPoint.prototype, "__isPoint__");

/** A node returned by a query. */
export class CypherNode {
  constructor(
    readonly elementId: string,
    readonly labels: string[],
    readonly properties: Record<string, unknown>,
  ) {}
}
marker(CypherNode.prototype, "__isNode__");

/** A relationship returned by a query. */
export class CypherRelationship {
  constructor(
    readonly elementId: string,
    readonly type: string,
    readonly startNodeElementId: string,
    readonly endNodeElementId: string,
    readonly properties: Record<string, unknown>,
  ) {}
}
marker(CypherRelationship.prototype, "__isRelationship__");

/** One hop of a {@link CypherPath}: `start` and `end` follow the path, not the relationship. */
export class CypherPathSegment {
  constructor(
    readonly start: CypherNode,
    readonly relationship: CypherRelationship,
    readonly end: CypherNode,
  ) {}
}
marker(CypherPathSegment.prototype, "__isPathSegment__");

/** A path returned by a query. */
export class CypherPath {
  readonly length: number;

  constructor(
    readonly start: CypherNode,
    readonly end: CypherNode,
    readonly segments: CypherPathSegment[],
  ) {
    this.length = segments.length;
  }
}
marker(CypherPath.prototype, "__isPath__");

/** Integer-like value: a {@link CypherInteger} or a `neo4j-driver` `Integer`. */
export interface IntegerLike {
  inSafeRange(): boolean;
  toNumber(): number;
  toString(): string;
}

export const isInt = (v: unknown): v is IntegerLike => hasMarker(v, "__isInteger__");
export const isDate = (v: unknown): boolean => hasMarker(v, "__isDate__");
export const isDateTime = (v: unknown): boolean => hasMarker(v, "__isDateTime__");
export const isLocalDateTime = (v: unknown): boolean => hasMarker(v, "__isLocalDateTime__");
export const isLocalTime = (v: unknown): boolean => hasMarker(v, "__isLocalTime__");
export const isTime = (v: unknown): boolean => hasMarker(v, "__isTime__");
export const isDuration = (v: unknown): boolean => hasMarker(v, "__isDuration__");
export const isPoint = (v: unknown): boolean => hasMarker(v, "__isPoint__");
export const isNode = (v: unknown): boolean => hasMarker(v, "__isNode__");
export const isRelationship = (v: unknown): boolean => hasMarker(v, "__isRelationship__");
export const isPath = (v: unknown): boolean => hasMarker(v, "__isPath__");
