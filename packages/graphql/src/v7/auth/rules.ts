/**
 * Compiles `@authorization` rules into Cypher predicates of the statement that serves a root field.
 *
 * Semantics follow `@neo4j/graphql` 7.6 (checked by the compatibility suite):
 * - a rule applies to the operations it names; `requireAuthentication` (default `true`) adds
 *   `$isAuthenticated = true`; `where.node` is a `${Type}Where` on the node, `where.jwt` compares
 *   claims of the JWT (`@jwtClaim` mappings applied for verified tokens);
 * - `$jwt.<claim>` and `$context.<path>` strings are resolved for the request and passed as
 *   parameters; a comparison with a missing value matches nothing;
 * - `filter` rules of one annotation are combined with OR (the node is kept when one rule holds),
 *   the annotations of the type and of each selected / written field with AND;
 * - `validate` rules of one annotation are combined with OR; the statement fails with `Forbidden`
 *   when one annotation fails for one node.
 *
 * Intentional differences, all stricter than v7: inside `AND` / `OR` elements, `node` and `jwt` are
 * combined with AND (v7 combines the keys of one element with the element's operator); `NOT` is
 * supported at the top of a rule (v7 throws); a validation that evaluates to `null` (e.g. comparing a
 * missing property) fails with `Forbidden` (v7 fails with an APOC error).
 *
 * @packageDocumentation
 */

import { GraphQLError } from "graphql";
import type {
  Attribute,
  AuthAnnotations,
  AuthOperation,
  AuthorizationRule,
  NodeType,
  V7Model,
} from "../model.js";
import type { CypherContext } from "../cypher/context.js";
import { AuthValue, WhereCompiler } from "../cypher/where.js";
import {
  claimValue,
  GENERIC_OPERATORS,
  parseJwtWhereKey,
  readPath,
  type AuthContext,
} from "./context.js";

type AnyRecord = Record<string, unknown>;
export type When = "BEFORE" | "AFTER";

