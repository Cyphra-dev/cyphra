/**
 * Compiles v7 `where` inputs to Cypher predicates.
 *
 * Semantics follow `@neo4j/graphql` 7.6 (checked by the compatibility suite):
 * - several keys in one object are combined with `AND`; `AND` / `OR` / `NOT` nest;
 * - `{ eq: null }` matches a missing property (`IS NULL`);
 * - relationship quantifiers: `some`, `none` and `single` with an empty filter (`{}`) are ignored
 *   (they match every node); `all` requires at least one related node and is not vacuously true;
 * - to-one relationships (`lab: Lab`) take the target's `where` directly (`lab: { name: … }`, true
 *   when the related node matches; `lab: null` when there is none) and a connection `where`
 *   (`labConnection: { node, edge }`); in authorization rules, the connection form requires exactly
 *   one matching relationship (v7 `single`);
 * - relationships to unions are filtered per member (`favorites: { some: { Movie: …, Book: … } }`,
 *   members left out are not tested), the member filters combined with `OR` (`some`), `XOR`
 *   (`single`) or `AND` (`all`, `none`);
 * - deprecated `field_OPERATOR` keys (`title_CONTAINS`, `actors_SOME`, …) behave like the generic form;
 * - aggregation filters (`actorsConnection: { aggregate: … }` and the deprecated `actorsAggregate`):
 *   each comparison aggregates the related nodes / relationships in its own subquery and compares
 *   the result (an empty set gives `count` 0, `sum` 0 and `null` for the other aggregates, which
 *   matches nothing, even under `NOT`). In the connection form, `count.nodes` and `node` aggregates
 *   run over distinct nodes; `count.edges`, `edge` and the deprecated form do not deduplicate.
 *
 * Every value becomes a parameter; every identifier comes from the type definitions and is quoted.
 *
 * The same compiler compiles the `node` part of `@authorization` rules, where `$jwt.<claim>` and
 * `$context.<path>` references are resolved to {@link AuthValue}s first: like v7, a comparison with
 * such a value is guarded by `$p IS NOT NULL` (a missing claim matches nothing, even under `NOT`).
 *
 * @packageDocumentation
 */

import neo4j from "neo4j-driver";
import {
  isUnionRelationship,
  selectedMembers,
  unionMembers,
  type Attribute,
  type CypherNodeField,
  type NodeType,
  type PropertiesType,
  type Relationship,
  type V7Model,
} from "../model.js";
import {
  type CypherContext,
  labels,
  listAggregate,
  q,
  withList,
  type ListAggregate,
} from "./context.js";
import { nodeRows, scalarExpr } from "./custom.js";

type AnyRecord = Record<string, unknown>;

/**
 * A `$jwt.<claim>` / `$context.<path>` reference of an authorization rule, resolved for the
 * request. Always passed as a parameter (never inlined) and compared under `IS NOT NULL`.
 */
export class AuthValue {
  constructor(readonly value: unknown) {}
}

const LEGACY_OPERATORS: Record<string, string> = {
  EQ: "eq",
  IN: "in",
  INCLUDES: "includes",
  CONTAINS: "contains",
  STARTS_WITH: "startsWith",
  ENDS_WITH: "endsWith",
  LT: "lt",
  LTE: "lte",
  GT: "gt",
  GTE: "gte",
};

const QUANTIFIER_KEYS: Record<string, Quantifier> = {
  ALL: "all",
  NONE: "none",
  SINGLE: "single",
  SOME: "some",
};

type Quantifier = "all" | "none" | "single" | "some";

