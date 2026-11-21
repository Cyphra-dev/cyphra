/**
 * ISO 8601 text of the `LocalDateTime`, `LocalTime`, `Time` and `Duration` types: parsing (for
 * `@default("…")` literals and the runtime's encoder) and the canonical formatting the runtime
 * returns. The format follows the `Temporal` API's `toString()` (`Temporal.PlainDateTime`,
 * `Temporal.PlainTime`, `Temporal.Duration`), so values can be handed to `Temporal.*.from()`.
 *
 * @packageDocumentation
 */

/** Components of a `LocalDateTime`. */
export type LocalDateTimeParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
} & LocalTimeParts;

/** Components of a `LocalTime`. */
export type LocalTimeParts = {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 0 to 999 999 999. */
  readonly nanosecond: number;
};

/** Components of a `Time`: a time of day and its UTC offset. */
export type TimeParts = LocalTimeParts & {
  /** UTC offset in seconds (-18h to +18h). */
  readonly offsetSeconds: number;
};

/**
 * Components of a `Duration`, as Neo4j stores them: months, days and seconds are independent
 * (a month is not a fixed number of days, a day not always 24 hours). `nanoseconds` is 0 to
 * 999 999 999 (negative amounts carry their sign in `seconds`).
 */
export type DurationParts = {
  readonly months: bigint;
  readonly days: bigint;
  readonly seconds: bigint;
  readonly nanoseconds: number;
};

const TIME = String.raw`(\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?`;
const LOCAL_TIME_RE = new RegExp(`^${TIME}$`);
const TIME_RE = new RegExp(`^${TIME}(Z|z|[+-]\\d{2}(?::?\\d{2}(?::?\\d{2})?)?)$`);
const LOCAL_DATE_TIME_RE = new RegExp(String.raw`^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})T${TIME}$`);
const DURATION_RE =
  /^([+-])?P(?:([+-]?\d+)Y)?(?:([+-]?\d+)M)?(?:([+-]?\d+)W)?(?:([+-]?\d+)D)?(?:T(?:([+-]?\d+)H)?(?:([+-]?\d+)M)?(?:([+-]?\d+)(?:[.,](\d{1,9}))?S)?)?$/;

function nanos(fraction: string | undefined): number {
  return fraction ? Number(fraction.padEnd(9, "0")) : 0;
}

function timeParts(m: RegExpExecArray, at: number): LocalTimeParts | null {
  const hour = Number(m[at]);
  const minute = Number(m[at + 1]);
  const second = m[at + 2] === undefined ? 0 : Number(m[at + 2]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second, nanosecond: nanos(m[at + 3]) };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate() || 31;
}

/** `"2024-05-01T10:30:00"` → parts, or `null` when the text is not a valid local date-time. */
export function parseLocalDateTime(text: string): LocalDateTimeParts | null {
  const m = LOCAL_DATE_TIME_RE.exec(text);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  // Date.UTC treats years 0-99 as 1900-1999: count the days of the same month of a shifted year.
  const probe = year >= 0 && year < 100 ? year + 400 : year;
  if (day > daysInMonth(probe, month)) return null;
  const t = timeParts(m, 4);
  return t ? { year, month, day, ...t } : null;
}

/** `"10:30:00"` → parts, or `null`. */
export function parseLocalTime(text: string): LocalTimeParts | null {
  const m = LOCAL_TIME_RE.exec(text);
  return m ? timeParts(m, 1) : null;
}

/** `"10:30:00+02:00"` (or `…Z`) → parts, or `null`. The offset is required. */
export function parseTime(text: string): TimeParts | null {
  const m = TIME_RE.exec(text);
  if (!m) return null;
  const t = timeParts(m, 1);
  if (!t) return null;
  const off = m[5]!;
  let offsetSeconds = 0;
  if (off !== "Z" && off !== "z") {
    const digits = off.slice(1).replace(/:/g, "");
    const h = Number(digits.slice(0, 2));
    const min = Number(digits.slice(2, 4) || "0");
    const s = Number(digits.slice(4, 6) || "0");
    if (min > 59 || s > 59) return null;
    offsetSeconds = (off[0] === "-" ? -1 : 1) * (h * 3600 + min * 60 + s);
    if (Math.abs(offsetSeconds) > 18 * 3600) return null;
  }
  return { ...t, offsetSeconds };
}

/**
 * `"P1Y2M3DT4H5M6.5S"` → parts, or `null`. Weeks count as 7 days and years as 12 months; only
 * seconds take a fraction. Components may be signed (`"P1M-3D"`), or the whole duration
 * (`"-PT5M"`).
 */
