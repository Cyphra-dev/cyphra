import type { CompiledCypher } from "./cypher.js";

/** Symbolic node variable in a pattern (`(u:User)`). */
export type NodeRef = {
  readonly label: string;
  readonly alias: string;
  /**
   * Outgoing relationship pattern fragment: `(u)-[m:REL]->(o)`.
   *
   * @param r - Relationship reference.
   * @param to - Target node.
   */
  out(r: RelRef, to: NodeRef): string;
  /**
   * Incoming relationship pattern: `(o)<-[m:REL]-(u)`.
   *
   * @param r - Relationship reference.
   * @param from - Source node (the “other” end of the arrow).
   */
  in(r: RelRef, from: NodeRef): string;
  /**
   * Undirected pattern: `(a)-[r:T]-(b)` (both ends symmetric).
   *
   * @param r - Relationship reference.
   * @param other - The other node in the undirected segment.
   */
  both(r: RelRef, other: NodeRef): string;
};

/** Symbolic relationship variable (`[m:MEMBER_OF]`). */
export type RelRef = {
  readonly type: string;
  readonly alias: string;
};

/** Property reference for WHERE / RETURN / ORDER BY (`u.email`, `m.role`). */
export type PropRef = {
  readonly alias: string;
  readonly name: string;
};

/**
 * Create a node reference for patterns and projections.
 *
 * @param label - Neo4j label (e.g. `User`).
 * @param alias - Cypher variable name.
 */
export function node(label: string, alias: string): NodeRef {
  return {
    label,
    alias,
    out(r: RelRef, to: NodeRef): string {
      return `(${alias}:${label})-[${r.alias}:${r.type}]->(${to.alias}:${to.label})`;
    },
    in(r: RelRef, from: NodeRef): string {
      return `(${alias}:${label})<-[${r.alias}:${r.type}]-(${from.alias}:${from.label})`;
    },
    both(r: RelRef, other: NodeRef): string {
      return `(${alias}:${label})-[${r.alias}:${r.type}]-(${other.alias}:${other.label})`;
    },
  };
}

/**
 * Create a relationship reference.
 *
 * @param type - Neo4j relationship type.
 * @param alias - Cypher variable name.
 */
export function rel(type: string, alias: string): RelRef {
  return { type, alias };
}

/**
 * Reference a property on a node or relationship alias.
 *
 * @param alias - Cypher variable (`u`, `m`, …).
 * @param name - Property name.
 */
export function prop(alias: string, name: string): PropRef {
  return { alias, name };
}

function propExpr(p: PropRef): string {
  return `${p.alias}.${p.name}`;
}

type ParamSink = {
  readonly params: Record<string, unknown>;
  readonly nextParam: () => string;
};

/** Under AND: OR children need parentheses (OR has lower precedence than AND in Cypher). */
function emitUnderAnd(pred: WherePredicate, sink: ParamSink): string {
  if (pred.kind === "or") {
    return `(${emitPredicate(pred, sink)})`;
  }
  return emitPredicate(pred, sink);
}

/** Under OR: AND children need parentheses. */
function emitUnderOr(pred: WherePredicate, sink: ParamSink): string {
  if (pred.kind === "and") {
    return `(${emitPredicate(pred, sink)})`;
  }
  return emitPredicate(pred, sink);
}