/** A plain (or null-prototype, from `valueFromASTUntyped`) object; not an {@link AuthValue}. */
function isPlainObject(v: unknown): v is AnyRecord {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function and(parts: (string | undefined)[]): string | undefined {
  const ps = parts.filter((p): p is string => p !== undefined);
  if (ps.length === 0) return undefined;
  if (ps.length === 1) return ps[0];
  return ps.map((p) => `(${p})`).join(" AND ");
}

/**
 * `where` as an object, `undefined` for `null` / `undefined`. Anything else is an error, never
 * ignored: a filter that silently matched everything would widen an authorization rule.
 */
function objectOrNothing(where: unknown, what: string): AnyRecord | undefined {
  return isFilterObject(where, what) ? where : undefined;
}

/** `true` for an object, `false` for `null` / `undefined`; throws for anything else. */
function isFilterObject(where: unknown, what: string): where is AnyRecord {
  if (where === null || where === undefined) return false;
  if (!isPlainObject(where)) throw new Error(`Invalid ${what}: expected an object`);
  return true;
}

/** Encode one input value for the attribute's type (Int → driver integer, …). */
export function encodeValue(attr: Attribute, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => encodeValue(attr, v));
  if (attr.kind === "scalar" && attr.type.name === "Int" && typeof value === "number") {
    return neo4j.int(value);
  }
  return value;
}

/** `expr`, or `datetime(expr)` / `[x IN expr | datetime(x)]` for DateTime values (passed as strings). */
export function castValue(attr: Attribute, expr: string, isList: boolean): string {
  if (attr.kind === "scalar" && attr.type.name === "DateTime") {
    return isList ? `[x IN ${expr} | datetime(x)]` : `datetime(${expr})`;
  }
  return expr;
}

/** The value as a parameter, cast for its type (see {@link castValue}). */
export function valueExpr(
  ctx: CypherContext,
  attr: Attribute,
  value: unknown,
  isList: boolean,
): string {
  return castValue(attr, ctx.param(encodeValue(attr, value)), isList);
}

function attributePredicate(
  ctx: CypherContext,
  expr: string,
  attr: Attribute,
  op: string,
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (value instanceof AuthValue) {
    // `$jwt` / `$context` reference: passed as it is (no Int conversion), guarded like v7.
    const p = ctx.param(value.value ?? null);
    const pred = attributeComparison(expr, attr, op, (isList) => castValue(attr, p, isList));
    return `(${p} IS NOT NULL AND ${pred})`;
  }
  if (op === "eq" && value === null) return `${expr} IS NULL`;
  if (value === null) return undefined;
  return attributeComparison(expr, attr, op, (isList) => valueExpr(ctx, attr, value, isList));
}

function attributeComparison(
  expr: string,
  attr: Attribute,
  op: string,
  v: (isList: boolean) => string,
): string {
  if (attr.type.list) {
    switch (op) {
      case "eq":
        return `${expr} = ${v(true)}`;
      case "includes":
        return `${v(false)} IN ${expr}`;
    }
    throw new Error(`Unsupported list filter operator ${op}`);
  }
  switch (op) {
    case "eq":
      return `${expr} = ${v(false)}`;
    case "in":
      return `${expr} IN ${v(true)}`;
    case "contains":
      return `${expr} CONTAINS ${v(false)}`;
    case "startsWith":
      return `${expr} STARTS WITH ${v(false)}`;
    case "endsWith":
      return `${expr} ENDS WITH ${v(false)}`;
    case "lt":
      return `${expr} < ${v(false)}`;
    case "lte":
      return `${expr} <= ${v(false)}`;
    case "gt":
      return `${expr} > ${v(false)}`;
    case "gte":
      return `${expr} >= ${v(false)}`;
  }
  throw new Error(`Unsupported filter operator ${op}`);
}

/** `variable.property`, or the value of a `@cypher` field (see `scalarExpr`). */
function attributeExpr(ctx: CypherContext, variable: string, attr: Attribute): string {
  if (!attr.cypher) return `${variable}.${q(attr.property)}`;
  if (attr.args.length)
    throw new Error(`Cannot filter on @cypher field ${attr.name} with arguments`);
  return scalarExpr(ctx, variable, attr.cypher, attr.type.list);
}