export function parseDuration(text: string): DurationParts | null {
  const m = DURATION_RE.exec(text);
  if (!m || m.slice(2, 9).every((x) => x === undefined)) return null;
  if (text.endsWith("T")) return null;
  const sign = m[1] === "-" ? -1n : 1n;
  const big = (x: string | undefined) => (x === undefined ? 0n : BigInt(x));
  const months = sign * (big(m[2]) * 12n + big(m[3]));
  const days = sign * (big(m[4]) * 7n + big(m[5]));
  const secondsPart = m[8];
  let fracNs = BigInt(nanos(m[9]));
  if (secondsPart?.startsWith("-")) fracNs = -fracNs;
  const totalNs =
    sign * ((big(m[6]) * 3600n + big(m[7]) * 60n + big(secondsPart)) * 1_000_000_000n + fracNs);
  return splitNanos(months, days, totalNs);
}

function splitNanos(months: bigint, days: bigint, totalNs: bigint): DurationParts {
  let seconds = totalNs / 1_000_000_000n;
  let ns = totalNs % 1_000_000_000n;
  if (ns < 0n) {
    ns += 1_000_000_000n;
    seconds -= 1n;
  }
  return { months, days, seconds, nanoseconds: Number(ns) };
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function fraction(ns: number): string {
  return ns === 0 ? "" : "." + pad(ns, 9).replace(/0+$/, "");
}

/** `"10:30:00"`, `"10:30:00.5"`: seconds always, the fraction without trailing zeros. */
export function formatLocalTime(t: LocalTimeParts): string {
  return `${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}${fraction(t.nanosecond)}`;
}

/** `"2024-05-01T10:30:00"` (years outside 0-9999 as `±YYYYYY`). */
export function formatLocalDateTime(t: LocalDateTimeParts): string {
  const year =
    t.year >= 0 && t.year <= 9999
      ? pad(t.year, 4)
      : `${t.year < 0 ? "-" : "+"}${pad(Math.abs(t.year), 6)}`;
  return `${year}-${pad(t.month)}-${pad(t.day)}T${formatLocalTime(t)}`;
}

/** `"10:30:00Z"`, `"10:30:00+02:00"`. */
export function formatTime(t: TimeParts): string {
  const off = t.offsetSeconds;
  if (off === 0) return `${formatLocalTime(t)}Z`;
  const abs = Math.abs(off);
  const s = abs % 60;
  const hm = `${pad(Math.floor(abs / 3600))}:${pad(Math.floor((abs % 3600) / 60))}`;
  return `${formatLocalTime(t)}${off < 0 ? "-" : "+"}${hm}${s ? `:${pad(s)}` : ""}`;
}

/**
 * `"P1Y2M3DT4H5M6.5S"`, `"PT0S"` for zero. A duration whose components are all negative is
 * written `"-P…"`; mixed signs are written per component (`"P1M-3D"`).
 */
export function formatDuration(d: DurationParts): string {
  const totalNs = d.seconds * 1_000_000_000n + BigInt(d.nanoseconds);
  const parts = [d.months, d.days, totalNs];
  const negative = parts.some((x) => x < 0n) && parts.every((x) => x <= 0n);
  const s = negative ? -1n : 1n;
  const months = s * d.months;
  const days = s * d.days;
  const ns = s * totalNs;
  let out = "";
  const years = months / 12n;
  const restMonths = months % 12n;
  if (years) out += `${years}Y`;
  if (restMonths) out += `${restMonths}M`;
  if (days) out += `${days}D`;
  let time = "";
  if (ns) {
    const neg = ns < 0n;
    const abs = neg ? -ns : ns;
    const sign = neg ? "-" : "";
    const h = abs / 3_600_000_000_000n;
    const min = (abs % 3_600_000_000_000n) / 60_000_000_000n;
    const sec = (abs % 60_000_000_000n) / 1_000_000_000n;
    const frac = Number(abs % 1_000_000_000n);
    if (h) time += `${sign}${h}H`;
    if (min) time += `${sign}${min}M`;
    if (sec || frac) time += `${sign}${sec}${fraction(frac)}S`;
  }
  if (!out && !time) return "PT0S";
  return `${negative ? "-" : ""}P${out}${time ? `T${time}` : ""}`;
}

/** Temporal types written as ISO 8601 text. */
export type IsoTemporalType = "LocalDateTime" | "LocalTime" | "Time" | "Duration";

/** `true` when `text` is valid ISO 8601 text for `type`. */
export function isValidTemporalText(type: IsoTemporalType, text: string): boolean {
  switch (type) {
    case "LocalDateTime":
      return parseLocalDateTime(text) !== null;
    case "LocalTime":
      return parseLocalTime(text) !== null;
    case "Time":
      return parseTime(text) !== null;
    case "Duration":
      return parseDuration(text) !== null;
  }
}

/** An example of each temporal type's text, for error messages. */
export const TEMPORAL_EXAMPLES: Readonly<Record<IsoTemporalType, string>> = {
  LocalDateTime: "2024-05-01T10:30:00",
  LocalTime: "10:30:00",
  Time: "10:30:00+02:00",
  Duration: "P1DT2H30M",
};
