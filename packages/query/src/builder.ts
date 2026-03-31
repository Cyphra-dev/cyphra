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

/**
 * Variable-length quantifier for {@link rel} (Neo4j `[r:TYPE*]`, `[r:TYPE*2]`, `[r:TYPE*1..5]`, …).
 *
 * - **`"any"`** → **`*`** (default variable-length semantics in Neo4j).
 * - **Exact hop count** — non-negative integer, e.g. **`2`** → **`*2`**.
 * - **Range** — at least one of **`min`** / **`max`**: **`{ min: 1, max: 3 }`**, **`{ max: 5 }`** (`*..5`), **`{ min: 2 }`** (`*2..`).
 */
export type RelVarLength = "any" | number | { readonly min?: number; readonly max?: number };

/** Symbolic relationship variable (`[m:MEMBER_OF]` or `[m:KNOWS*1..3]`). */
export type RelRef = {
  readonly type: string;
  readonly alias: string;
  readonly varLength?: RelVarLength;
};

function validateRelVarLength(len: RelVarLength): void {
  if (len === "any") {
    return;
  }
  if (typeof len === "number") {
    if (!Number.isInteger(len) || len < 0) {
      throw new Error("rel(): varLength number must be a non-negative integer");
    }
    return;
  }
  const hasMin = len.min !== undefined;
  const hasMax = len.max !== undefined;
  if (!hasMin && !hasMax) {
    throw new Error("rel(): varLength range requires min and/or max");
  }
  if (hasMin) {
    const m = len.min!;
    if (!Number.isInteger(m) || m < 0) {
      throw new Error("rel(): varLength min must be a non-negative integer");
    }
  }
  if (hasMax) {
    const m = len.max!;
    if (!Number.isInteger(m) || m < 0) {
      throw new Error("rel(): varLength max must be a non-negative integer");
    }
  }
  if (hasMin && hasMax && len.min! > len.max!) {
    throw new Error("rel(): varLength min must be <= max");
  }
}

function formatRelVarLength(len: RelVarLength): string {
  if (len === "any") {
    return "*";
  }
  if (typeof len === "number") {
    return `*${len}`;
  }
  const { min, max } = len;
  if (min !== undefined && max !== undefined) {
    return `*${min}..${max}`;
  }
  if (min !== undefined) {
    return `*${min}..`;
  }
  return `*..${max!}`;
}

function relPatternInner(r: RelRef): string {
  const q = r.varLength !== undefined ? formatRelVarLength(r.varLength) : "";
  return `${r.alias}:${r.type}${q}`;
}

/**
 * Property or bare-variable reference for WHERE / RETURN / ORDER BY (`u.email`, or `n` via {@link bareVar}).
 */
export type PropRef = {
  readonly alias: string;
  /**
   * Property on `alias`. Use {@link bareVar} so `name` is empty and the expression is just `alias`
   * (e.g. list-comprehension item `x` in `x IN $list WHERE x > $p0`).
   */
  readonly name: string;
};