/** Predicates on the attributes of a node or relationship (`variable.property`). */
function attributeFilter(
  ctx: CypherContext,
  variable: string,
  attributes: readonly Attribute[],
  key: string,
  value: unknown,
): { handled: boolean; predicate?: string } {
  const direct = attributes.find((a) => a.name === key);
  if (direct) {
    if (value === null || value === undefined) return { handled: true };
    if (!isPlainObject(value)) throw new Error(`Invalid filter on ${key}`);
    const ops = Object.entries(value as AnyRecord).filter(([, v]) => v !== undefined);
    if (ops.length === 0) return { handled: true };
    const expr = attributeExpr(ctx, variable, direct);
    const preds = ops.map(([op, v]) => attributePredicate(ctx, expr, direct, op, v));
    return { handled: true, predicate: and(preds) };
  }
  const m = /^(.+)_([A-Z_]+)$/.exec(key);
  if (m) {
    const attr = attributes.find((a) => a.name === m[1]);
    const op = LEGACY_OPERATORS[m[2]!];
    if (attr && op) {
      if (value === undefined) return { handled: true };
      if (value === null && op !== "eq") return { handled: true };
      return {
        handled: true,
        predicate: attributePredicate(ctx, attributeExpr(ctx, variable, attr), attr, op, value),
      };
    }
  }
  return { handled: false };
}

function logical(
  where: AnyRecord,
  key: string,
  compile: (w: AnyRecord) => string | undefined,
): { handled: boolean; predicate?: string } {
  const value = where[key];
  if (key === "AND" || key === "OR") {
    if (value === null || value === undefined) return { handled: true };
    const parts = (Array.isArray(value) ? value : [value])
      .filter((w) => w !== null && w !== undefined)
      .map((w) => compile(objectOrNothing(w, key)!));
    if (key === "AND") return { handled: true, predicate: and(parts) };
    // An empty member of OR matches everything.
    if (parts.length === 0) return { handled: true };
    if (parts.some((p) => p === undefined)) return { handled: true, predicate: "true" };
    return {
      handled: true,
      predicate: parts.length === 1 ? parts[0] : parts.map((p) => `(${p})`).join(" OR "),
    };
  }
  if (key === "NOT") {
    const o = objectOrNothing(value, key);
    if (o === undefined) return { handled: true };
    const inner = compile(o);
    return { handled: true, predicate: inner === undefined ? undefined : `NOT (${inner})` };
  }
  return { handled: false };
}

/** Pattern from `from` along relationship `rel` to `(to:Target)`, binding the edge to `relVar`. */
export function relationshipPattern(
  model: V7Model,
  from: string,
  rel: Relationship,
  to: string,
  relVar = "",
): string {
  const target = model.node(rel.target);
  const edge = `[${relVar}:${q(rel.type)}]`;
  const end = `(${to}${labels(target.labels)})`;
  return rel.direction === "OUT" ? `(${from})-${edge}->${end}` : `(${from})<-${edge}-${end}`;
}

function quantified(
  pattern: string,
  quantifier: Quantifier,
  predicate: string | undefined,
): string | undefined {
  // `{}` inside some / none / single / all: the filter is ignored (v7 behaviour).
  if (predicate === undefined) return undefined;
  switch (quantifier) {
    case "some":
      return `EXISTS { MATCH ${pattern} WHERE ${predicate} }`;
    case "none":
      return `NOT EXISTS { MATCH ${pattern} WHERE ${predicate} }`;
    case "single":
      return `COUNT { MATCH ${pattern} WHERE ${predicate} } = 1`;
    case "all":
      return `EXISTS { MATCH ${pattern} } AND NOT EXISTS { MATCH ${pattern} WHERE NOT (${predicate}) }`;
  }
  throw new Error(`Unknown relationship filter ${String(quantifier)}`);
}

/**
 * The per-member predicates of a relationship filter to a union, combined like v7: `some` with
 * `OR`, `single` with `XOR`, `all` / `none` with `AND`.
 */
