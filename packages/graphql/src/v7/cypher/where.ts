/**
 * Compiles v7 `where` inputs to Cypher predicates.
 *
 * Semantics follow `@neo4j/graphql` 7.6 (checked by the compatibility suite):
 * - several keys in one object are combined with `AND`; `AND` / `OR` / `NOT` nest;
 * - `{ eq: null }` matches a missing property (`IS NULL`);
 * - relationship quantifiers: `some`, `none` and `single` with an empty filter (`{}`) are ignored
 *   (they match every node); `all` requires at least one related node and is not vacuously true;
 * - deprecated `field_OPERATOR` keys (`title_CONTAINS`, `actors_SOME`, …) behave like the generic form;
 * - aggregation filters (`actorsConnection: { aggregate: … }` and the deprecated `actorsAggregate`):
 *   each comparison aggregates the related nodes / relationships in its own subquery and compares
 *   the result (an empty set gives `count` 0, `sum` 0 and `null` for the other aggregates, which
 *   matches nothing, even under `NOT`). In the connection form, `count.nodes` and `node` aggregates
 *   run over distinct nodes; `count.edges`, `edge` and the deprecated form do not deduplicate.
 *
 * Every value becomes a parameter; every identifier comes from the type definitions and is quoted.
 *
 * @packageDocumentation
 */

import neo4j from "neo4j-driver";
import { FOLLOW_UP, notImplemented } from "../errors.js";
import type { Attribute, NodeType, PropertiesType, Relationship, V7Model } from "../model.js";
import {
  type CypherContext,
  labels,
  listAggregate,
  q,
  withList,
  type ListAggregate,
} from "./context.js";

type AnyRecord = Record<string, unknown>;

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

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function and(parts: (string | undefined)[]): string | undefined {
  const ps = parts.filter((p): p is string => p !== undefined);
  if (ps.length === 0) return undefined;
  if (ps.length === 1) return ps[0];
  return ps.map((p) => `(${p})`).join(" AND ");
}

/** Encode one input value for the attribute's type (Int → driver integer, …). */
function encodeValue(attr: Attribute, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => encodeValue(attr, v));
  if (attr.kind === "scalar" && attr.type.name === "Int" && typeof value === "number") {
    return neo4j.int(value);
  }
  return value;
}

/** `$p` or `datetime($p)` / `[x IN $p | datetime(x)]` for DateTime values (passed as strings). */
function valueExpr(ctx: CypherContext, attr: Attribute, value: unknown, isList: boolean): string {
  const p = ctx.param(encodeValue(attr, value));
  if (attr.kind === "scalar" && attr.type.name === "DateTime") {
    return isList ? `[x IN ${p} | datetime(x)]` : `datetime(${p})`;
  }
  return p;
}

