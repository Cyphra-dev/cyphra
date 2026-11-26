/**
 * Translates v7 `where` inputs into the engine's `where`, with the semantics of the compat
 * compiler's `WhereCompiler` (which follows `@neo4j/graphql` 7.6), so that both compile to the same
 * predicates:
 *
 * - keys of one object, `AND` / `OR` / `NOT` combine like v7: a part that filters nothing is left
 *   out, an `OR` with a member that filters nothing filters nothing;
 * - `{ eq: null }` matches a missing property, any other operator with `null` filters nothing;
 * - `some` / `none` / `all` / `single` with a filter that filters nothing are left out (v7 ignores
 *   `{}`); `all` requires at least one related node (`some: {}` plus `every`); `single` is a
 *   `_count` of the matching related nodes equal to 1;
 * - to-one relationships: `null` matches nodes without one, `{}` filters nothing, a filter matches
 *   when the related node exists and matches.
 *
 * What it cannot translate exactly throws {@link Fallback}: the compat compiler then runs the
 * request (aggregation filters, edge filters, `@cypher` fields, relationships to
 * interfaces and unions, DateTime values, …).
 *
 * @packageDocumentation
 */

import neo4j from "neo4j-driver";
import { AuthValue } from "../cypher/where.js";
import type { Attribute, NodeType, Relationship, V7Model } from "../model.js";
import type { EngineNode, EngineSchema } from "./schema.js";

type AnyRecord = Record<string, unknown>;

/** Thrown while translating a request the engine cannot serve exactly like the compat compiler. */
export class Fallback extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "Fallback";
  }
}