function combineMembers(quantifier: Quantifier, parts: (string | undefined)[]): string | undefined {
  const ps = parts.filter((p): p is string => p !== undefined);
  if (ps.length <= 1) return ps[0];
  const op = quantifier === "some" ? "OR" : quantifier === "single" ? "XOR" : "AND";
  return ps.map((p) => `(${p})`).join(` ${op} `);
}

type AggregateScope = { pattern: string; nodeVar: string; relVar: string };

/** Comparison keys of aggregation filters, generic and deprecated (`_EQUAL`, `count_EQ`). */
const AGGREGATION_COMPARISON: Record<string, string> = {
  EQ: "eq",
  EQUAL: "eq",
  GT: "gt",
  GTE: "gte",
  LT: "lt",
  LTE: "lte",
};

const GENERIC_AGGREGATES: Record<string, ListAggregate> = {
  average: "avg",
  averageLength: "avg",
  min: "min",
  shortest: "min",
  shortestLength: "min",
  max: "max",
  longest: "max",
  longestLength: "max",
  sum: "sum",
};

const LEGACY_AGGREGATES: Record<string, ListAggregate> = {
  AVERAGE: "avg",
  MIN: "min",
  SHORTEST: "min",
  MAX: "max",
  LONGEST: "max",
  SUM: "sum",
};

