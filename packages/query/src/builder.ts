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
};

/** Symbolic relationship variable (`[m:MEMBER_OF]`). */
export type RelRef = {
  readonly type: string;
  readonly alias: string;
};

/** Property reference for WHERE / RETURN (`u.email`, `m.role`). */
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

/**
 * Minimal `MATCH … WHERE … RETURN` builder (Cypher remains explicit in `match()`).
 */
export class SelectQuery {
  private matchPattern = "";
  private predicates: EqPredicate[] = [];
  private projection: Record<string, PropRef> | null = null;

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

  /** Generated Cypher and parameters (for debugging or execution). */
  toCypher(): CompiledCypher {
    if (!this.matchPattern) {
      throw new Error("SelectQuery: call match() before toCypher()");
    }
    const params: Record<string, unknown> = {};
    let text = `MATCH ${this.matchPattern}`;
    if (this.predicates.length > 0) {
      const parts: string[] = [];
      this.predicates.forEach((p, i) => {
        const key = `p${i}`;
        params[key] = p.right;
        parts.push(`${p.left.alias}.${p.left.name} = $${key}`);
      });
      text += ` WHERE ${parts.join(" AND ")}`;
    }
    if (this.projection) {
      const ret = Object.entries(this.projection)
        .map(([out, pr]) => `${pr.alias}.${pr.name} AS ${out}`)
        .join(", ");
      text += ` RETURN ${ret}`;
    }
    return { text, params };
  }
}

/** Start a fluent `MATCH` query. */
export function select(): SelectQuery {
  return new SelectQuery();
}
