import { isInterface, type Attribute, type NodeType } from "../model.js";

/** Parameters and fresh variable names for one Cypher statement. */
export class CypherContext {
  readonly params: Record<string, unknown> = {};
  private paramCount = 0;
  private varCount = 0;
  /** `$jwt` of `@cypher` statements: the decoded JWT, `{}` when not authenticated (v7). */
  jwt: unknown = {};

  /** Bind a value and return its `$placeholder`. */
  param(value: unknown): string {
    const key = `p${this.paramCount++}`;
    this.params[key] = value;
    return `$${key}`;
  }

  /** Bind a value under a fixed name (`$jwt` of `@cypher` statements). */
  namedParam(name: string, value: unknown): string {
    this.params[name] = value;
    return `$${name}`;
  }

  /** Fresh variable name, e.g. `this0`. */
  variable(prefix = "this"): string {
    return `${prefix}${this.varCount++}`;
  }
}

/** Quote an identifier (label, property key, relationship type, map key) for Cypher. */
export function q(id: string): string {
  return "`" + id.replace(/`/g, "``") + "`";
}

/** `:`A`:`B`` for a list of labels. */
export function labels(ls: readonly string[]): string {
  return ls.map((l) => `:${q(l)}`).join("");
}

/**
 * `v:A:B` for a `@node` type; for an interface, whether the node has the labels of one of its
 * implementations (`(v:Lab:LearningActivity OR v:Quiz:LearningActivity)`), since v7 adds no label
 * for interfaces. (Neo4j does not allow `:A&B` label expressions in a statement that also uses
 * `:A:B`, so interfaces are matched with predicates.)
 */
export function labelPredicate(variable: string, n: NodeType): string {
  if (!isInterface(n)) return `${variable}${labels(n.labels)}`;
  const sets = n.labelSets.map((set) => `${variable}${labels(set)}`);
  return sets.length === 1 ? sets[0]! : `(${sets.join(" OR ")})`;
}

/** The node pattern of a node of `n`: `(v:Movie)`, or `(v WHERE <label predicate>)` for an interface. */
export function nodePattern(variable: string, n: NodeType): string {
  if (!isInterface(n)) return `(${variable}${labels(n.labels)})`;
  return `(${variable} WHERE ${labelPredicate(variable, n)})`;
}

/**
 * `v.property`, or for an interface field stored under different properties by its
 * implementations, `CASE WHEN v:Lab THEN v.minutes … END`.
 */
export function property(variable: string, attr: Pick<Attribute, "property" | "variants">): string {
  if (!attr.variants) return `${variable}.${q(attr.property)}`;
  const whens = attr.variants.map(
    (v) => `WHEN ${variable}${labels(v.labels)} THEN ${variable}.${q(v.property)}`,
  );
  return `CASE ${whens.join(" ")} END`;
}

export type ListAggregate = "min" | "max" | "sum" | "avg";

/**
 * `min` / `max` / `sum` / `avg` of the list `l` as a plain expression. Aggregating functions cannot
 * be used inside a correlated `COLLECT { … }` of a projection (Neo4j reports implicit grouping keys),
 * so aggregates collect the values and reduce the list. Like the Cypher aggregates: `sum([])` is 0,
 * the others are `null`; `avg` is a Float (`toFloat(sum) / size`).
 */
export function listAggregate(fn: ListAggregate, l: string): string {
  const sum = `reduce(acc = 0, x IN ${l} | acc + x)`;
  switch (fn) {
    case "min":
      return `reduce(acc = null, x IN ${l} | CASE WHEN acc IS NULL OR x < acc THEN x ELSE acc END)`;
    case "max":
      return `reduce(acc = null, x IN ${l} | CASE WHEN acc IS NULL OR x > acc THEN x ELSE acc END)`;
    case "sum":
      return sum;
    case "avg":
      return `CASE size(${l}) WHEN 0 THEN null ELSE toFloat(${sum}) / size(${l}) END`;
  }
}

/** `[l IN [<list>] | <body(l)>][0]`: binds `list` once to use it in several expressions. */
export function withList(list: string, l: string, body: (l: string) => string): string {
  return `[${l} IN [${list}] | ${body(l)}][0]`;
}
