/**
 * `@authorization` rules of a request as engine filters, with the semantics of the compat
 * compiler's `AuthRules` (which follows `@neo4j/graphql` 7.6):
 *
 * - `requireAuthentication` and `jwt` comparisons depend only on the request: they are evaluated
 *   here, to `true` / `false`, with Cypher's semantics (`$claim IS NOT NULL AND <comparison>`);
 * - `where.node` is translated like a `where` input, in the rules' mode (`$jwt` / `$context`
 *   references: a missing value matches nothing; a to-one filter that filters nothing is left out);
 * - rules of one annotation are combined with OR, annotations (the type's, then each attribute's)
 *   with AND; a part that filters nothing is left out of both, like the compiler.
 *
 * The rules are applied where the compiler applies them (the translators AND them into the root
 * `where`, the relation loads and the connections), not with the engine's `withEngineRules`: v7
 * leaves relationship filters, connected nodes and unselected fields alone.
 *
 * `validate` rules have no engine equivalent (they fail the request when one node breaks them):
 * the request runs on the engine only when they hold for every node, i.e. when they reduce to
 * `true` for the request. Anything else throws {@link Fallback}: a validation that depends on the
 * node or fails, comparisons whose Cypher result is `null`, an error or not certain (`MATCHES`,
 * lists, mixed types).
 *
 * @packageDocumentation
 */

import type { AuthContext } from "../auth/context.js";
import { claimValue, GENERIC_OPERATORS, parseJwtWhereKey } from "../auth/context.js";
import { populateRule } from "../auth/rules.js";
import { AuthValue } from "../cypher/where.js";
import type { Attribute, AuthOperation, AuthorizationRule, NodeType } from "../model.js";
import { Fallback, TRUE, isPlainObject, type Filter, type WhereTranslator } from "./where.js";

type AnyRecord = Record<string, unknown>;

/** A rule predicate: a constant, an engine `where`, or `undefined` (no condition). */
type Rule = boolean | AnyRecord | undefined;

/** The engine `where` that matches nothing. */
const NOTHING: AnyRecord = { OR: [] };

/** Parts combined with AND; parts without a condition are left out. */
function and(parts: readonly Rule[]): Rule {
  const defined = parts.filter((p) => p !== undefined);
  if (defined.length === 0) return undefined;
  if (defined.includes(false)) return false;
  const records = defined.filter((p): p is AnyRecord => p !== true);
  if (records.length === 0) return true;
  return records.length === 1 ? records[0] : { AND: records };
}

/** Parts combined with OR; parts without a condition are left out. */
function or(parts: readonly Rule[]): Rule {
  const defined = parts.filter((p) => p !== undefined);
  if (defined.length === 0) return undefined;
  if (defined.includes(true)) return true;
  const records = defined.filter((p): p is AnyRecord => p !== false);
  if (records.length === 0) return false;
  return records.length === 1 ? records[0] : { OR: records };
}

function not(p: Rule): Rule {
  if (p === undefined) return undefined;
  if (typeof p === "boolean") return !p;
  return { NOT: p };
}

/** A rule predicate as a translated filter (`false`: a `where` that matches nothing). */
function asFilter(p: Rule): Filter {
  if (p === undefined) return undefined;
  if (p === true) return TRUE;
  if (p === false) return NOTHING;
  return p;
}

/** A filter of the `where` translator as a rule predicate. */
function fromFilter(f: Filter): Rule {
  return f === TRUE ? true : f;
}

/** Thrown for a JWT comparison whose Cypher value is not certainly `true` / `false`. */
function uncertain(what: string): never {
  throw new Fallback(`authorization JWT comparison: ${what}`);
}

function isScalar(v: unknown): v is string | number | boolean {
  return (
    typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean"
  );
}

/** Cypher `a = b` on scalars (`null` operands are handled by the callers). */
function equals(a: unknown, b: unknown): boolean {
  if (!isScalar(a) || !isScalar(b)) uncertain("equality of non-scalar values");
  return typeof a === typeof b && a === b;
}

/** Cypher `x IN list`, `true` / `false` only (a `null` in the list could make it `null`). */
function within(x: unknown, list: unknown): boolean {
  if (x === null || x === undefined) uncertain("null IN");
  if (!Array.isArray(list)) uncertain("IN on a value that is not a list");
  if (list.some((e) => e === null || e === undefined)) uncertain("IN on a list with null");
  return list.some((e) => equals(x, e));
}

/** Code point order (Cypher's string order). */
function compareStrings(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0)!);
  const y = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length;
}

function order(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b)) {
    return a - b;
  }
  if (typeof a === "string" && typeof b === "string") return compareStrings(a, b);
  return uncertain("ordering of values of different or non-orderable types");
}

function strings(a: unknown, b: unknown): [string, string] {
  if (typeof a !== "string" || typeof b !== "string") uncertain("string operator on non-strings");
  return [a, b];
}

/** v7's JWT comparison operator on a non-null claim (see `jwtComparison` in `auth/rules.ts`). */
function compare(operator: string, claim: unknown, value: unknown): boolean {
  if (operator !== "IN" && operator !== "INCLUDES" && (value === null || value === undefined)) {
    uncertain("comparison with null");
  }
  switch (operator) {
    case "EQ":
      return equals(claim, value);
    case "IN":
      return within(claim, value);
    case "INCLUDES":
      return within(value, claim);
    case "CONTAINS": {
      const [c, v] = strings(claim, value);
      return c.includes(v);
    }
    case "STARTS_WITH": {
      const [c, v] = strings(claim, value);
      return c.startsWith(v);
    }
    case "ENDS_WITH": {
      const [c, v] = strings(claim, value);
      return c.endsWith(v);
    }
    case "LT":
      return order(claim, value) < 0;
    case "LTE":
      return order(claim, value) <= 0;
    case "GT":
      return order(claim, value) > 0;
    case "GTE":
      return order(claim, value) >= 0;
  }
  // MATCHES (a Java regular expression) and unknown operators.
  return uncertain(`operator ${operator}`);
}

