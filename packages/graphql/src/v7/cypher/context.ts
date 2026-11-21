/** Parameters and fresh variable names for one Cypher statement. */
export class CypherContext {
  readonly params: Record<string, unknown> = {};
  private paramCount = 0;
  private varCount = 0;

  /** Bind a value and return its `$placeholder`. */
  param(value: unknown): string {
    const key = `p${this.paramCount++}`;
    this.params[key] = value;
    return `$${key}`;
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