function isRecord(v: unknown): v is AnyRecord {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function and(parts: readonly (string | undefined)[]): string | undefined {
  const ps = parts.filter((p): p is string => p !== undefined);
  if (ps.length === 0) return undefined;
  if (ps.length === 1) return ps[0];
  return ps.map((p) => `(${p})`).join(" AND ");
}

function or(parts: readonly (string | undefined)[]): string | undefined {
  const ps = parts.filter((p): p is string => p !== undefined);
  if (ps.length === 0) return undefined;
  if (ps.length === 1) return ps[0];
  return ps.map((p) => `(${p})`).join(" OR ");
}

/** Cypher of a v7 JWT comparison operator, `claim` and `value` being parameters. */
function jwtComparison(operator: string, claim: string, value: string): string {
  switch (operator) {
    case "EQ":
      return `${claim} = ${value}`;
    case "IN":
      return `${claim} IN ${value}`;
    case "INCLUDES":
      return `${value} IN ${claim}`;
    case "CONTAINS":
      return `${claim} CONTAINS ${value}`;
    case "STARTS_WITH":
      return `${claim} STARTS WITH ${value}`;
    case "ENDS_WITH":
      return `${claim} ENDS WITH ${value}`;
    case "MATCHES":
      return `${claim} =~ ${value}`;
    case "LT":
      return `${claim} < ${value}`;
    case "LTE":
      return `${claim} <= ${value}`;
    case "GT":
      return `${claim} > ${value}`;
    case "GTE":
      return `${claim} >= ${value}`;
  }
  throw new GraphQLError(`Invalid operator ${operator} in an authorization JWT filter`);
}

/** The annotations whose rules apply: the type's, then one per attribute. */
function annotations(
  node: NodeType,
  attributes: readonly Attribute[],
): (AuthAnnotations | undefined)[] {
  return [node.auth, ...attributes.map((a) => a.auth)];
}

export class AuthRules {
  private readonly where: WhereCompiler;
  private isAuthenticatedParam?: string;
  private forbiddenParam?: string;

  constructor(
    model: V7Model,
    private readonly ctx: CypherContext,
    readonly auth: AuthContext,
  ) {
    this.where = new WhereCompiler(model, ctx, true);
  }

  /** `$pN` holding the "Forbidden" message (one parameter per statement). */
  forbiddenMessage(): string {
    this.forbiddenParam ??= this.ctx.param("Forbidden");
    return this.forbiddenParam;
  }

  private isAuthenticated(): string {
    this.isAuthenticatedParam ??= this.ctx.param(this.auth.isAuthenticated);
    return this.isAuthenticatedParam;
  }

  /**
   * Filter of the `filter` rules for `operation` on `variable` (type rules AND the rules of each of
   * `attributes`), or `undefined` when no rule applies.
   */
  filter(
    variable: string,
    node: NodeType,
    operation: AuthOperation,
    attributes: readonly Attribute[] = [],
  ): string | undefined {
    return and(
      annotations(node, attributes).map((a) =>
        or(
          (a?.authorization?.filter ?? [])
            .filter((r) => r.operations.includes(operation))
            .map((r) => this.rule(variable, node, r)),
        ),
      ),
    );
  }

  /**
   * Predicates of the `validate` rules for `operation` / `when`, one per annotation (type, then each
   * of `attributes`); each must hold.
   */
  validations(
    variable: string,
    node: NodeType,
    operation: AuthOperation,
    when: When,
    attributes: readonly Attribute[] = [],
  ): string[] {
    const out: string[] = [];
    for (const a of annotations(node, attributes)) {
      const p = or(
        (a?.authorization?.validate ?? [])
          .filter((r) => r.operations.includes(operation) && r.when.includes(when))
          .map((r) => this.rule(variable, node, r)),
      );
      if (p !== undefined) out.push(p);
    }
    return out;
  }

  /**
   * `true` when one of `validations` does not hold for the node (`null` counts as not holding), or
   * `undefined` when there is nothing to check.
   */
  failure(validations: readonly string[]): string | undefined {
    if (!validations.length) return undefined;
    return or(validations.map((v) => `NOT coalesce(${v}, false)`));
  }

  /** {@link failure} of the validations of `operation` / `when`. */
  fails(
    variable: string,
    node: NodeType,
    operation: AuthOperation,
    when: When,
    attributes: readonly Attribute[] = [],
  ): string | undefined {
    return this.failure(this.validations(variable, node, operation, when, attributes));
  }

  /** `CASE WHEN <failure> THEN 'Forbidden' END` (a failed-check message for mutations). */
  check(failure: string | undefined): string | undefined {
    return failure === undefined
      ? undefined
      : `CASE WHEN ${failure} THEN ${this.forbiddenMessage()} END`;
  }

  private rule(variable: string, node: NodeType, rule: AuthorizationRule): string | undefined {
    const auth = rule.requireAuthentication ? `${this.isAuthenticated()} = true` : undefined;
    const where = this.ruleWhere(variable, node, this.populate(rule.where) as AnyRecord);
    return and([auth, where]);
  }

  /** `{ node, jwt, AND, OR, NOT }`: keys combined with AND. */
  private ruleWhere(variable: string, node: NodeType, where: AnyRecord): string | undefined {
    const parts: (string | undefined)[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined || value === null) continue;
      switch (key) {
        case "node":
          parts.push(this.where.node(variable, node, value));
          break;
        case "jwt":
          if (!isRecord(value)) throw new GraphQLError("Invalid authorization rule: jwt");
          parts.push(this.jwt(value));
          break;
        case "AND":
        case "OR": {
          const items = (Array.isArray(value) ? value : [value]).map((w) => {
            if (!isRecord(w)) throw new GraphQLError(`Invalid authorization rule: ${key}`);
            return this.ruleWhere(variable, node, w);
          });
          parts.push(key === "AND" ? and(items) : or(items));
          break;
        }
        case "NOT": {
          if (!isRecord(value)) throw new GraphQLError("Invalid authorization rule: NOT");
          const inner = this.ruleWhere(variable, node, value);
          parts.push(inner === undefined ? undefined : `NOT (${inner})`);
          break;
        }
        default:
          throw new GraphQLError(`Invalid authorization rule key ${key}`);
      }
    }
    return and(parts);
  }

  /** `jwt: { roles: { includes: "admin" } }`: `($claim IS NOT NULL AND $value IN $claim)`. */
  private jwt(where: AnyRecord): string | undefined {
    const parts: (string | undefined)[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (key === "AND" || key === "OR") {
        const items = (Array.isArray(value) ? value : [value]).map((w) => {
          if (!isRecord(w)) throw new GraphQLError(`Invalid JWT filter ${key}`);
          return this.jwt(w);
        });
        parts.push(key === "AND" ? and(items) : or(items));
        continue;
      }
      if (key === "NOT") {
        if (!isRecord(value)) throw new GraphQLError("Invalid JWT filter NOT");
        const inner = this.jwt(value);
        parts.push(inner === undefined ? undefined : `NOT (${inner})`);
        continue;
      }
      const { field, operator } = parseJwtWhereKey(key);
      const claim = this.ctx.param(claimValue(this.auth, field) ?? null);
      const comparisons: string[] = [];
      if (operator) {
        comparisons.push(jwtComparison(operator, claim, this.ctx.param(this.unwrap(value))));
      } else {
        if (!isRecord(value)) throw new GraphQLError(`Invalid JWT filter ${key}`);
        for (const [op, v] of Object.entries(value)) {
          if (v === undefined) continue;
          const legacy = GENERIC_OPERATORS[op];
          if (!legacy)
            throw new GraphQLError(`Invalid operator ${op} in an authorization JWT filter`);
          comparisons.push(jwtComparison(legacy, claim, this.ctx.param(this.unwrap(v))));
        }
      }
      const cmp = and(comparisons);
      parts.push(cmp === undefined ? undefined : `(${claim} IS NOT NULL AND ${cmp})`);
    }
    return and(parts);
  }

  private unwrap(v: unknown): unknown {
    return v instanceof AuthValue ? (v.value ?? null) : (v ?? null);
  }

  /**
   * Copy of a rule `where` with `$jwt.<path>` / `$context.<path>` strings replaced by their values
   * for this request ({@link AuthValue}); like v7, strings inside lists are left as they are.
   */
  private populate(value: unknown, key?: string): unknown {
    if (typeof value === "string") return this.reference(value);
    if (Array.isArray(value)) {
      return key === "AND" || key === "OR" ? value.map((v) => this.populate(v)) : value;
    }
    if (isRecord(value)) {
      const out: AnyRecord = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.populate(v, k);
      return out;
    }
    return value;
  }

  private reference(value: string): unknown {
    if (value.startsWith("$jwt")) {
      const path = value.substring(5);
      const mapped = this.auth.claims?.get(path) ?? path;
      // v7 splits `$jwt` paths on every dot (escaping is only supported in @jwtClaim filters).
      return new AuthValue(readPath(this.auth.jwt ?? {}, mapped.split(".")));
    }
    if (value.startsWith("$context")) {
      return new AuthValue(readPath(this.auth.context, value.substring(9).split(".")));
    }
    return value;
  }
}
