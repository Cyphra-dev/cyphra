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

/** Predicate combined with AND in {@link SelectQuery.where}. */
export type WherePredicate =
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
  | { readonly kind: "contains"; readonly left: PropRef; readonly substring: string };

/** Equality branch of {@link WherePredicate}. */
export type EqPredicate = Extract<WherePredicate, { kind: "eq" }>;

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

export type OrderDirection = "ASC" | "DESC";

export type OrderByClause = {
  readonly prop: PropRef;
  readonly direction: OrderDirection;
};

/**
 * `MATCH … WHERE … RETURN … ORDER BY … SKIP … LIMIT` builder (Cypher remains explicit in `match()`).
 * WHERE clauses are AND-combined; every value is a parameter except `IS NULL` / `IS NOT NULL`.
 */
export class SelectQuery {
  private matchPattern = "";
  private predicates: WherePredicate[] = [];
  private projection: Record<string, PropRef> | null = null;
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
    const params: Record<string, unknown> = {};
    let p = 0;
    const nextParam = (): string => {
      const key = `p${p++}`;
      return key;
    };

    let text = `MATCH ${this.matchPattern}`;
    if (this.predicates.length > 0) {
      const parts: string[] = [];
      for (const pred of this.predicates) {
        const ref = propExpr(pred.left);
        switch (pred.kind) {
          case "eq": {
            const k = nextParam();
            params[k] = pred.right;
            parts.push(`${ref} = $${k}`);
            break;
          }
          case "neq": {
            const k = nextParam();
            params[k] = pred.right;
            parts.push(`${ref} <> $${k}`);
            break;
          }
          case "gt": {
            const k = nextParam();
            params[k] = pred.right;
            parts.push(`${ref} > $${k}`);
            break;
          }
          case "gte": {
            const k = nextParam();
            params[k] = pred.right;
            parts.push(`${ref} >= $${k}`);
            break;
          }
          case "lt": {
            const k = nextParam();
            params[k] = pred.right;
            parts.push(`${ref} < $${k}`);
            break;
          }
          case "lte": {
            const k = nextParam();
            params[k] = pred.right;
            parts.push(`${ref} <= $${k}`);
            break;
          }
          case "isNull":
            parts.push(`${ref} IS NULL`);
            break;
          case "isNotNull":
            parts.push(`${ref} IS NOT NULL`);
            break;
          case "in": {
            const k = nextParam();
            params[k] = [...pred.values];
            parts.push(`${ref} IN $${k}`);
            break;
          }
          case "startsWith": {
            const k = nextParam();
            params[k] = pred.substring;
            parts.push(`${ref} STARTS WITH $${k}`);
            break;
          }
          case "endsWith": {
            const k = nextParam();
            params[k] = pred.substring;
            parts.push(`${ref} ENDS WITH $${k}`);
            break;
          }
          case "contains": {
            const k = nextParam();
            params[k] = pred.substring;
            parts.push(`${ref} CONTAINS $${k}`);
            break;
          }
          default: {
            const _exhaustive: never = pred;
            throw new Error(`Unhandled predicate: ${JSON.stringify(_exhaustive)}`);
          }
        }
      }
      text += ` WHERE ${parts.join(" AND ")}`;
    }
    if (this.projection) {
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
