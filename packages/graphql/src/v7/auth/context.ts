/**
 * The authorization context of one request, and `@authentication` checks.
 *
 * Like `@neo4j/graphql` v7:
 * - a decoded JWT passed as `context.jwt` is trusted as-is (the server verified it) and the request is
 *   authenticated; `@jwtClaim` mappings are not applied to it;
 * - otherwise `context.token` (`Bearer <jwt>`) is verified when `features.authorization` is set; a
 *   valid token authenticates the request and `@jwtClaim` mappings apply to its payload;
 * - `@authentication` fails with `Unauthenticated` when the request is not authenticated or the JWT
 *   does not match the directive's `jwt` filter.
 *
 * @packageDocumentation
 */

import { GraphQLError } from "graphql";
import type { AuthenticationAnnotation, AuthOperation, NodeType, V7Model } from "../model.js";
import type { JwtDecoder } from "./jwt.js";

type AnyRecord = Record<string, unknown>;

export type AuthContext = {
  readonly isAuthenticated: boolean;
  /** The JWT payload (`undefined` when not authenticated). */
  readonly jwt: AnyRecord | undefined;
  /** `@jwtClaim` mappings, only for tokens verified by the library (v7 behaviour). */
  readonly claims: ReadonlyMap<string, string> | undefined;
  /** The GraphQL context value, for `$context.<path>` references. */
  readonly context: AnyRecord;
};

export const UNAUTHENTICATED = "Unauthenticated";
export const FORBIDDEN = "Forbidden";

export function unauthenticated(): GraphQLError {
  return new GraphQLError(UNAUTHENTICATED);
}

export function forbidden(): GraphQLError {
  return new GraphQLError(FORBIDDEN);
}

function isRecord(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Keys `dot-prop` (used by v7 for `$context`) refuses to read. */
const DISALLOWED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Reads `segments` from `value` through own properties only (never the prototype chain), like
 * `dot-prop`: `undefined` when a segment is missing.
 */
export function readPath(value: unknown, segments: readonly string[]): unknown {
  let cur: unknown = value;
  for (const s of segments) {
    if (DISALLOWED_KEYS.has(s)) return undefined;
    if (typeof cur !== "object" || cur === null) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, s)) return undefined;
    cur = (cur as AnyRecord)[s];
  }
  return cur;
}

/** `a.b\.c.d` → `["a", "b.c", "d"]` (the escaping v7 supports in `@jwtClaim` paths). */
export function splitClaimPath(path: string): string[] {
  return path.split(/(?<!\\)\./).map((p) => p.replaceAll("\\.", "."));
}

/**
 * The authorization context of a request, computed for each root field from the context value as it
 * is then (like v7; nothing is cached across fields or requests).
 */
export async function authContextFor(
  contextValue: unknown,
  model: V7Model,
  decoder: JwtDecoder | undefined,
): Promise<AuthContext> {
  const context = isRecord(contextValue) ? contextValue : {};
  const trusted = context.jwt;
  if (trusted !== undefined && trusted !== null && trusted !== false && trusted !== "") {
    if (!isRecord(trusted)) {
      throw new GraphQLError("context.jwt must be the decoded JWT payload (an object).");
    }
    return { isAuthenticated: true, jwt: trusted, claims: undefined, context };
  }
  if (decoder && typeof context.token === "string") {
    const payload = await decoder.decode(context);
    if (payload) {
      return {
        isAuthenticated: true,
        jwt: payload as AnyRecord,
        claims: model.jwtClaims,
        context,
      };
    }
  }
  return { isAuthenticated: false, jwt: undefined, claims: undefined, context };
}

/** The value of a JWT claim (`@jwtClaim` mapping applied when `claims` is set). */
export function claimValue(auth: AuthContext, field: string): unknown {
  const mapped = auth.claims?.get(field);
  return readPath(auth.jwt ?? {}, mapped ? splitClaimPath(mapped) : [field]);
}

const JWT_WHERE_KEY =
  /^(?<fieldName>[_A-Za-z]\w*?)(?:_(?<operator>IN|INCLUDES|MATCHES|CONTAINS|STARTS_WITH|ENDS_WITH|EQ|LT|LTE|GT|GTE))?$/;

export const GENERIC_OPERATORS: Record<string, string> = {
  eq: "EQ",
  in: "IN",
  includes: "INCLUDES",
  contains: "CONTAINS",
  startsWith: "STARTS_WITH",
  endsWith: "ENDS_WITH",
  matches: "MATCHES",
  lt: "LT",
  lte: "LTE",
  gt: "GT",
  gte: "GTE",
};