function unwrap(v: unknown): unknown {
  return v instanceof AuthValue ? (v.value ?? null) : (v ?? null);
}

/** The `@authorization` rules of one request, as engine filters. */
export class EngineAuthRules {
  constructor(
    /** A `where` translator in the rules' mode. */
    private readonly where: WhereTranslator,
    private readonly auth: AuthContext,
  ) {}

  /**
   * The `filter` rules for `operation` on `node` (the type's and those of `attributes`), as a
   * filter to AND into the `where` of the nodes they apply to (`undefined`: no rule applies).
   */
  filter(node: NodeType, operation: AuthOperation, attributes: readonly Attribute[] = []): Filter {
    return asFilter(
      and(
        [node.auth, ...attributes.map((a) => a.auth)].map((a) =>
          or(
            (a?.authorization?.filter ?? [])
              .filter((r) => r.operations.includes(operation))
              .map((r) => this.rule(node, r)),
          ),
        ),
      ),
    );
  }

  /**
   * Throws {@link Fallback} unless the `validate` rules for `operation` / `when` (the type's when
   * `type`, and those of `attributes`) hold for every node: each annotation's rules reduce to
   * `true` for the request (or none applies).
   */
  validated(
    node: NodeType,
    operation: AuthOperation,
    when: "BEFORE" | "AFTER",
    attributes: readonly Attribute[] = [],
    type = true,
  ): void {
    const annotations = [...(type ? [node.auth] : []), ...attributes.map((a) => a.auth)];
    for (const a of annotations) {
      const v = or(
        (a?.authorization?.validate ?? [])
          .filter((r) => r.operations.includes(operation) && r.when.includes(when))
          .map((r) => this.rule(node, r)),
      );
      if (v !== undefined && v !== true) {
        throw new Fallback(`${node.name}: ${operation} validation that may fail`);
      }
    }
  }

  /** {@link filter} and the BEFORE validations of READ (a read on the engine never fails them). */
  read(node: NodeType, attributes: readonly Attribute[]): Filter {
    this.validated(node, "READ", "BEFORE", attributes);
    return this.filter(node, "READ", attributes);
  }

  private rule(node: NodeType, rule: AuthorizationRule): Rule {
    const auth = rule.requireAuthentication ? this.auth.isAuthenticated : undefined;
    return and([auth, this.ruleWhere(node, populateRule(this.auth, rule.where))]);
  }

  /** `{ node, jwt, AND, OR, NOT }`: keys combined with AND. */
  private ruleWhere(node: NodeType, where: unknown): Rule {
    if (!isPlainObject(where)) throw new Fallback("invalid authorization rule");
    const parts: Rule[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined || value === null) continue;
      switch (key) {
        case "node":
          parts.push(fromFilter(this.where.node(node, value)));
          break;
        case "jwt":
          parts.push(this.jwt(value));
          break;
        case "AND":
        case "OR": {
          const items = (Array.isArray(value) ? value : [value]).map((w) =>
            this.ruleWhere(node, w),
          );
          parts.push(key === "AND" ? and(items) : or(items));
          break;
        }
        case "NOT":
          parts.push(not(this.ruleWhere(node, value)));
          break;
        default:
          throw new Fallback(`authorization rule key ${key}`);
      }
    }
    return and(parts);
  }

  /** `jwt: { roles: { includes: "admin" } }`, evaluated for the request. */
  private jwt(where: unknown): Rule {
    if (!isPlainObject(where)) throw new Fallback("invalid JWT filter");
    const parts: Rule[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (key === "AND" || key === "OR") {
        const items = (Array.isArray(value) ? value : [value]).map((w) => this.jwt(w));
        parts.push(key === "AND" ? and(items) : or(items));
        continue;
      }
      if (key === "NOT") {
        parts.push(not(this.jwt(value)));
        continue;
      }
      let parsed: { field: string; operator?: string };
      try {
        parsed = parseJwtWhereKey(key);
      } catch {
        throw new Fallback(`JWT filter ${key}`);
      }
      const comparisons: [string, unknown][] = [];
      if (parsed.operator) comparisons.push([parsed.operator, unwrap(value)]);
      else {
        if (!isPlainObject(value)) throw new Fallback(`JWT filter ${key}`);
        for (const [op, v] of Object.entries(value)) {
          if (v === undefined) continue;
          const legacy = GENERIC_OPERATORS[op];
          if (!legacy) throw new Fallback(`JWT filter operator ${op}`);
          comparisons.push([legacy, unwrap(v)]);
        }
      }
      if (comparisons.length === 0) continue;
      const claim = claimValue(this.auth, parsed.field) ?? null;
      // `($claim IS NOT NULL AND <comparisons>)`
      if (claim === null) {
        parts.push(false);
        continue;
      }
      // Every comparison is evaluated: one that is not certain falls back even after a `false`.
      const results = comparisons.map(([op, v]) => compare(op, claim, v));
      parts.push(results.every(Boolean));
    }
    return and(parts);
  }
}