/** Emit one WHERE fragment; mutates `sink.params` for bound values. */
function emitPredicate(pred: WherePredicate, sink: ParamSink): string {
  switch (pred.kind) {
    case "and": {
      if (pred.items.length === 0) {
        throw new Error("and(): at least one predicate is required");
      }
      if (pred.items.length === 1) {
        return emitPredicate(pred.items[0]!, sink);
      }
      return pred.items.map((item) => emitUnderAnd(item, sink)).join(" AND ");
    }
    case "or": {
      if (pred.items.length === 0) {
        throw new Error("or(): at least one predicate is required");
      }
      if (pred.items.length === 1) {
        return emitPredicate(pred.items[0]!, sink);
      }
      return pred.items.map((item) => emitUnderOr(item, sink)).join(" OR ");
    }
    case "not":
      return `NOT (${emitPredicate(pred.inner, sink)})`;
    case "eq": {
      const k = sink.nextParam();
      sink.params[k] = pred.right;
      return `${propExpr(pred.left)} = $${k}`;
    }
    case "neq": {
      const k = sink.nextParam();
      sink.params[k] = pred.right;
      return `${propExpr(pred.left)} <> $${k}`;
    }
    case "gt": {
      const k = sink.nextParam();
      sink.params[k] = pred.right;
      return `${propExpr(pred.left)} > $${k}`;
    }
    case "gte": {
      const k = sink.nextParam();
      sink.params[k] = pred.right;
      return `${propExpr(pred.left)} >= $${k}`;
    }
    case "lt": {
      const k = sink.nextParam();
      sink.params[k] = pred.right;
      return `${propExpr(pred.left)} < $${k}`;
    }
    case "lte": {
      const k = sink.nextParam();
      sink.params[k] = pred.right;
      return `${propExpr(pred.left)} <= $${k}`;
    }
    case "isNull":
      return `${propExpr(pred.left)} IS NULL`;
    case "isNotNull":
      return `${propExpr(pred.left)} IS NOT NULL`;
    case "in": {
      const k = sink.nextParam();
      sink.params[k] = [...pred.values];
      return `${propExpr(pred.left)} IN $${k}`;
    }
    case "startsWith": {
      const k = sink.nextParam();
      sink.params[k] = pred.substring;
      return `${propExpr(pred.left)} STARTS WITH $${k}`;
    }
    case "endsWith": {
      const k = sink.nextParam();
      sink.params[k] = pred.substring;
      return `${propExpr(pred.left)} ENDS WITH $${k}`;
    }
    case "contains": {
      const k = sink.nextParam();
      sink.params[k] = pred.substring;
      return `${propExpr(pred.left)} CONTAINS $${k}`;
    }
    case "matches": {
      const k = sink.nextParam();
      sink.params[k] = pred.pattern;
      return `${propExpr(pred.left)} =~ $${k}`;
    }
    default: {
      const _exhaustive: never = pred;
      throw new Error(`Unhandled predicate: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Predicate combined with AND in {@link SelectQuery.where}. */
export type WherePredicate =
  | { readonly kind: "and"; readonly items: readonly WherePredicate[] }
  | { readonly kind: "or"; readonly items: readonly WherePredicate[] }
  | { readonly kind: "not"; readonly inner: WherePredicate }
  | { readonly kind: "eq"; readonly left: PropRef; readonly right: unknown }
  | { readonly kind: "neq"; readonly left: PropRef; readonly right: unknown }
  | { readonly kind: "gt"; readonly left: PropRef; readonly right: unknown }
  | { readonly kind: "gte"; readonly left: PropRef; readonly right: unknown }
  | { readonly kind: "lt"; readonly left: PropRef; readonly right: unknown }
  | { readonly kind: "lte"; readonly left: PropRef; readonly right: unknown }
  | { readonly kind: "isNull"; readonly left: PropRef }
  | { readonly kind: "isNotNull"; readonly left: PropRef }
  | { readonly kind: "in"; readonly left: PropRef; readonly values: readonly unknown[] }
  | { readonly kind: "startsWith"; readonly left: PropRef; readonly substring: string }
  | { readonly kind: "endsWith"; readonly left: PropRef; readonly substring: string }
  | { readonly kind: "contains"; readonly left: PropRef; readonly substring: string }
  | { readonly kind: "matches"; readonly left: PropRef; readonly pattern: string };

/** Equality branch of {@link WherePredicate}. */
export type EqPredicate = Extract<WherePredicate, { kind: "eq" }>;

/**
 * `(p0 AND p1 AND …)` — use with {@link or} for grouped conditions.
 * Top-level {@link SelectQuery.where} arguments are already AND-combined.
 */
export function and(...items: WherePredicate[]): WherePredicate {
  if (items.length === 0) {
    throw new Error("and(): at least one predicate is required");
  }
  return { kind: "and", items };
}

/**
 * `(p0 OR p1 OR …)` — Cypher precedence: AND binds tighter than OR; children are parenthesized when needed.
 */
export function or(...items: WherePredicate[]): WherePredicate {
  if (items.length === 0) {
    throw new Error("or(): at least one predicate is required");
  }
  return { kind: "or", items };
}

/** `NOT (inner …)` — `inner` uses the same parameter rules as top-level predicates. */
export function not(inner: WherePredicate): WherePredicate {
  return { kind: "not", inner };
}

/** `left = $pN` */
export function eq(left: PropRef, right: unknown): WherePredicate {
  return { kind: "eq", left, right };
}

/** `left <> $pN` */
export function neq(left: PropRef, right: unknown): WherePredicate {
  return { kind: "neq", left, right };
}

/** `left > $pN` */
export function gt(left: PropRef, right: unknown): WherePredicate {
  return { kind: "gt", left, right };
}

/** `left >= $pN` */
export function gte(left: PropRef, right: unknown): WherePredicate {
  return { kind: "gte", left, right };
}

/** `left < $pN` */
export function lt(left: PropRef, right: unknown): WherePredicate {
  return { kind: "lt", left, right };
}

/** `left <= $pN` */
export function lte(left: PropRef, right: unknown): WherePredicate {
  return { kind: "lte", left, right };
}

/** `left IS NULL` */
export function isNull(left: PropRef): WherePredicate {
  return { kind: "isNull", left };
}

/** `left IS NOT NULL` */
export function isNotNull(left: PropRef): WherePredicate {
  return { kind: "isNotNull", left };
}

/**
 * `left IN $pN` — list is passed as a single parameter (never concatenated into Cypher).
 *
 * @throws If `values` is empty (use other predicates; `IN []` is always false in Cypher).
 */
export function inList(left: PropRef, values: readonly unknown[]): WherePredicate {
  if (values.length === 0) {
    throw new Error("inList: empty list is not supported; use explicit false or omit the clause");
  }
  return { kind: "in", left, values };
}

/** `left STARTS WITH $pN` */
export function startsWith(left: PropRef, substring: string): WherePredicate {
  return { kind: "startsWith", left, substring };
}

/** `left ENDS WITH $pN` */
export function endsWith(left: PropRef, substring: string): WherePredicate {
  return { kind: "endsWith", left, substring };
}

/** `left CONTAINS $pN` */
export function contains(left: PropRef, substring: string): WherePredicate {
  return { kind: "contains", left, substring };
}

/**
 * `left =~ $pN` — regular-expression match; the pattern is always a bound parameter.
 * Neo4j uses Java-compatible regex (see Cypher manual).
 */
export function matches(left: PropRef, pattern: string): WherePredicate {
  return { kind: "matches", left, pattern };
}

export type OrderDirection = "ASC" | "DESC";

export type OrderByClause = {
  readonly prop: PropRef;
  readonly direction: OrderDirection;
};

type Projection = "star" | Record<string, PropRef>;

/**
 * `MATCH … WHERE … RETURN … ORDER BY … SKIP … LIMIT` builder (Cypher remains explicit in `match()`).
 * WHERE clauses are AND-combined; use {@link and} / {@link or} for explicit grouping.
 * Every bound value is a parameter except `IS NULL` / `IS NOT NULL`.
 */
export class SelectQuery {
  private matchPattern = "";
  private predicates: WherePredicate[] = [];
  private projection: Projection | null = null;
  private order: OrderByClause[] = [];
  private skipCount: number | null = null;
  private limitCount: number | null = null;

  /**
   * @param pattern - Full `MATCH` pattern body (e.g. from {@link NodeRef.out}).
   */
  match(pattern: string): this {
    this.matchPattern = pattern;
    return this;
  }

  /**
   * AND-combine predicates. When you pass more than one argument, any root-level {@link or}
   * is parenthesized so it is not parsed as `a OR (b AND c)`.
   */
  where(...preds: WherePredicate[]): this {
    this.predicates.push(...preds);
    return this;
  }

  /**
   * @param fields - Map of output alias → property reference.
   */
  returnFields(fields: Record<string, PropRef>): this {
    this.projection = fields;
    return this;
  }

  /** `RETURN *` (mutually exclusive with {@link returnFields} — last call wins). */
  returnStar(): this {
    this.projection = "star";
    return this;
  }

  /**
   * Append `ORDER BY` clauses (direction is whitelisted, never from user strings).
   *
   * @param clauses - Property + ASC/DESC pairs.
   */
  orderBy(...clauses: OrderByClause[]): this {
    this.order.push(...clauses);
    return this;
  }

  /**
   * `SKIP` with a bound parameter.
   *
   * @param n - Number of rows to skip.
   */
  skip(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error("SelectQuery.skip: n must be a non-negative integer");
    }
    this.skipCount = n;
    return this;
  }

  /**
   * `LIMIT` with a bound parameter.
   *
   * @param n - Maximum rows.
   */
  limit(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error("SelectQuery.limit: n must be a non-negative integer");
    }
    this.limitCount = n;
    return this;
  }

  /** Generated Cypher and parameters (for debugging or execution). */
  toCypher(): CompiledCypher {
    if (!this.matchPattern) {
      throw new Error("SelectQuery: call match() before toCypher()");
    }
    if (this.projection === null) {
      throw new Error("SelectQuery: call returnFields() or returnStar() before toCypher()");
    }
    const params: Record<string, unknown> = {};
    let p = 0;
    const nextParam = (): string => {
      const key = `p${p++}`;
      return key;
    };
    const sink: ParamSink = { params, nextParam };

    let text = `MATCH ${this.matchPattern}`;
    if (this.predicates.length > 0) {
      // Multiple where() args are AND-combined; a bare OR at this level must stay grouped (Cypher: AND > OR).
      const parts =
        this.predicates.length === 1
          ? [emitPredicate(this.predicates[0]!, sink)]
          : this.predicates.map((pred) => emitUnderAnd(pred, sink));
      text += ` WHERE ${parts.join(" AND ")}`;
    }
    if (this.projection === "star") {
      text += " RETURN *";
    } else {
      const ret = Object.entries(this.projection)
        .map(([out, pr]) => `${pr.alias}.${pr.name} AS ${out}`)
        .join(", ");
      text += ` RETURN ${ret}`;
    }
    if (this.order.length > 0) {
      const ob = this.order.map((c) => `${c.prop.alias}.${c.prop.name} ${c.direction}`).join(", ");
      text += ` ORDER BY ${ob}`;
    }
    if (this.skipCount !== null) {
      const key = nextParam();
      params[key] = this.skipCount;
      text += ` SKIP $${key}`;
    }
    if (this.limitCount !== null) {
      const key = nextParam();
      params[key] = this.limitCount;
      text += ` LIMIT $${key}`;
    }
    return { text, params };
  }
}

/** Start a fluent `MATCH` query. */
export function select(): SelectQuery {
  return new SelectQuery();
}