/** `roles_INCLUDES` → `{ field: "roles", operator: "INCLUDES" }`. */
export function parseJwtWhereKey(key: string): { field: string; operator?: string } {
  const m = JWT_WHERE_KEY.exec(key);
  if (!m?.groups) throw new GraphQLError(`Invalid JWT filter ${key}`);
  return { field: m.groups.fieldName!, operator: m.groups.operator };
}

function isPrimitive(v: unknown): boolean {
  return ["string", "number", "boolean", "bigint"].includes(typeof v);
}

function ordered(received: unknown): unknown {
  return typeof received === "string" ? BigInt(received) : received;
}

/** v7 `filterByValues` comparisons (used by `@authentication(jwt)`), errors count as no match. */
function compareInJs(operator: string, received: unknown, value: unknown): boolean {
  try {
    switch (operator) {
      case "EQ":
        // v7 uses `==`; restricted to primitives so `["admin"] == "admin"` does not match.
        return isPrimitive(received) && isPrimitive(value) && received == value;
      case "LT":
        return (ordered(received) as number) < (value as number);
      case "LTE":
        return (ordered(received) as number) <= (value as number);
      case "GT":
        return (ordered(received) as number) > (value as number);
      case "GTE":
        return (ordered(received) as number) >= (value as number);
      case "STARTS_WITH":
        return (
          typeof received === "string" && typeof value === "string" && received.startsWith(value)
        );
      case "ENDS_WITH":
        return (
          typeof received === "string" && typeof value === "string" && received.endsWith(value)
        );
      case "CONTAINS":
        return (
          typeof received === "string" && typeof value === "string" && received.includes(value)
        );
      case "INCLUDES":
        return Array.isArray(received) && received.some((v) => v === value);
      case "IN":
        return Array.isArray(value) && value.some((v) => v === received);
    }
  } catch {
    return false;
  }
  throw new GraphQLError(`Operator ${operator} is not supported in @authentication(jwt)`);
}

/** Whether the JWT matches the `jwt` filter of `@authentication` (v7 `filterByValues`). */
export function jwtMatches(where: AnyRecord, auth: AuthContext): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === "AND" || key === "OR") {
      const results = (Array.isArray(value) ? value : [value]).map((w) =>
        isRecord(w) ? jwtMatches(w, auth) : false,
      );
      if (key === "AND" ? !results.every(Boolean) : !results.some(Boolean)) return false;
      continue;
    }
    if (key === "NOT") {
      if (!isRecord(value) || jwtMatches(value, auth)) return false;
      continue;
    }
    const { field, operator } = parseJwtWhereKey(key);
    const received = claimValue(auth, field);
    // v7: a missing (or falsy) claim never matches.
    if (!received) return false;
    if (operator) {
      if (!compareInJs(operator, received, value)) return false;
      continue;
    }
    if (!isRecord(value)) return false;
    for (const [op, v] of Object.entries(value)) {
      const legacy = GENERIC_OPERATORS[op];
      if (!legacy)
        throw new GraphQLError(`Operator ${op} is not supported in @authentication(jwt)`);
      if (!compareInJs(legacy, received, v)) return false;
    }
  }
  return true;
}

function applyAuthentication(
  annotation: AuthenticationAnnotation | undefined,
  operations: readonly AuthOperation[],
  auth: AuthContext,
): void {
  if (!annotation || !operations.some((op) => annotation.operations.has(op))) return;
  if (!auth.isAuthenticated) throw unauthenticated();
  if (annotation.jwt && (!auth.jwt || !jwtMatches(annotation.jwt, auth))) throw unauthenticated();
}

/**
 * `@authentication` for an operation on a type (`field` omitted) or on one of its attributes; the
 * schema-level annotation (`extend schema @authentication`) applies to both.
 */
export function checkAuthentication(
  model: V7Model,
  auth: AuthContext,
  node: NodeType,
  operations: readonly AuthOperation[],
  field?: string,
): void {
  applyAuthentication(model.authentication, operations, auth);
  if (field === undefined) {
    applyAuthentication(node.auth.authentication, operations, auth);
  } else {
    const attr = node.attributes.find((a) => a.name === field);
    applyAuthentication(attr?.auth?.authentication, operations, auth);
  }
}