export function assertCypherIdentifier(name: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${label}: invalid identifier ${JSON.stringify(name)}`);
  }
}

/**
 * Create a node reference for patterns and projections.
 *
 * @param label - Neo4j label (e.g. `User`).
 * @param alias - Cypher variable name.
 */
export function node(label: string, alias: string): NodeRef {
  assertCypherIdentifier(label, "node(label)");
  assertCypherIdentifier(alias, "node(alias)");
  return {
    label,
    alias,
    out(r: RelRef, to: NodeRef): string {
      return `(${alias}:${label})-[${relPatternInner(r)}]->(${to.alias}:${to.label})`;
    },
    in(r: RelRef, from: NodeRef): string {
      return `(${alias}:${label})<-[${relPatternInner(r)}]-(${from.alias}:${from.label})`;
    },
    both(r: RelRef, other: NodeRef): string {
      return `(${alias}:${label})-[${relPatternInner(r)}]-(${other.alias}:${other.label})`;
    },
  };
}

/**
 * Create a relationship reference.
 *
 * @param type - Neo4j relationship type.
 * @param alias - Cypher variable name.
 * @param varLength - Optional variable-length quantifier; see {@link RelVarLength}.
 */
export function rel(type: string, alias: string, varLength?: RelVarLength): RelRef {
  assertCypherIdentifier(type, "rel(type)");
  assertCypherIdentifier(alias, "rel(alias)");
  if (varLength !== undefined) {
    validateRelVarLength(varLength);
  }
  return varLength === undefined ? { type, alias } : { type, alias, varLength };
}

/**
 * Reference a property on a node or relationship alias.
 *
 * @param alias - Cypher variable (`u`, `m`, …).
 * @param name - Property name (non-empty).
 */
export function prop(alias: string, name: string): PropRef {
  assertCypherIdentifier(alias, "prop(alias)");
  if (!name) {
    throw new Error(
      "prop(): property name must be non-empty; use bareVar(alias) for a bare variable",
    );
  }
  assertCypherIdentifier(name, "prop(name)");
  return { alias, name };
}

/** Bare Cypher variable for predicates (e.g. item in a list comprehension). */
export function bareVar(name: string): PropRef {
  assertCypherIdentifier(name, "bareVar");
  return { alias: name, name: "" };
}

function propExpr(p: PropRef): string {
  return p.name === "" ? p.alias : `${p.alias}.${p.name}`;
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
    case "between": {
      const kLo = sink.nextParam();
      const kHi = sink.nextParam();
      sink.params[kLo] = pred.low;
      sink.params[kHi] = pred.high;
      const pe = propExpr(pred.left);
      return `(${pe} >= $${kLo} AND ${pe} <= $${kHi})`;
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
    case "exists": {
      if (pred.inner.length === 0) {
        return `EXISTS { MATCH ${pred.matchPattern} }`;
      }
      const parts =
        pred.inner.length === 1
          ? [emitPredicate(pred.inner[0]!, sink)]
          : pred.inner.map((item) => emitUnderAnd(item, sink));
      return `EXISTS { MATCH ${pred.matchPattern} WHERE ${parts.join(" AND ")} }`;
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
  | {
      readonly kind: "between";
      readonly left: PropRef;
      readonly low: unknown;
      readonly high: unknown;
    }
  | { readonly kind: "isNull"; readonly left: PropRef }
  | { readonly kind: "isNotNull"; readonly left: PropRef }
  | { readonly kind: "in"; readonly left: PropRef; readonly values: readonly unknown[] }
  | { readonly kind: "startsWith"; readonly left: PropRef; readonly substring: string }
  | { readonly kind: "endsWith"; readonly left: PropRef; readonly substring: string }
  | { readonly kind: "contains"; readonly left: PropRef; readonly substring: string }
  | { readonly kind: "matches"; readonly left: PropRef; readonly pattern: string }
  | {
      readonly kind: "exists";
      /** Full `MATCH` pattern body (same rules as {@link SelectQuery.match}). */
      readonly matchPattern: string;
      /** Combined with `AND` inside the `EXISTS { … }` subquery. */
      readonly inner: readonly WherePredicate[];
    };

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

/**
 * `EXISTS { MATCH <matchPattern> [WHERE …] }` — Neo4j existential subquery (parameters shared with the outer query).
 *
 * @param matchPattern - Full pattern inside `MATCH` (e.g. `(p:Post)-[:LIKES]->(u:User)`).
 * @param where - Optional predicates, AND-combined inside the subquery.
 */
export function exists(matchPattern: string, ...where: WherePredicate[]): WherePredicate {
  const trimmed = matchPattern.trim();
  if (!trimmed) {
    throw new Error("exists(): matchPattern must be non-empty");
  }
  return { kind: "exists", matchPattern: trimmed, inner: where };
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

/**
 * Inclusive range: `(left >= $pN AND left <= $pM)` — both bounds are parameters.
 */
export function between(left: PropRef, low: unknown, high: unknown): WherePredicate {
  return { kind: "between", left, low, high };
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

/** `ORDER BY` on a property (parameter-friendly) or a trusted expression (e.g. aggregate alias). */
export type OrderByClause =
  | {
      readonly prop: PropRef;
      readonly direction: OrderDirection;
      /** Neo4j **`NULLS FIRST`** / **`NULLS LAST`** (optional). */
      readonly nulls?: "FIRST" | "LAST";
    }
  | {
      readonly expression: string;
      readonly direction: OrderDirection;
      readonly nulls?: "FIRST" | "LAST";
    };

function orderBySegment(c: OrderByClause): string {
  const sortKey = "expression" in c ? c.expression.trim() : propExpr(c.prop);
  if ("expression" in c && !sortKey) {
    throw new Error("SelectQuery.orderBy: expression must be non-empty");
  }
  const core = `${sortKey} ${c.direction}`;
  const n = c.nulls;
  if (n === undefined) {
    return core;
  }
  return `${core} NULLS ${n}`;
}

type Projection =
  | "star"
  | { readonly kind: "props"; readonly fields: Record<string, PropRef> }
  | { readonly kind: "raw"; readonly fields: Record<string, string> };

/**
 * `[USE …] MATCH … OPTIONAL MATCH … [WITH [DISTINCT] … ORDER BY … LIMIT …] WHERE … RETURN … ORDER BY … SKIP … LIMIT` builder
 * (Cypher remains explicit in `match()` / `optionalMatch()`).
 * Optional third argument on {@link rel} ({@link RelVarLength}) emits variable-length segments in {@link node} `out` / `in` / `both` patterns.
 * WHERE clauses are AND-combined; use {@link and} / {@link or} for explicit grouping.
 * Every bound value is a parameter except `IS NULL` / `IS NOT NULL`.
 */
export class SelectQuery {
  /** Optional **`USE graph[.subgraph]`** prefix (composite / multi-graph). */
  private useClause: string | null = null;
  private matchPattern = "";
  private optionalPatterns: string[] = [];
  /**
   * Optional `WITH [DISTINCT] vars [ORDER BY …] [LIMIT …]` after `OPTIONAL MATCH` and before `WHERE`.
   */
  private preWhereWith: {
    readonly variables: readonly string[];
    readonly distinct: boolean;
    readonly order: readonly OrderByClause[];
    readonly limit: number | null;
  } | null = null;
  private predicates: WherePredicate[] = [];
  private projection: Projection | null = null;
  private returnDistinctFlag = false;
  private order: OrderByClause[] = [];
  private skipCount: number | null = null;
  private limitCount: number | null = null;

  /**
   * Prefix the query with **`USE qualifiedGraphName`** (Neo4j composite database / graph selection).
   * `qualifiedGraphName` is a dotted path of Cypher identifiers (e.g. **`mycomposite.mygraph`**).
   */
  use(qualifiedGraphName: string): this {
    const q = qualifiedGraphName.trim();
    if (!q) {
      throw new Error("SelectQuery.use: qualifiedGraphName must be non-empty");
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(q)) {
      throw new Error(
        `SelectQuery.use: invalid qualified graph name ${JSON.stringify(qualifiedGraphName)}`,
      );
    }
    this.useClause = q;
    return this;
  }

  /**
   * @param pattern - Full `MATCH` pattern body (e.g. from {@link NodeRef.out}).
   */
  match(pattern: string): this {
    this.matchPattern = pattern;
    return this;
  }

  /**
   * Append `OPTIONAL MATCH` after the primary {@link match} (same pattern string rules: full clause body only).
   *
   * @throws If {@link match} was not called yet.
   */
  optionalMatch(pattern: string): this {
    if (!this.matchPattern) {
      throw new Error("SelectQuery: call match() before optionalMatch()");
    }
    this.optionalPatterns.push(pattern);
    return this;
  }

  /**
   * `WITH [DISTINCT] <vars> ORDER BY … LIMIT …` before `WHERE` — e.g. keep the **n** newest rows per an outer match, then filter.
   * Variable names must be plain Cypher identifiers (`[A-Za-z_][A-Za-z0-9_]*`).
   *
   * @param options.distinct — emit **`WITH DISTINCT`** (Cypher Manual `WITH DISTINCT`).
   */
  withOrderLimit(
    variables: readonly string[],
    order: readonly OrderByClause[],
    limit: number,
    options?: { readonly distinct?: boolean },
  ): this {
    if (variables.length === 0) {
      throw new Error("SelectQuery.withOrderLimit: at least one variable is required");
    }
    for (const v of variables) {
      assertCypherIdentifier(v, "SelectQuery.withOrderLimit(variable)");
    }
    if (order.length === 0) {
      throw new Error("SelectQuery.withOrderLimit: at least one ORDER BY clause is required");
    }
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("SelectQuery.withOrderLimit: limit must be a positive integer");
    }
    this.preWhereWith = {
      variables,
      distinct: options?.distinct === true,
      order,
      limit,
    };
    return this;
  }

  /**
   * `WITH DISTINCT <vars>` before `WHERE` (no `ORDER BY` / `LIMIT` on this clause).
   */
  withDistinct(variables: readonly string[]): this {
    if (variables.length === 0) {
      throw new Error("SelectQuery.withDistinct: at least one variable is required");
    }
    for (const v of variables) {
      assertCypherIdentifier(v, "SelectQuery.withDistinct(variable)");
    }
    this.preWhereWith = { variables, distinct: true, order: [], limit: null };
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
    for (const outAlias of Object.keys(fields)) {
      assertCypherIdentifier(outAlias, "SelectQuery.returnFields(alias)");
    }
    this.projection = { kind: "props", fields };
    return this;
  }

  /**
   * `RETURN …` with **trusted Cypher expressions** per alias (aggregates, literals, `count(*)`, …).
   * Use {@link returnFields} when every column is a simple {@link prop} / {@link bareVar}.
   */
  returnRawFields(fields: Record<string, string>): this {
    const entries = Object.entries(fields);
    if (entries.length === 0) {
      throw new Error("SelectQuery.returnRawFields: at least one field is required");
    }
    for (const [alias, expr] of entries) {
      assertCypherIdentifier(alias, "SelectQuery.returnRawFields(alias)");
      if (!expr.trim()) {
        throw new Error(
          `SelectQuery.returnRawFields: empty expression for alias ${JSON.stringify(alias)}`,
        );
      }
    }
    this.projection = { kind: "raw", fields };
    return this;
  }

  /** `RETURN *` (mutually exclusive with {@link returnFields} — last call wins). */
  returnStar(): this {
    this.projection = "star";
    return this;
  }

  /**
   * `RETURN DISTINCT …` — may be called before or after {@link returnFields} / {@link returnStar} / {@link returnRawFields}
   * (projection must still be set before {@link toCypher}).
   */
  returnDistinct(): this {
    this.returnDistinctFlag = true;
    return this;
  }

  /**
   * Append `ORDER BY` clauses (direction and optional **`NULLS FIRST`/`LAST`** are whitelisted).
   *
   * @param clauses - Property + ASC/DESC (+ optional `nulls`) pairs.
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
      throw new Error(
        "SelectQuery: call returnFields(), returnRawFields(), or returnStar() before toCypher()",
      );
    }
    const params: Record<string, unknown> = {};
    let p = 0;
    const nextParam = (): string => {
      const key = `p${p++}`;
      return key;
    };
    const sink: ParamSink = { params, nextParam };

    const useKw = this.useClause !== null ? `USE ${this.useClause} ` : "";
    let text = `${useKw}MATCH ${this.matchPattern}`;
    for (const opt of this.optionalPatterns) {
      text += ` OPTIONAL MATCH ${opt}`;
    }
    if (this.preWhereWith !== null) {
      const w = this.preWhereWith;
      const dist = w.distinct ? "DISTINCT " : "";
      const vars = w.variables.join(", ");
      if (w.order.length > 0) {
        const ob = w.order.map(orderBySegment).join(", ");
        if (w.limit !== null) {
          const limitKey = nextParam();
          params[limitKey] = w.limit;
          text += ` WITH ${dist}${vars} ORDER BY ${ob} LIMIT toInteger($${limitKey})`;
        } else {
          text += ` WITH ${dist}${vars} ORDER BY ${ob}`;
        }
      } else if (w.limit !== null) {
        const limitKey = nextParam();
        params[limitKey] = w.limit;
        text += ` WITH ${dist}${vars} LIMIT toInteger($${limitKey})`;
      } else {
        text += ` WITH ${dist}${vars}`;
      }
    }
    if (this.predicates.length > 0) {
      // Multiple where() args are AND-combined; a bare OR at this level must stay grouped (Cypher: AND > OR).
      const parts =
        this.predicates.length === 1
          ? [emitPredicate(this.predicates[0]!, sink)]
          : this.predicates.map((pred) => emitUnderAnd(pred, sink));
      text += ` WHERE ${parts.join(" AND ")}`;
    }
    const distinctKw = this.returnDistinctFlag ? "DISTINCT " : "";
    if (this.projection === "star") {
      text += ` RETURN ${distinctKw}*`;
    } else if (this.projection.kind === "props") {
      const ret = Object.entries(this.projection.fields)
        .map(([out, pr]) => `${propExpr(pr)} AS ${out}`)
        .join(", ");
      text += ` RETURN ${distinctKw}${ret}`;
    } else {
      const ret = Object.entries(this.projection.fields)
        .map(([out, expr]) => `${expr.trim()} AS ${out}`)
        .join(", ");
      text += ` RETURN ${distinctKw}${ret}`;
    }
    if (this.order.length > 0) {
      const ob = this.order.map(orderBySegment).join(", ");
      text += ` ORDER BY ${ob}`;
    }
    // Neo4j 5 + GQL: SKIP/LIMIT expect INTEGER; Bolt often maps JS numbers as floats. `toInteger($p)` fixes at runtime.
    if (this.skipCount !== null) {
      const key = nextParam();
      params[key] = this.skipCount;
      text += ` SKIP toInteger($${key})`;
    }
    if (this.limitCount !== null) {
      const key = nextParam();
      params[key] = this.limitCount;
      text += ` LIMIT toInteger($${key})`;
    }
    return { text, params };
  }
}

/** Start a fluent `MATCH` query. */
export function select(): SelectQuery {
  return new SelectQuery();
}

/**
 * Build a `WHERE …` fragment (without the keyword) and parameters from predicates
 * (same rules as {@link SelectQuery.where}).
 */
export function compileWhereFragment(predicates: WherePredicate[]): CompiledCypher {
  if (predicates.length === 0) {
    return { text: "", params: {} };
  }
  const params: Record<string, unknown> = {};
  let p = 0;
  const nextParam = (): string => {
    const key = `p${p++}`;
    return key;
  };
  const sink: ParamSink = { params, nextParam };
  const parts =
    predicates.length === 1
      ? [emitPredicate(predicates[0]!, sink)]
      : predicates.map((pred) => emitUnderAnd(pred, sink));
  return { text: parts.join(" AND "), params };
}