/** A plain (or null-prototype, from `valueFromASTUntyped`) object. */
export function isPlainObject(v: unknown): v is AnyRecord {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** `true` for an object, `false` for `null` / `undefined`; anything else is the compiler's error. */
function isFilterObject(where: unknown): where is AnyRecord {
  if (where === null || where === undefined) return false;
  if (!isPlainObject(where)) throw new Fallback("invalid filter");
  return true;
}

/**
 * A filter that matches every node but, unlike a filter that filters nothing, counts as a
 * condition (the compat compiler's `true`: an `OR` with a member that filters nothing). A
 * relationship quantifier keeps it (`some` of it requires a related node), `NOT` of it matches
 * nothing.
 */
export const TRUE: unique symbol = Symbol("v7.true");

/** A translated filter: engine `where`, {@link TRUE}, or `undefined` (filters nothing). */
export type Filter = AnyRecord | typeof TRUE | undefined;

/** The engine `where` that matches nothing. */
const FALSE: AnyRecord = { OR: [] };

/** The parts combined with `AND` (`undefined` without parts; `TRUE` parts change nothing). */
export function allOf(parts: readonly Filter[]): Filter {
  const defined = parts.filter((p) => p !== undefined);
  if (defined.length === 0) return undefined;
  const records = defined.filter((p): p is AnyRecord => p !== TRUE);
  if (records.length === 0) return TRUE;
  return records.length === 1 ? records[0] : { AND: records };
}

/** The engine `where` of a filter at a place that takes one (`TRUE`: no condition). */
export function rootWhere(filter: Filter): AnyRecord | undefined {
  return filter === TRUE ? undefined : filter;
}

/** The engine `where` of a filter that is a condition (`TRUE`: `{}`, which the engine reads as "any"). */
function condition(filter: AnyRecord | typeof TRUE): AnyRecord {
  return filter === TRUE ? {} : filter;
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

const QUANTIFIERS: Record<string, string> = {
  ALL: "all",
  NONE: "none",
  SINGLE: "single",
  SOME: "some",
};

/** Engine scalar operators of the v7 ones (on a non-list attribute). */
const SCALAR_OPERATORS: Record<string, string> = {
  eq: "equals",
  in: "in",
  contains: "contains",
  startsWith: "startsWith",
  endsWith: "endsWith",
  lt: "lt",
  lte: "lte",
  gt: "gt",
  gte: "gte",
};

/**
 * Whether `@authentication` could fail a request on the node (it stays on the compat compiler,
 * which checks it while compiling the statement).
 */
export function hasAuthentication(model: V7Model, node: NodeType): boolean {
  return (
    model.authentication !== undefined ||
    node.auth.authentication !== undefined ||
    node.attributes.some((a) => a.auth?.authentication)
  );
}

/**
 * One value of a filter, as the engine encodes the attribute's type to the same driver value the
 * compat compiler passes. Types whose encoding differs (DateTime: the compiler keeps the text's
 * offset and precision) throw {@link Fallback}.
 */
export function engineValue(attr: Attribute, value: unknown): unknown {
  const one = (v: unknown): unknown => {
    switch (attr.kind === "enum" ? "String" : attr.type.name) {
      case "ID":
      case "String":
        if (typeof v === "string") return v;
        break;
      case "Int":
        if (typeof v === "number" && Number.isSafeInteger(v)) return v;
        break;
      case "Float":
        if (typeof v === "number" && Number.isFinite(v)) return v;
        break;
      case "Boolean":
        if (typeof v === "boolean") return v;
        break;
      case "BigInt":
        if (neo4j.isInt(v)) return BigInt(v.toString());
        break;
      case "Date":
        // The compiler passes the parsed `Date`; the engine builds the same date from its text.
        if (neo4j.isDate(v as object)) return String(v);
        break;
    }
    throw new Fallback(`${attr.type.name} filter value`);
  };
  return Array.isArray(value) ? value.map(one) : one(value);
}

/** Translates the `where` inputs of one request. */
export class WhereTranslator {
  constructor(
    private readonly model: V7Model,
    private readonly schema: EngineSchema,
    /**
     * Translates the `node` part of `@authorization` rules (the compiler's rules mode): `$jwt` /
     * `$context` references, to-one filters that filter nothing are left out.
     */
    private readonly authorization = false,
  ) {}

  /**
   * The engine node of a v7 node type, or {@link Fallback} (interfaces, `@authentication`). Its
   * `@authorization` rules are the callers' (they apply where they read or write its nodes).
   */
  engineNode(node: NodeType): EngineNode {
    const n = this.schema.nodes.get(node.name);
    if (!n || n.v7 !== node) throw new Fallback(`${node.name} is not in the engine`);
    if (hasAuthentication(this.model, node)) throw new Fallback(`${node.name} has @authentication`);
    return n;
  }

  /** The engine relation of a relationship to a plain node type, or {@link Fallback}. */
  relation(node: NodeType, rel: Relationship): { name: string; target: NodeType } {
    const name = this.engineNode(node).relations.get(rel.name);
    if (!name || rel.union !== undefined || rel.interfaceTarget !== undefined) {
      throw new Fallback(`${node.name}.${rel.name} is not in the engine`);
    }
    const target = this.model.node(rel.target);
    this.engineNode(target);
    return { name, target };
  }

  /** `${Node}Where` → engine filter, `undefined` when it filters nothing. */
  node(node: NodeType, where: unknown): Filter {
    const engine = this.engineNode(node);
    if (!isFilterObject(where)) return undefined;
    const parts: Filter[] = [];
    const push = (p: Filter) => {
      if (p !== undefined) parts.push(p);
    };
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      const l = this.logical(key, value, (w) => this.node(node, w));
      if (l.handled) {
        push(l.where);
        continue;
      }
      const a = this.attribute(engine, node.attributes, key, value);
      if (a.handled) {
        push(a.where);
        continue;
      }
      if (node.cypherNodes.some((c) => key === c.name || key.startsWith(`${c.name}_`))) {
        throw new Fallback("@cypher filter");
      }
      push(this.relationship(node, key, value));
    }
    return allOf(parts);
  }

  /** `AND` / `OR` / `NOT`, combined like the compat compiler's `logical`. */
  private logical(
    key: string,
    value: unknown,
    compile: (w: AnyRecord) => Filter,
  ): { handled: boolean; where?: Filter } {
    if (key === "AND" || key === "OR") {
      if (value === null) return { handled: true };
      const members = (Array.isArray(value) ? value : [value]).filter(
        (w) => w !== null && w !== undefined,
      );
      const compiled = members.map((w) => {
        if (!isPlainObject(w)) throw new Fallback("invalid filter");
        return compile(w);
      });
      if (key === "AND") return { handled: true, where: allOf(compiled) };
      // An OR with no member filters nothing; one with a member that filters nothing is `true`.
      if (compiled.length === 0) return { handled: true };
      if (compiled.some((w) => w === undefined || w === TRUE))
        return { handled: true, where: TRUE };
      return {
        handled: true,
        where: compiled.length === 1 ? compiled[0] : { OR: compiled as AnyRecord[] },
      };
    }
    if (key === "NOT") {
      if (!isFilterObject(value)) return { handled: true };
      const inner = compile(value);
      if (inner === undefined) return { handled: true };
      return { handled: true, where: inner === TRUE ? FALSE : { NOT: inner } };
    }
    return { handled: false };
  }

  /** A filter on an attribute (`title: { eq }`, or the deprecated `title_EQ`). */
  private attribute(
    engine: Pick<EngineNode, "fields">,
    attributes: readonly Attribute[],
    key: string,
    value: unknown,
  ): { handled: boolean; where?: Filter } {
    const direct = attributes.find((a) => a.name === key);
    if (direct) {
      if (value === null) return { handled: true };
      if (!isPlainObject(value)) throw new Fallback("invalid filter");
      const parts = Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([op, v]) => this.predicate(engine, direct, op, v));
      return { handled: true, where: allOf(parts) };
    }
    const m = /^(.+)_([A-Z_]+)$/.exec(key);
    const attr = m ? attributes.find((a) => a.name === m[1]) : undefined;
    const op = m ? LEGACY_OPERATORS[m[2]!] : undefined;
    if (attr && op) {
      if (value === null && op !== "eq") return { handled: true };
      return { handled: true, where: this.predicate(engine, attr, op, value) };
    }
    return { handled: false };
  }

  /** One comparison on an attribute, `undefined` when it filters nothing. */
  private predicate(
    engine: Pick<EngineNode, "fields">,
    attr: Attribute,
    op: string,
    value: unknown,
  ): AnyRecord | undefined {
    const field = engine.fields.get(attr.name);
    if (!field || attr.cypher) throw new Fallback(`filter on ${attr.name}`);
    if (attr.type.list) {
      if (value instanceof AuthValue) return this.reference(engine, attr, op, value.value);
      if (value === null) {
        if (op === "eq") throw new Fallback("null list filter");
        return undefined;
      }
      if (op === "eq") return { [field]: { equals: engineValue(attr, value) } };
      if (op === "includes") return { [field]: { has: engineValue(attr, value) } };
      throw new Fallback(`list filter ${op}`);
    }
    const engineOp = SCALAR_OPERATORS[op];
    if (!engineOp) throw new Fallback(`filter ${op}`);
    if (value instanceof AuthValue) return this.reference(engine, attr, op, value.value);
    if (value === null) return op === "eq" ? { [field]: { equals: null } } : undefined;
    if (op === "in" && !Array.isArray(value)) throw new Fallback("in without a list");
    return { [field]: { [engineOp]: engineValue(attr, value) } };
  }

  /**
   * A comparison with a `$jwt` / `$context` reference of a rule (the compiler's `($p IS NOT NULL
   * AND <comparison>)`): a missing value matches nothing (even under `NOT`), any other is compared.
   */
  private reference(
    engine: Pick<EngineNode, "fields">,
    attr: Attribute,
    op: string,
    value: unknown,
  ): AnyRecord | undefined {
    if (value === null || value === undefined) return FALSE;
    return this.predicate(engine, attr, op, value);
  }

  /** A filter through a relationship (`actors: { some }`, `lab: { … }`, `actorsConnection`, …). */
  private relationship(node: NodeType, key: string, value: unknown): Filter {
    const find = (name: string) => node.relationships.find((r) => r.name === name);
    let rel = find(key);
    if (rel) {
      if (!rel.list) return this.toOne(node, rel, value);
      if (!isFilterObject(value)) return undefined;
      const r = rel;
      return allOf(Object.entries(value).map(([q, w]) => this.related(node, r, q, w, false)));
    }
    if (key.endsWith("Connection") && (rel = find(key.slice(0, -"Connection".length)))) {
      // In rules, v7 reads a to-one connection filter as `single` (not on to-one relations here).
      if (!rel.list && this.authorization) throw new Fallback("to-one connection filter in a rule");
      if (!rel.list) return this.related(node, rel, "some", value, true);
      if (!isFilterObject(value)) return undefined;
      const r = rel;
      return allOf(
        Object.entries(value).map(([q, w]) => {
          if (q === "aggregate") throw new Fallback("aggregation filter");
          return this.related(node, r, q, w, true);
        }),
      );
    }
    if (key.endsWith("Aggregate")) throw new Fallback("aggregation filter");
    const m = /^(.+)_(ALL|NONE|SINGLE|SOME)$/.exec(key);
    if (m) {
      const quantifier = QUANTIFIERS[m[2]!]!;
      if ((rel = find(m[1]!)) && rel.list) return this.related(node, rel, quantifier, value, false);
      if (
        m[1]!.endsWith("Connection") &&
        (rel = find(m[1]!.slice(0, -"Connection".length))) &&
        rel.list
      ) {
        return this.related(node, rel, quantifier, value, true);
      }
    }
    throw new Fallback(`unknown filter ${node.name}Where.${key}`);
  }

  /** `lab: …` on a to-one relationship. */
  private toOne(node: NodeType, rel: Relationship, value: unknown): Filter {
    if (value === undefined) return undefined;
    const { name, target } = this.relation(node, rel);
    if (value === null) return { [name]: null };
    if (!isFilterObject(value) || Object.keys(value).length === 0) return undefined;
    const inner = this.node(target, value);
    // A filter that filters nothing still requires the related node (not in rules).
    if (inner === undefined && this.authorization) return undefined;
    return { [name]: { is: condition(inner ?? TRUE) } };
  }

  /** `some` / `none` / `all` / `single` of the related nodes matching a node or connection filter. */
  private related(
    node: NodeType,
    rel: Relationship,
    quantifier: string,
    where: unknown,
    connection: boolean,
  ): Filter {
    if (!isFilterObject(where)) return undefined;
    const { name, target } = this.relation(node, rel);
    const filter = connection ? this.connection(rel, target, where) : this.node(target, where);
    // v7 ignores a quantifier whose filter filters nothing.
    if (filter === undefined) return undefined;
    const inner = condition(filter);
    // A to-one connection filter (`labConnection: { node }`) is `some` of the one related node.
    if (!rel.list && quantifier === "some") return { [name]: { is: inner } };
    if (!rel.list) throw new Fallback(`to-one relationship filter ${quantifier}`);
    switch (quantifier) {
      case "some":
        return { [name]: { some: inner } };
      case "none":
        return { [name]: { none: inner } };
      case "all":
        // At least one related node, and every one matches.
        return { [name]: { some: {}, every: inner } };
      case "single":
        // Exactly one matching related node (v7 counts the matching paths, like `_count`).
        return { _count: { [name]: { equals: 1, where: inner } } };
    }
    throw new Fallback(`relationship filter ${quantifier}`);
  }

  /**
   * A connection `where` (`{ node, edge }` with `AND` / `OR` / `NOT`) as a filter on the related
   * node. Edge filters throw {@link Fallback}.
   */
  connection(rel: Relationship, target: NodeType, where: unknown): Filter {
    if (!isFilterObject(where)) return undefined;
    const parts: Filter[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      const l = this.logical(key, value, (w) => this.connection(rel, target, w));
      if (l.handled) {
        parts.push(l.where);
        continue;
      }
      if (key === "node") {
        parts.push(this.node(target, value));
        continue;
      }
      if (key === "edge") {
        if (value !== null && rel.properties) throw new Fallback("edge filter");
        continue;
      }
      throw new Fallback(`unknown connection filter ${key}`);
    }
    return allOf(parts);
  }
}
