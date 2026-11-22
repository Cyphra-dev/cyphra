/**
 * Event filters of the `Subscription` fields, evaluated in JS on each CDC event (v7 semantics):
 * the `where` argument, `@subscriptionsAuthorization` rules and the "nothing changed" filter of
 * update events.
 *
 * @packageDocumentation
 */

import { isDate, isDateTime, isInt, type DateTime } from "neo4j-driver";
import type { Attribute, NodeType, SubscriptionEvent } from "../model.js";
import { jwtMatches, readPath, splitClaimPath, type AuthContext } from "../auth/context.js";
import type { NodeEvent } from "./engine.js";

type AnyRecord = Record<string, unknown>;

function isRecord(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const EVENT_NAMES: Record<NodeEvent["event"], SubscriptionEvent> = {
  create: "CREATED",
  update: "UPDATED",
  delete: "DELETED",
};

const LEGACY_OPERATORS =
  /^(?<field>.+?)_(?<op>EQ|IN|INCLUDES|CONTAINS|STARTS_WITH|ENDS_WITH|LT|LTE|GT|GTE)$/;

const GENERIC: Record<string, string> = {
  eq: "EQ",
  in: "IN",
  includes: "INCLUDES",
  contains: "CONTAINS",
  startsWith: "STARTS_WITH",
  endsWith: "ENDS_WITH",
  lt: "LT",
  lte: "LTE",
  gt: "GT",
  gte: "GTE",
};

/** A value in a form `===` / `<` compare correctly for the attribute's type. */
function comparable(value: unknown, a: Attribute | undefined): unknown {
  if (Array.isArray(value)) return value.map((v) => comparable(v, a));
  if (value === null || value === undefined) return value;
  switch (a?.type.name) {
    case "BigInt":
      try {
        return BigInt(isInt(value) ? value.toString() : String(value as string | number));
      } catch {
        return value;
      }
    case "Int":
    case "Float":
      return isInt(value) ? value.toNumber() : value;
    case "Date":
      return isDate(value as object) ? String(value) : value;
    case "DateTime":
      if (isDateTime(value as object)) return (value as DateTime).toStandardDate().getTime();
      if (typeof value === "string") return Date.parse(value);
      return value instanceof Date ? value.getTime() : value;
    default:
      return value;
  }
}

function equal(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equal(v, b[i]))
    );
  }
  return a === b;
}

function compare(op: string, received: unknown, filtered: unknown): boolean {
  switch (op) {
    case "EQ":
      return equal(received, filtered);
    case "IN":
      return Array.isArray(filtered) && filtered.some((v) => equal(received, v));
    case "INCLUDES":
      return Array.isArray(received) && received.some((v) => equal(v, filtered));
    case "CONTAINS":
      return (
        typeof received === "string" && typeof filtered === "string" && received.includes(filtered)
      );
    case "STARTS_WITH":
      return (
        typeof received === "string" &&
        typeof filtered === "string" &&
        received.startsWith(filtered)
      );
    case "ENDS_WITH":
      return (
        typeof received === "string" && typeof filtered === "string" && received.endsWith(filtered)
      );
    case "LT":
    case "LTE":
    case "GT":
    case "GTE": {
      if (filtered === null || filtered === undefined || typeof received !== typeof filtered)
        return false;
      const [r, f] = [received as number, filtered as number];
      return op === "LT" ? r < f : op === "LTE" ? r <= f : op === "GT" ? r > f : r >= f;
    }
    default:
      return false;
  }
}

/**
 * Whether `payload` (field name → value) matches a `<Type>SubscriptionWhere` filter. A missing
 * (null) value never matches a field filter.
 */