function attributePredicate(
  ctx: CypherContext,
  expr: string,
  attr: Attribute,
  op: string,
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (op === "eq" && value === null) return `${expr} IS NULL`;
  if (value === null) return undefined;
  if (attr.type.list) {
    switch (op) {
      case "eq":
        return `${expr} = ${valueExpr(ctx, attr, value, true)}`;
      case "includes":
        return `${valueExpr(ctx, attr, value, false)} IN ${expr}`;
    }
    throw new Error(`Unsupported list filter operator ${op}`);
  }
  switch (op) {
    case "eq":
      return `${expr} = ${valueExpr(ctx, attr, value, false)}`;
    case "in":
      return `${expr} IN ${valueExpr(ctx, attr, value, true)}`;
    case "contains":
      return `${expr} CONTAINS ${valueExpr(ctx, attr, value, false)}`;
    case "startsWith":
      return `${expr} STARTS WITH ${valueExpr(ctx, attr, value, false)}`;
    case "endsWith":
      return `${expr} ENDS WITH ${valueExpr(ctx, attr, value, false)}`;
    case "lt":
      return `${expr} < ${valueExpr(ctx, attr, value, false)}`;
    case "lte":
      return `${expr} <= ${valueExpr(ctx, attr, value, false)}`;
    case "gt":
      return `${expr} > ${valueExpr(ctx, attr, value, false)}`;
    case "gte":
      return `${expr} >= ${valueExpr(ctx, attr, value, false)}`;
  }
  throw new Error(`Unsupported filter operator ${op}`);
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
    if (direct.cypher) throw notImplemented(`filtering on @cypher field ${key}`, FOLLOW_UP.cypher);
    const expr = `${variable}.${q(direct.property)}`;
    const preds = Object.entries(value as AnyRecord).map(([op, v]) =>
      attributePredicate(ctx, expr, direct, op, v),
    );
    return { handled: true, predicate: and(preds) };
  }
  const m = /^(.+)_([A-Z_]+)$/.exec(key);
  if (m) {
    const attr = attributes.find((a) => a.name === m[1]);
    const op = LEGACY_OPERATORS[m[2]!];
    if (attr && op) {
      if (attr.cypher)
        throw notImplemented(`filtering on @cypher field ${attr.name}`, FOLLOW_UP.cypher);
      return {
        handled: true,
        predicate: attributePredicate(ctx, `${variable}.${q(attr.property)}`, attr, op, value),
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
    if (!Array.isArray(value)) return { handled: true };
    const parts = value.filter(isPlainObject).map(compile);
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
    if (!isPlainObject(value)) return { handled: true };
    const inner = compile(value);
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
  const p = ctx.param(value);
  const isDateTime = attr?.kind === "scalar" && attr.type.name === "DateTime";
  return `${expr} ${cmp} ${isDateTime ? `datetime(${p})` : p}`;
}

export class WhereCompiler {
  constructor(
    private readonly model: V7Model,
    private readonly ctx: CypherContext,
    /** Called for every node type a filter traverses (authorization is not implemented yet). */
    private readonly onTraverse: (node: NodeType) => void = () => {},
  ) {}

  /** Predicate for a `${Node}Where` input on `variable`, or `undefined` when it filters nothing. */
  node(variable: string, node: NodeType, where: unknown): string | undefined {
    if (!isPlainObject(where)) return undefined;
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
      parts.push(this.relationshipFilter(variable, node, key, value));
    }
    return and(parts);
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
    if (rel) {
      if (!isPlainObject(value)) return undefined;
      return and(
        Object.entries(value).map(([q, w]) => this.related(variable, rel!, q as Quantifier, w)),
      );
    }
    // `actorsConnection: { some: … , aggregate: … }`
    if (key.endsWith("Connection") && (rel = find(key.slice(0, -"Connection".length)))) {
      if (!isPlainObject(value)) return undefined;
      return and(
        Object.entries(value).map(([q, w]) => {
          if (q === "aggregate") return this.aggregate(variable, rel!, w, false);
          return this.relatedConnection(variable, rel!, q as Quantifier, w);
        }),
      );
    }
    if (key.endsWith("Aggregate") && (rel = find(key.slice(0, -"Aggregate".length)))) {
      return this.aggregate(variable, rel, value, true);
    }
    // Deprecated `actors_SOME` / `actorsConnection_SOME`.
    const m = /^(.+)_(ALL|NONE|SINGLE|SOME)$/.exec(key);
    if (m) {
      const quantifier = QUANTIFIER_KEYS[m[2]!]!;
      if ((rel = find(m[1]!))) return this.related(variable, rel, quantifier, value);
      if (m[1]!.endsWith("Connection") && (rel = find(m[1]!.slice(0, -"Connection".length)))) {
        return this.relatedConnection(variable, rel, quantifier, value);
      }
    }
    throw new Error(`Unknown filter ${node.name}Where.${key}`);
  }

  private related(
    variable: string,
    rel: Relationship,
    quantifier: Quantifier,
    where: unknown,
  ): string | undefined {
    if (!isPlainObject(where)) return undefined;
    const m = this.ctx.variable("n");
    const target = this.model.node(rel.target);
    this.onTraverse(target);
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
    if (!isPlainObject(where)) return undefined;
    const m = this.ctx.variable("n");
    const r = this.ctx.variable("r");
    this.onTraverse(this.model.node(rel.target));
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
    if (!isPlainObject(where)) return undefined;
    const target = this.model.node(rel.target);
    this.onTraverse(target);
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
          if (!isPlainObject(value)) continue;
          if (deprecated) {
            parts.push(this.countFilter(scope, false, value));
            continue;
          }
          for (const [what, filters] of Object.entries(value)) {
            if (!isPlainObject(filters)) continue;
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
    if (!isPlainObject(where)) return undefined;
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
        if (!isPlainObject(value)) continue;
        for (const [aggOp, filters] of Object.entries(value)) {
          if (!isPlainObject(filters)) continue;
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
    if (!isPlainObject(where)) return undefined;
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
    if (!isPlainObject(where)) return undefined;
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
