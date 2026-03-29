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

/** Equality predicate for the fluent builder (right-hand side is parameterized). */
export type EqPredicate = {
  readonly kind: "eq";
  readonly left: PropRef;
  readonly right: unknown;
};

/**
 * `left = $pN` with `right` bound as a parameter.
 *
 * @param left - Property reference.
 * @param right - Value (bound, not interpolated into Cypher text).
 */
export function eq(left: PropRef, right: unknown): EqPredicate {
  return { kind: "eq", left, right };
}

export type OrderDirection = "ASC" | "DESC";

export type OrderByClause = {
  readonly prop: PropRef;
  readonly direction: OrderDirection;
};

/**
 * Minimal `MATCH … WHERE … RETURN … ORDER BY … SKIP … LIMIT` builder (Cypher remains explicit in `match()`).
 */
export class SelectQuery {
  private matchPattern = "";
  private predicates: EqPredicate[] = [];
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

  where(...preds: EqPredicate[]): this {
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
        const key = nextParam();
        params[key] = pred.right;
        parts.push(`${pred.left.alias}.${pred.left.name} = $${key}`);
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