export function matchesWhere(node: NodeType, where: AnyRecord, payload: AnyRecord): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === "AND" || key === "OR") {
      const list = (Array.isArray(value) ? value : [value]).filter(isRecord);
      const results = list.map((w) => matchesWhere(node, w, payload));
      if (key === "AND" ? !results.every(Boolean) : !results.some(Boolean)) return false;
      continue;
    }
    if (key === "NOT") {
      if (isRecord(value) && matchesWhere(node, value, payload)) return false;
      continue;
    }
    const legacy = LEGACY_OPERATORS.exec(key)?.groups;
    const field =
      legacy && node.attributes.some((a) => a.name === legacy.field) ? legacy.field! : key;
    const attr = node.attributes.find((a) => a.name === field);
    const received = comparable(payload[field], attr);
    if (received === null || received === undefined) return false;
    if (field !== key) {
      if (!compare(legacy!.op!, received, comparable(value, attr))) return false;
      continue;
    }
    if (!isRecord(value)) return false;
    for (const [op, v] of Object.entries(value)) {
      if (v === undefined) continue;
      const operator = GENERIC[op];
      if (!operator || !compare(operator, received, comparable(v, attr))) return false;
    }
  }
  return true;
}

/** `$jwt.<path>` / `$context.<path>` references of a rule, replaced by their values (v7). */
function populate(value: unknown, auth: AuthContext): unknown {
  if (Array.isArray(value)) return value.map((v) => populate(v, auth));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, populate(v, auth)]));
  }
  if (typeof value === "string") {
    if (value.startsWith("$jwt")) {
      const path = value.substring(5);
      const mapped = auth.claims?.get(path);
      return readPath(auth.jwt ?? {}, splitClaimPath(mapped ?? path));
    }
    if (value.startsWith("$context")) {
      return readPath(auth.context, value.substring(9).split(".")) || "";
    }
  }
  return value;
}

function ruleMatches(
  node: NodeType,
  where: AnyRecord,
  payload: AnyRecord,
  auth: AuthContext,
): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === "AND" || key === "OR") {
      const list = (Array.isArray(value) ? value : [value]).filter(isRecord);
      const results = list.map((w) => ruleMatches(node, w, payload, auth));
      if (key === "AND" ? !results.every(Boolean) : !results.some(Boolean)) return false;
    } else if (key === "NOT") {
      if (isRecord(value) && ruleMatches(node, value, payload, auth)) return false;
    } else if (key === "node") {
      if (!isRecord(value) || !matchesWhere(node, value, payload)) return false;
    } else if (key === "jwt") {
      if (!auth.jwt || !isRecord(value) || !jwtMatches(value, auth)) return false;
    }
  }
  return true;
}

/**
 * `@subscriptionsAuthorization`: the event is delivered when no rule applies to its kind, or when
 * one of the rules that apply holds. (`@authorization` does not filter events, like v7.)
 */
export function authorizedEvent(
  node: NodeType,
  event: NodeEvent["event"],
  payload: AnyRecord,
  auth: AuthContext,
): boolean {
  const name = EVENT_NAMES[event];
  const rules = (node.subscriptionsAuthorization ?? []).filter((r) => r.events.includes(name));
  if (!rules.length) return true;
  return rules.some((rule) => {
    if (rule.requireAuthentication && !auth.jwt) return false;
    return ruleMatches(node, populate(rule.where, auth) as AnyRecord, payload, auth);
  });
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => sameValue(v, b[i]))
    );
  }
  if (a && b && typeof a === "object" && typeof b === "object") return String(a) === String(b);
  return a === b;
}

/** v7 drops update events whose properties did not change. */
export function changed(event: NodeEvent): boolean {
  if (event.event !== "update") return true;
  const before = event.properties.old ?? {};
  const after = event.properties.new ?? {};
  const keys = Object.keys(before);
  if (keys.length !== Object.keys(after).length) return true;
  return keys.some((k) => !sameValue(before[k], after[k]));
}

/** The event's properties keyed by GraphQL field name (`@alias` mapped). */
export function payloadOf(node: NodeType, props: AnyRecord | undefined): AnyRecord {
  const out: AnyRecord = {};
  for (const a of node.attributes) out[a.name] = props?.[a.property] ?? null;
  return out;
}
