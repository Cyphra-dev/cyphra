/**
 * FalkorDB values: parameters as the `CYPHER name=value …` header of `GRAPH.QUERY`, and replies
 * (as the `falkordb` client parses them) as the driver-agnostic classes of `cypher-values.ts`.
 *
 * FalkorDB parameters are Cypher *literals*: strings, numbers, booleans, `null`, lists and maps.
 * There is no literal for a temporal value, a point or a vector, so:
 *
 * - `DateTime` values are sent (and stored) as ISO 8601 text in UTC with milliseconds
 *   (`2024-01-02T03:04:05.000Z`, `Date.prototype.toISOString`): fixed width, so `<`, `>` and
 *   `ORDER BY` on the text follow time order. `Date`, `LocalDateTime`, `LocalTime`, `Time` and
 *   `Duration` values are their ISO 8601 text too (what the ORM returns for them anyway). FalkorDB's
 *   own temporal types have no time zone and a precision of one second, which would lose data.
 * - Points throw an {@link UnsupportedFeatureError} (FalkorDB points are WGS-84 only and cannot be
 *   parameters).
 *
 * JS numbers are sent as floats (`2` → `2.0`) and {@link CypherInteger} / `bigint` /
 * `neo4j-driver` integers as integers, the same split as over Bolt: `Int` fields stay integers and
 * arithmetic on `Float` fields stays floating point.
 *
 * @packageDocumentation
 */

import {
  CypherInteger,
  CypherLocalDateTime,
  CypherLocalTime,
  CypherDate,
  CypherDuration,
  CypherNode,
  CypherPath,
  CypherPathSegment,
  CypherRelationship,
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
} from "../cypher-values.js";
import { formatDuration, formatLocalDateTime, formatLocalTime, formatTime } from "@cyphra/schema";
import { CyphraValidationError } from "../orm/errors.js";
import { unsupportedOnFalkorDB } from "../dialect.js";

type AnyRecord = Record<string, unknown>;

/** A name (parameter or map key) as FalkorDB parses it: backtick-quoted, no backtick inside. */
function name(key: string, what: string): string {
  if (key === "" || key.includes("`")) {
    throw new CyphraValidationError(
      `FalkorDB ${what} ${JSON.stringify(key)}: names cannot be empty or contain a backtick.`,
    );
  }
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : `\`${key}\``;
}

/** A JS number as a Cypher float literal (`2` → `2.0`, `1e21` → `1e+21`). */
function floatLiteral(x: number): string {
  if (!Number.isFinite(x)) {
    throw new CyphraValidationError(
      `FalkorDB parameters cannot be ${x} (only finite numbers have a literal).`,
    );
  }
  const text = String(x);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

/** A string as a double-quoted Cypher literal. */
function stringLiteral(s: string): string {
  return `"${s.replace(/["\\]/g, "\\$&")}"`;
}

/** The ISO 8601 text a temporal parameter is stored as (see the module comment). */
export function temporalText(v: unknown): string | undefined {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new CyphraValidationError("Invalid Date parameter.");
    return v.toISOString();
  }
  if (typeof v !== "object" || v === null) return undefined;
  if (isDateTime(v)) {
    const d = (v as { toStandardDate(): Date }).toStandardDate();
    return d.toISOString();
  }
  // The same text the ORM reads back from Neo4j for these types (no trailing zeros).
  const t = v as Record<string, unknown>;
  const n = (x: unknown): number => (typeof x === "number" ? x : Number(String(x)));
  const b = (x: unknown): bigint => (typeof x === "bigint" ? x : BigInt(String(x)));
  const time = () => ({
    hour: n(t.hour),
    minute: n(t.minute),
    second: n(t.second),
    nanosecond: n(t.nanosecond),
  });
  if (isLocalDateTime(v)) {
    return formatLocalDateTime({ year: n(t.year), month: n(t.month), day: n(t.day), ...time() });
  }
  if (isLocalTime(v)) return formatLocalTime(time());
  if (isTime(v)) return formatTime({ ...time(), offsetSeconds: n(t.timeZoneOffsetSeconds) });
  if (isDuration(v)) {
    return formatDuration({
      months: b(t.months),
      days: b(t.days),
      seconds: b(t.seconds),
      nanoseconds: n(t.nanoseconds),
    });
  }
  if (isDate(v)) return String(v);
  return undefined;
}

/** One parameter value as a FalkorDB literal. */
export function literal(v: unknown, depth = 0): string {
  if (depth > 64) throw new CyphraValidationError("FalkorDB parameter nested too deeply.");
  if (v === null || v === undefined) return "null";
  switch (typeof v) {
    case "string":
      return stringLiteral(v);
    case "boolean":
      return v ? "true" : "false";
    case "number":
      return floatLiteral(v);
    case "bigint":
      return v.toString();
    case "object":
      break;
    default:
      throw new CyphraValidationError(`FalkorDB parameters cannot be of type ${typeof v}.`);
  }
  if (Array.isArray(v)) return `[${v.map((x) => literal(x, depth + 1)).join(", ")}]`;
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    return `[${Array.from(v as unknown as ArrayLike<number | bigint>, (x) => literal(x, depth + 1)).join(", ")}]`;
  }
  if (isInt(v)) return String(v);
  const text = temporalText(v);
  if (text !== undefined) return stringLiteral(text);
  if (isPoint(v)) {
    throw unsupportedOnFalkorDB(
      "Point values",
      "FalkorDB points cannot be passed as parameters (and are WGS-84 only). Store the coordinates as Float fields.",
    );
  }
  if (isNode(v) || isRelationship(v) || isPath(v)) {
    throw new CyphraValidationError(
      "Nodes, relationships and paths cannot be FalkorDB parameters: pass their id or properties.",
    );
  }
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
    throw new CyphraValidationError("FalkorDB has no byte array type.");
  }
  const proto = Object.getPrototypeOf(v) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    throw new CyphraValidationError(
      `FalkorDB parameters must be plain values, lists or maps (got ${(v as object).constructor?.name ?? "an object"}).`,
    );
  }
  const entries = Object.entries(v as AnyRecord)
    .filter(([, x]) => x !== undefined)
    .map(([k, x]) => `${name(k, "map key")}: ${literal(x, depth + 1)}`);
  return `{${entries.join(", ")}}`;
}