const COMPARISON_OPERATORS: Record<string, string> = {
  eq: "=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

/**
 * `expr <op> $p` for an aggregation filter. Numbers are passed as they come (an `average` filter
 * on an Int field takes a Float); DateTime values go through `datetime()`.
 */
function comparison(
  ctx: CypherContext,
  expr: string,
  op: string,
  value: unknown,
  attr: Attribute | undefined,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const cmp = COMPARISON_OPERATORS[op];
  if (!cmp) throw new Error(`Invalid aggregation filter operator ${op}`);
  const ref = value instanceof AuthValue;
  const p = ctx.param(ref ? (value.value ?? null) : value);
  const isDateTime = attr?.kind === "scalar" && attr.type.name === "DateTime";
  const pred = `${expr} ${cmp} ${isDateTime ? `datetime(${p})` : p}`;
  return ref ? `(${p} IS NOT NULL AND ${pred})` : pred;
}

export class WhereCompiler {
  constructor(
    private readonly model: V7Model,
    private readonly ctx: CypherContext,
    /** Compiles the `node` part of `@authorization` rules (v7 builds those filters differently). */
    private readonly authorization = false,
  ) {}

  /** Predicate for a `${Node}Where` input on `variable`, or `undefined` when it filters nothing. */
  node(variable: string, node: NodeType, where: unknown): string | undefined {
    if (!isFilterObject(where, "filter")) return undefined;
    const parts: (string | undefined)[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      const l = logical(where, key, (w) => this.node(variable, node, w));
      if (l.handled) {
        parts.push(l.predicate);
        continue;
      }
      const a = attributeFilter(this.ctx, variable, node.attributes, key, value);
      if (a.handled) {
        parts.push(a.predicate);
        continue;
      }
      const c = this.cypherNodeFilter(variable, node, key, value);
      if (c.handled) {
        parts.push(c.predicate);
        continue;
      }
      parts.push(this.relationshipFilter(variable, node, key, value));
    }
    return and(parts);
  }

  /**
   * Filters on `@cypher` fields returning nodes (v7 7.6): for a list, `actors: { some | all | none |
   * single }` (and `actors_SOME`, …) test the returned nodes with `any` / `all` / `none` / `single`
   * (so `all` holds when the statement returns nothing); for one node, `topActor: { … }` tests the
   * first returned node and `topActor: null` matches when there is none.
   */
  private cypherNodeFilter(
    variable: string,
    node: NodeType,
    key: string,
    value: unknown,
  ): { handled: boolean; predicate?: string } {
    const legacy = /^(.+)_(ALL|NONE|SINGLE|SOME)$/.exec(key);
    const name = node.cypherNodes.some((c) => c.name === key) ? key : legacy?.[1];
    const field = node.cypherNodes.find((c) => c.name === name);
    if (!field) return { handled: false };
    if (field.args.length)
      throw new Error(`Cannot filter on @cypher field ${field.name} with arguments`);
    const target = this.model.node(field.target);
    if (!field.type.list) {
      if (value === undefined) return { handled: true };
      const x = this.ctx.variable("n");
      const rows = nodeRows(this.ctx, variable, field.cypher, x);
      if (value === null) return { handled: true, predicate: `NOT EXISTS {\n${rows}\n}` };
      const pred = this.node(x, target, value);
      if (pred === undefined) return { handled: true };
      // The first returned node (v7: `head(collect(…))`).
      return {
        handled: true,
        predicate: `EXISTS {\n${rows}\nWITH ${x} LIMIT 1\nWITH ${x} WHERE ${pred}\n}`,
      };
    }
    const quantifiers: [Quantifier, unknown][] =
      key === field.name
        ? isFilterObject(value, key)
          ? Object.entries(value).map(([k, w]) => [k as Quantifier, w])
          : []
        : [[QUANTIFIER_KEYS[legacy![2]!]!, value]];
    return {
      handled: true,
      predicate: and(
        quantifiers.map(([quantifier, w]) =>
          this.cypherNodes(variable, field, target, quantifier, w),
        ),
      ),
    };
  }

  /** `any` / `all` / `none` / `single` of the nodes returned by the statement (v7 semantics). */
  private cypherNodes(
    variable: string,
    field: CypherNodeField,
    target: NodeType,
    quantifier: Quantifier,
    where: unknown,
  ): string | undefined {
    if (!isFilterObject(where, "filter")) return undefined;
    const x = this.ctx.variable("n");
    const pred = this.node(x, target, where);
    if (pred === undefined) return undefined;
    const rows = () => nodeRows(this.ctx, variable, field.cypher, x);
    const matching = () => `COUNT {\n${rows()}\nWITH ${x} WHERE ${pred}\n}`;
    switch (quantifier) {
      case "some":
        return `EXISTS {\n${rows()}\nWITH ${x} WHERE ${pred}\n}`;
      case "none":
        return `NOT EXISTS {\n${rows()}\nWITH ${x} WHERE ${pred}\n}`;
      case "single":
        return `${matching()} = 1`;
      case "all":
        // Vacuously true without rows (v7 `all(x IN list WHERE …)`); a null predicate is false.
        return `${matching()} = COUNT {\n${rows()}\n}`;
    }
    throw new Error(`Unknown relationship filter ${String(quantifier)}`);
  }

  private relationshipFilter(
    variable: string,
    node: NodeType,
    key: string,
    value: unknown,
  ): string | undefined {
    const find = (name: string) => node.relationships.find((r) => r.name === name);
    // `actors: { some: … }`
    let rel = find(key);
    if (rel && !rel.list) return this.toOne(variable, rel, value);
    if (rel) {
      if (!isFilterObject(value, key)) return undefined;
      return and(
        Object.entries(value).map(([q, w]) => this.related(variable, rel!, q as Quantifier, w)),
      );
    }
    // `actorsConnection: { some: … , aggregate: … }`
    if (key.endsWith("Connection") && (rel = find(key.slice(0, -"Connection".length)))) {
      // To-one: `labConnection: { node, edge }` (v7: `some`, or `single` in authorization rules).
      if (!rel.list) {
        return this.relatedConnection(variable, rel, this.authorization ? "single" : "some", value);
      }
      if (!isFilterObject(value, key)) return undefined;
      return and(
        Object.entries(value).map(([q, w]) => {
          if (q === "aggregate") return this.aggregate(variable, rel!, w, false);
          return this.relatedConnection(variable, rel!, q as Quantifier, w);
        }),
      );
    }
    if (key.endsWith("Aggregate") && (rel = find(key.slice(0, -"Aggregate".length)))) {
      if (!rel.list) throw new Error(`Unknown filter ${node.name}Where.${key}`);
      return this.aggregate(variable, rel, value, true);
    }
    // Deprecated `actors_SOME` / `actorsConnection_SOME` (not on to-one relationships).
    const m = /^(.+)_(ALL|NONE|SINGLE|SOME)$/.exec(key);
    if (m) {
      const quantifier = QUANTIFIER_KEYS[m[2]!]!;
      if ((rel = find(m[1]!)) && rel.list) return this.related(variable, rel, quantifier, value);
      if (
        m[1]!.endsWith("Connection") &&
        (rel = find(m[1]!.slice(0, -"Connection".length))) &&
        rel.list
      ) {
        return this.relatedConnection(variable, rel, quantifier, value);
      }
    }
    throw new Error(`Unknown filter ${node.name}Where.${key}`);
  }

  /**
   * `lab: { … }` on a to-one relationship (v7 7.6): `{}` filters nothing, `null` matches nodes
   * without a related node (and filters nothing on a relationship to a union), anything else matches when the related node exists and matches (in an
   * authorization rule, a filter without conditions filters nothing). To a union, the member keys
   * select the members (any of them may match).
   */
  private toOne(variable: string, rel: Relationship, value: unknown): string | undefined {
    if (value === undefined) return undefined;
    const members = unionMembers(this.model, rel);
    if (value === null) {
      // v7 7.6: `null` on a to-one relationship to a union filters nothing.
      if (isUnionRelationship(this.model, rel)) return undefined;
      return `NOT EXISTS { MATCH ${relationshipPattern(this.model, variable, rel, "")} }`;
    }
    if (!isFilterObject(value, rel.name) || Object.keys(value).length === 0) return undefined;
    const selected = isUnionRelationship(this.model, rel)
      ? selectedMembers(members, value)
      : [{ rel, where: value as unknown }];
    return combineMembers(
      "some",
      selected.map(({ rel: m, where: w }) => {
        const n = this.ctx.variable("n");
        const pattern = relationshipPattern(this.model, variable, m, n);
        const pred = this.node(n, this.model.node(m.target), w);
        if (pred !== undefined) return `EXISTS { MATCH ${pattern} WHERE ${pred} }`;
        return this.authorization ? undefined : `EXISTS { MATCH ${pattern} }`;
      }),
    );
  }

  private related(
    variable: string,
    rel: Relationship,
    quantifier: Quantifier,
    where: unknown,
  ): string | undefined {
    if (!isFilterObject(where, "filter")) return undefined;
    if (isUnionRelationship(this.model, rel)) {
      // v7: `{}` filters nothing; else one filter per member keyed in `where`. A member without
      // conditions (`{ Book: {} }`) tests existence for `some` / `none`, and nothing for the others.
      if (Object.keys(where).length === 0) return undefined;
      return combineMembers(
        quantifier,
        selectedMembers(unionMembers(this.model, rel), where).map(({ rel: m, where: w }) => {
          const n = this.ctx.variable("n");
          const pattern = relationshipPattern(this.model, variable, m, n);
          const pred = this.node(n, this.model.node(m.target), w);
          if (pred !== undefined) return quantified(pattern, quantifier, pred);
          if (quantifier === "some") return `EXISTS { MATCH ${pattern} }`;
          if (quantifier === "none") return `NOT EXISTS { MATCH ${pattern} }`;
          return undefined;
        }),
      );
    }
    const m = this.ctx.variable("n");
    const target = this.model.node(rel.target);
    return quantified(
      relationshipPattern(this.model, variable, rel, m),
      quantifier,
      this.node(m, target, where),
    );
  }

  private relatedConnection(
    variable: string,
    rel: Relationship,
    quantifier: Quantifier,
    where: unknown,
  ): string | undefined {
    if (!isFilterObject(where, "filter")) return undefined;
    if (isUnionRelationship(this.model, rel)) {
      // v7: one filter per member keyed in `where` (every member without keys); a member
      // without conditions filters nothing.
      return combineMembers(
        quantifier,
        selectedMembers(unionMembers(this.model, rel), where).map(({ rel: m, where: w }) => {
          const n = this.ctx.variable("n");
          const r = this.ctx.variable("r");
          return quantified(
            relationshipPattern(this.model, variable, m, n, r),
            quantifier,
            this.connection(r, n, m, w),
          );
        }),
      );
    }
    const m = this.ctx.variable("n");
    const r = this.ctx.variable("r");
    return quantified(
      relationshipPattern(this.model, variable, rel, m, r),
      quantifier,
      this.connection(r, m, rel, where),
    );
  }

  /**
   * Predicate for a `${Source}${Rel}ConnectionAggregateInput` (`deprecated`: `${…}AggregateInput`,
   * the `actorsAggregate` form): `count`, `node`, `edge`, combined with AND / OR / NOT.
   */
  private aggregate(
    variable: string,
    rel: Relationship,
    where: unknown,
    deprecated: boolean,
  ): string | undefined {
    if (!isFilterObject(where, "filter")) return undefined;
    const target = this.model.node(rel.target);
    const m = this.ctx.variable("n");
    const r = this.ctx.variable("r");
    const pattern = relationshipPattern(this.model, variable, rel, m, r);
    const scope: AggregateScope = { pattern, nodeVar: m, relVar: r };
    const compile = (w: AnyRecord): string | undefined => {
      const parts: (string | undefined)[] = [];
      for (const [key, value] of Object.entries(w)) {
        if (value === undefined || value === null) continue;
        const l = logical(w, key, compile);
        if (l.handled) {
          parts.push(l.predicate);
          continue;
        }
        if (key === "count") {
          if (!isFilterObject(value, key)) continue;
          if (deprecated) {
            parts.push(this.countFilter(scope, false, value));
            continue;
          }
          for (const [what, filters] of Object.entries(value)) {
            if (!isFilterObject(filters, what)) continue;
            if (what === "nodes") parts.push(this.countFilter(scope, true, filters));
            else if (what === "edges") parts.push(this.countFilter(scope, false, filters));
            else throw new Error(`Unknown aggregation count filter ${what}`);
          }
          continue;
        }
        const legacyCount = /^count_(EQ|GT|GTE|LT|LTE)$/.exec(key);
        if (legacyCount) {
          parts.push(
            this.countFilter(scope, false, {
              [AGGREGATION_COMPARISON[legacyCount[1]!]!]: value,
            }),
          );
          continue;
        }
        if (key === "node") {
          parts.push(this.aggregationWhere(scope, target.attributes, "node", !deprecated, value));
          continue;
        }
        if (key === "edge") {
          const props = this.model.properties.get(rel.properties ?? "");
          if (!props) throw new Error(`Unknown aggregation filter ${key}`);
          parts.push(this.aggregationWhere(scope, props.attributes, "edge", false, value));
          continue;
        }
        throw new Error(`Unknown aggregation filter ${key}`);
      }
      return and(parts);
    };
    return compile(where);
  }

  /** `count` filters: `COUNT { … } >= $p` (one row per relationship, or per distinct node). */
  private countFilter(
    scope: AggregateScope,
    distinct: boolean,
    filters: AnyRecord,
  ): string | undefined {
    const count = distinct
      ? `COUNT { MATCH ${scope.pattern} WITH DISTINCT ${scope.nodeVar} RETURN ${scope.nodeVar} }`
      : `COUNT { MATCH ${scope.pattern} }`;
    return and(
      Object.entries(filters).map(([op, v]) => comparison(this.ctx, count, op, v, undefined)),
    );
  }

  /** `${…}NodeAggregationWhereInput` / `${Properties}AggregationWhereInput`. */
  private aggregationWhere(
    scope: AggregateScope,
    attributes: readonly Attribute[],
    on: "node" | "edge",
    distinct: boolean,
    where: unknown,
  ): string | undefined {
    if (!isFilterObject(where, "filter")) return undefined;
    const parts: (string | undefined)[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined || value === null) continue;
      const l = logical(where, key, (w) =>
        this.aggregationWhere(scope, attributes, on, distinct, w),
      );
      if (l.handled) {
        parts.push(l.predicate);
        continue;
      }
      const direct = attributes.find((a) => a.name === key);
      if (direct) {
        if (!isFilterObject(value, key)) continue;
        for (const [aggOp, filters] of Object.entries(value as AnyRecord)) {
          if (!isFilterObject(filters, aggOp)) continue;
          const fn = GENERIC_AGGREGATES[aggOp];
          if (!fn) throw new Error(`Invalid aggregation operator ${aggOp}`);
          const agg = this.aggregated(scope, direct, on, distinct, fn);
          for (const [op, v] of Object.entries(filters)) {
            parts.push(comparison(this.ctx, agg, op, v, direct));
          }
        }
        continue;
      }
      const m =
        /^(.+?)_(AVERAGE|MAX|MIN|SUM|SHORTEST|LONGEST)(?:_LENGTH)?_(EQUAL|GT|GTE|LT|LTE)$/.exec(
          key,
        );
      const attr = m && attributes.find((a) => a.name === m[1]);
      if (!m || !attr) throw new Error(`Unknown aggregation filter ${key}`);
      const agg = this.aggregated(scope, attr, on, distinct, LEGACY_AGGREGATES[m[2]!]!);
      parts.push(comparison(this.ctx, agg, AGGREGATION_COMPARISON[m[3]!]!, value, attr));
    }
    return and(parts);
  }

  /** `min` / `max` / … of the related values (`COLLECT { MATCH … RETURN n.born }`); strings: `size()`. */
  private aggregated(
    scope: AggregateScope,
    attr: Attribute,
    on: "node" | "edge",
    distinct: boolean,
    fn: ListAggregate,
  ): string {
    const v = on === "node" ? scope.nodeVar : scope.relVar;
    const prop = `${v}.${q(attr.property)}`;
    const expr = attr.kind === "scalar" && attr.type.name === "String" ? `size(${prop})` : prop;
    const dedupe = distinct ? ` WITH DISTINCT ${v}` : "";
    const list = `COLLECT { MATCH ${scope.pattern}${dedupe} WITH ${v} WHERE ${prop} IS NOT NULL RETURN ${expr} }`;
    return withList(list, this.ctx.variable("list"), (l) => listAggregate(fn, l));
  }

  /** Predicate for a `${Source}${Rel}ConnectionWhere` input (`node` / `edge`, AND / OR / NOT). */
  connection(
    relVar: string,
    nodeVar: string,
    rel: Relationship,
    where: unknown,
  ): string | undefined {
    if (!isFilterObject(where, "filter")) return undefined;
    const parts: (string | undefined)[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      const l = logical(where, key, (w) => this.connection(relVar, nodeVar, rel, w));
      if (l.handled) {
        parts.push(l.predicate);
        continue;
      }
      if (key === "node") {
        parts.push(this.node(nodeVar, this.model.node(rel.target), value));
        continue;
      }
      if (key === "edge") {
        const props = this.model.properties.get(rel.properties ?? "");
        if (props) parts.push(this.edge(relVar, props, value));
        continue;
      }
      throw new Error(`Unknown connection filter ${key}`);
    }
    return and(parts);
  }

  /** Predicate for a `${Properties}Where` input on a relationship variable. */
  edge(relVar: string, props: PropertiesType, where: unknown): string | undefined {
    if (!isFilterObject(where, "filter")) return undefined;
    const parts: (string | undefined)[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      const l = logical(where, key, (w) => this.edge(relVar, props, w));
      if (l.handled) {
        parts.push(l.predicate);
        continue;
      }
      const a = attributeFilter(this.ctx, relVar, props.attributes, key, value);
      if (!a.handled) throw new Error(`Unknown filter ${props.name}Where.${key}`);
      parts.push(a.predicate);
    }
    return and(parts);
  }
}