/** The `CYPHER a=1 b="x" ` header carrying `params` (empty when there are none). */
export function paramsHeader(params: AnyRecord | undefined): string {
  if (!params) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    parts.push(`${name(k, "parameter")}=${literal(v)}`);
  }
  return parts.length ? `CYPHER ${parts.join(" ")} ` : "";
}

// ---------------------------------------------------------------------------------------------
// Decoding (the `falkordb` client's parsed reply → cypher-values classes)

/** A node as the `falkordb` client returns it. */
type RawNode = { id: number; labels: string[]; properties: AnyRecord };
/** An edge as the `falkordb` client returns it. */
type RawEdge = {
  id: number;
  relationshipType: string;
  sourceId: number;
  destinationId: number;
  properties: AnyRecord;
};

function isPlain(v: unknown): v is AnyRecord {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function keysAre(v: AnyRecord, keys: readonly string[]): boolean {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => k in v);
}

function isRawNode(v: unknown): v is RawNode {
  return (
    isPlain(v) &&
    keysAre(v, ["id", "labels", "properties"]) &&
    typeof v.id === "number" &&
    Array.isArray(v.labels) &&
    isPlain(v.properties)
  );
}

function isRawEdge(v: unknown): v is RawEdge {
  return (
    isPlain(v) &&
    keysAre(v, ["id", "relationshipType", "sourceId", "destinationId", "properties"]) &&
    typeof v.id === "number" &&
    isPlain(v.properties)
  );
}

function isRawPath(v: unknown): v is { nodes: RawNode[]; edges: RawEdge[] } {
  return (
    isPlain(v) &&
    keysAre(v, ["nodes", "edges"]) &&
    Array.isArray(v.nodes) &&
    Array.isArray(v.edges) &&
    v.nodes.length === v.edges.length + 1 &&
    v.nodes.every(isRawNode) &&
    v.edges.every(isRawEdge)
  );
}

/** `Symbol.toStringTag` of a `@js-temporal/polyfill` (or native `Temporal`) value. */
function temporalTag(v: object): string | undefined {
  const tag = (v as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag];
  return typeof tag === "string" && tag.startsWith("Temporal.") ? tag : undefined;
}

function nodeOf(v: RawNode): CypherNode {
  return new CypherNode(String(v.id), [...v.labels], decodeProperties(v.properties));
}

function edgeOf(v: RawEdge): CypherRelationship {
  return new CypherRelationship(
    String(v.id),
    v.relationshipType,
    String(v.sourceId),
    String(v.destinationId),
    decodeProperties(v.properties),
  );
}

function decodeProperties(props: AnyRecord): AnyRecord {
  const out: AnyRecord = {};
  for (const [k, x] of Object.entries(props)) out[k] = decodeValue(x);
  return out;
}

/**
 * A reply value as Cyphra's value classes: integers (`bigint`) → {@link CypherInteger}, nodes,
 * edges and paths → {@link CypherNode} & co. (element ids are FalkorDB's integer ids as text),
 * FalkorDB temporal values → {@link CypherDate} & co., vectors → `number[]`. Maps and lists are
 * decoded element by element; everything else is returned as is.
 */
export function decodeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return new CypherInteger(v);
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(decodeValue);
  if (isRawNode(v)) return nodeOf(v);
  if (isRawEdge(v)) return edgeOf(v);
  if (isRawPath(v)) {
    const nodes = v.nodes.map(nodeOf);
    const segments = v.edges.map(
      (e, i) => new CypherPathSegment(nodes[i]!, edgeOf(e), nodes[i + 1]!),
    );
    return new CypherPath(nodes[0]!, nodes[nodes.length - 1]!, segments);
  }
  const tag = temporalTag(v);
  if (tag) {
    const t = v as Record<string, number> & { total?(o: unknown): number };
    switch (tag) {
      case "Temporal.PlainDateTime":
        return new CypherLocalDateTime(
          t.year!,
          t.month!,
          t.day!,
          t.hour!,
          t.minute!,
          t.second!,
          t.millisecond! * 1_000_000 + t.microsecond! * 1_000 + t.nanosecond!,
        );
      case "Temporal.PlainDate":
        return new CypherDate(t.year!, t.month!, t.day!);
      case "Temporal.PlainTime":
        return new CypherLocalTime(
          t.hour!,
          t.minute!,
          t.second!,
          t.millisecond! * 1_000_000 + t.microsecond! * 1_000 + t.nanosecond!,
        );
      case "Temporal.Duration":
        return new CypherDuration(
          t.years! * 12 + t.months!,
          t.weeks! * 7 + t.days!,
          t.hours! * 3600 + t.minutes! * 60 + t.seconds!,
          t.milliseconds! * 1_000_000 + t.microseconds! * 1_000 + t.nanoseconds!,
        );
      default:
        return String(v);
    }
  }
  if (isPlain(v)) return decodeProperties(v);
  return v;
}
