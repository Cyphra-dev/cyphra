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
 * - aggregation filters are engine `$aggregate` comparisons, `@cypher` filters engine `$cypher` /
 *   `$cypherNodes` filters on the field's statement (see `cypher.ts`).
 *
 * What it cannot translate exactly throws {@link Fallback}: the compat compiler then runs the
 * request (relationships to interfaces and unions, `@cypher` statements that aggregate outside the
 * `where` of a root read, …).
 *
 * @packageDocumentation
 */

import { CypherDateTimeText } from "@cyphra/runtime";
import neo4j from "neo4j-driver";
import { AuthValue } from "../cypher/where.js";
import {
  keyedConnectionEdge,
  keyedEdgeInput,
  type Attribute,
  type CypherNodeField,
  type NodeType,
  type PropertiesType,
  type Relationship,
  type V7Model,
} from "../model.js";
import { filterNodes, filterValue } from "./cypher.js";
import { ENGINE_SCALAR_TYPES, type EngineNode, type EngineSchema } from "./schema.js";

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

/** Comparison keys of aggregation filters, generic and deprecated (`_EQUAL`, `count_EQ`). */
const AGGREGATION_COMPARISON: Record<string, string> = {
  EQ: "eq",
  EQUAL: "eq",
  GT: "gt",
  GTE: "gte",
  LT: "lt",
  LTE: "lte",
};

const AGGREGATION_OPERATORS = new Set(["eq", "gt", "gte", "lt", "lte"]);

/** Aggregates of the generic aggregation filters (strings aggregate their lengths). */
const GENERIC_AGGREGATES: Record<string, string> = {
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

const LEGACY_AGGREGATES: Record<string, string> = {
  AVERAGE: "avg",
  MIN: "min",
  SHORTEST: "min",
  MAX: "max",
  LONGEST: "max",
  SUM: "sum",
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
 * One value of a filter or a write, as the engine encodes the attribute's type to the same driver
 * value the compat compiler passes (a DateTime text is parsed by `datetime()` in the statement,
 * like the compiler's). Other values throw {@link Fallback}.
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
      case "DateTime":
        // The compiler passes the text to `datetime()` (offset and precision kept): so does the
        // engine, with a DateTime text.
        if (typeof v === "string") return new CypherDateTimeText(v);
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
    /** `$jwt` of `@cypher` statements: the decoded JWT, `{}` when not authenticated (v7). */
    private readonly jwt: unknown = {},
  ) {}

  /**
   * `true` while translating the `where` of a root read: there, a `@cypher` filter may run a
   * statement that aggregates (see `cypher.ts`).
   */
  root = false;

  /** `translate()` with {@link root} set. */
  atRoot<T>(translate: () => T): T {
    const was = this.root;
    this.root = true;
    try {
      return translate();
    } finally {
      this.root = was;
    }
  }

  /**
   * The engine node of a v7 node type, or {@link Fallback} (interfaces). Its `@authentication` /
   * `@authorization` annotations are the callers' (they apply where they read or write its nodes).
   */
  engineNode(node: NodeType): EngineNode {
    const n = this.schema.nodes.get(node.name);
    if (!n || n.v7 !== node) throw new Fallback(`${node.name} is not in the engine`);
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
      const legacy = /^(.+)_(ALL|NONE|SINGLE|SOME)$/.exec(key);
      const cypherNode =
        node.cypherNodes.find((c) => c.name === key) ??
        (legacy ? node.cypherNodes.find((c) => c.name === legacy[1]) : undefined);
      if (cypherNode) {
        push(this.cypherNodes(cypherNode, key, value));
        continue;
      }
      if (node.cypherNodes.some((c) => key.startsWith(`${c.name}_`))) {
        throw new Fallback("@cypher filter");
      }
      push(this.relationship(node, key, value));
    }
    return allOf(parts);
  }

  /**
   * A filter on a `@cypher` field returning nodes, on the nodes its statement returns: `some` /
   * `none` / `single` / `all` of them (`all` holds without any), or for one node the first of them
   * (`null`: there is none). Engine `$cypherNodes` filters.
   */
  private cypherNodes(field: CypherNodeField, key: string, value: unknown): Filter {
    // v7 cannot filter on a field with arguments (an error).
    if (field.args.length) throw new Fallback("filter on a @cypher field with arguments");
    const target = this.model.node(field.target);
    this.engineNode(target);
    const entry = (quantifier: string, where?: Filter): AnyRecord => ({
      $cypherNodes: [
        {
          expr: filterNodes(field.cypher, this.jwt, this.root),
          model: target.name,
          quantifier,
          ...(where !== undefined && where !== TRUE ? { where } : {}),
        },
      ],
    });
    if (!field.type.list) {
      if (value === undefined) return undefined;
      if (value === null) return entry("absent");
      if (!isFilterObject(value)) return undefined;
      const inner = this.node(target, value);
      return inner === undefined ? undefined : entry("first", inner);
    }
    const legacy = /^(.+)_(ALL|NONE|SINGLE|SOME)$/.exec(key);
    const quantifiers: [string, unknown][] =
      key === field.name
        ? isFilterObject(value)
          ? Object.entries(value)
          : []
        : [[QUANTIFIERS[legacy![2]!]!, value]];
    const parts: Filter[] = [];
    for (const [quantifier, where] of quantifiers) {
      if (!isFilterObject(where)) continue;
      if (!["some", "none", "single", "all"].includes(quantifier)) {
        throw new Fallback(`@cypher filter ${quantifier}`);
      }
      const inner = this.node(target, where);
      if (inner !== undefined) parts.push(entry(quantifier, inner));
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
    if (attr.cypher) return this.cypherPredicate(attr, op, value);
    const field = engine.fields.get(attr.name);
    if (!field) throw new Fallback(`filter on ${attr.name}`);
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
   * One comparison on the value of a scalar `@cypher` field (the first row's value, every value of
   * a list field), as an engine `$cypher` filter.
   */
  private cypherPredicate(attr: Attribute, op: string, value: unknown): AnyRecord | undefined {
    // v7 cannot filter on a field with arguments (an error).
    if (attr.args.length) throw new Fallback("filter on a @cypher field with arguments");
    if (value instanceof AuthValue) {
      if (value.value === null || value.value === undefined) return FALSE;
      return this.cypherPredicate(attr, op, value.value);
    }
    const type = attr.kind === "enum" ? "String" : ENGINE_SCALAR_TYPES[attr.type.name];
    if (!type) throw new Fallback(`filter on a @cypher ${attr.type.name} field`);
    let filter: AnyRecord | undefined;
    if (attr.type.list) {
      if (value === null) {
        if (op === "eq") throw new Fallback("null list filter");
        return undefined;
      }
      if (op === "eq") filter = { equals: engineValue(attr, value) };
      else if (op === "includes") filter = { has: engineValue(attr, value) };
      else throw new Fallback(`list filter ${op}`);
    } else {
      const engineOp = SCALAR_OPERATORS[op];
      if (!engineOp) throw new Fallback(`filter ${op}`);
      if (value === null) {
        if (op !== "eq") return undefined;
        filter = { equals: null };
      } else {
        if (op === "in" && !Array.isArray(value)) throw new Fallback("in without a list");
        filter = { [engineOp]: engineValue(attr, value) };
      }
    }
    const expr = filterValue(attr.cypher!, attr.type.list, this.jwt, this.root);
    return { $cypher: [{ expr, type, list: attr.type.list, filter }] };
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
          if (q === "aggregate") return this.aggregation(node, r, w, false);
          return this.related(node, r, q, w, true);
        }),
      );
    }
    if (key.endsWith("Aggregate") && (rel = find(key.slice(0, -"Aggregate".length)))) {
      return this.aggregation(node, rel, value, true);
    }
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

  /**
   * An aggregation filter (`actorsConnection: { aggregate }`, `deprecated`: `actorsAggregate`):
   * `count`, `node`, `edge` with `AND` / `OR` / `NOT`, each comparison an engine `$aggregate`
   * filter. In the connection form, `count.nodes` and `node` aggregate distinct nodes; `count.edges`,
   * `edge` and the deprecated form do not deduplicate (like the compiler).
   */
  private aggregation(
    node: NodeType,
    rel: Relationship,
    where: unknown,
    deprecated: boolean,
  ): Filter {
    if (!isFilterObject(where)) return undefined;
    const { name, target } = this.relation(node, rel);
    const engineTarget = this.engineNode(target);
    const compile = (w: AnyRecord): Filter => {
      const parts: Filter[] = [];
      for (const [key, value] of Object.entries(w)) {
        if (value === undefined || value === null) continue;
        const l = this.logical(key, value, compile);
        if (l.handled) {
          parts.push(l.where);
          continue;
        }
        if (key === "count") {
          if (!isFilterObject(value)) continue;
          if (deprecated) {
            parts.push(this.aggregateComparisons(name, { of: "count" }, value));
            continue;
          }
          for (const [what, filters] of Object.entries(value)) {
            if (!isFilterObject(filters)) continue;
            if (what !== "nodes" && what !== "edges") throw new Fallback(`count filter ${what}`);
            parts.push(
              this.aggregateComparisons(name, { of: "count", distinct: what === "nodes" }, filters),
            );
          }
          continue;
        }
        const legacyCount = /^count_(EQ|GT|GTE|LT|LTE)$/.exec(key);
        if (legacyCount) {
          const op = AGGREGATION_COMPARISON[legacyCount[1]!]!;
          parts.push(this.aggregateComparisons(name, { of: "count" }, { [op]: value }));
          continue;
        }
        if (key === "node") {
          parts.push(
            this.aggregationWhere(
              name,
              engineTarget.fields,
              target.attributes,
              "node",
              !deprecated,
              value,
            ),
          );
          continue;
        }
        if (key === "edge") {
          const props = this.model.properties.get(rel.properties ?? "");
          if (!props || keyedEdgeInput(this.model, rel)) {
            throw new Fallback("keyed edge aggregation filter");
          }
          const fields = this.schema.edgeFields.get(props.name);
          if (!fields) throw new Fallback(`${props.name} is not in the engine`);
          parts.push(this.aggregationWhere(name, fields, props.attributes, "edge", false, value));
          continue;
        }
        throw new Fallback(`unknown aggregation filter ${key}`);
      }
      return allOf(parts);
    };
    return compile(where);
  }

  /** `${…}NodeAggregationWhereInput` / `${Properties}AggregationWhereInput`. */
  private aggregationWhere(
    relation: string,
    fields: ReadonlyMap<string, string>,
    attributes: readonly Attribute[],
    on: "node" | "edge",
    distinct: boolean,
    where: unknown,
  ): Filter {
    if (!isFilterObject(where)) return undefined;
    const parts: Filter[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined || value === null) continue;
      const l = this.logical(key, value, (w) =>
        this.aggregationWhere(relation, fields, attributes, on, distinct, w),
      );
      if (l.handled) {
        parts.push(l.where);
        continue;
      }
      const field = (attr: Attribute) => {
        const f = attr.cypher ? undefined : fields.get(attr.name);
        if (!f) throw new Fallback(`aggregation filter on ${attr.name}`);
        // v7 compares the length of `String` values (not of `ID` or enum values).
        const length = attr.kind === "scalar" && attr.type.name === "String";
        return { of: on, distinct, field: f, length };
      };
      const direct = attributes.find((a) => a.name === key);
      if (direct) {
        if (!isFilterObject(value)) continue;
        for (const [aggOp, filters] of Object.entries(value)) {
          if (!isFilterObject(filters)) continue;
          const fn = GENERIC_AGGREGATES[aggOp];
          if (!fn) throw new Fallback(`aggregation operator ${aggOp}`);
          parts.push(this.aggregateComparisons(relation, { ...field(direct), fn }, filters));
        }
        continue;
      }
      const m =
        /^(.+?)_(AVERAGE|MAX|MIN|SUM|SHORTEST|LONGEST)(?:_LENGTH)?_(EQUAL|GT|GTE|LT|LTE)$/.exec(
          key,
        );
      const attr = m && attributes.find((a) => a.name === m[1]);
      if (!m || !attr) throw new Fallback(`unknown aggregation filter ${key}`);
      parts.push(
        this.aggregateComparisons(
          relation,
          { ...field(attr), fn: LEGACY_AGGREGATES[m[2]!]! },
          { [AGGREGATION_COMPARISON[m[3]!]!]: value },
        ),
      );
    }
    return allOf(parts);
  }

  /** `{ eq, gt, … }` of one aggregate → engine `$aggregate` comparisons (ANDed). */
  private aggregateComparisons(relation: string, aggregate: AnyRecord, filters: AnyRecord): Filter {
    const parts: Filter[] = [];
    for (const [op, raw] of Object.entries(filters)) {
      if (raw === undefined || raw === null) continue;
      if (!AGGREGATION_OPERATORS.has(op)) throw new Fallback(`aggregation filter operator ${op}`);
      let value = raw;
      if (value instanceof AuthValue) {
        // `($p IS NOT NULL AND <comparison>)`: a missing value matches nothing.
        if (value.value === null || value.value === undefined) {
          parts.push(FALSE);
          continue;
        }
        value = value.value;
      }
      if (typeof value !== "number" && typeof value !== "string" && typeof value !== "boolean") {
        throw new Fallback("aggregation filter value");
      }
      parts.push({ $aggregate: [{ relation, ...aggregate, op, value }] });
    }
    return allOf(parts);
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
   * node (edge filters as its `$edge` filter).
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
        // Without properties, `edge` filters nothing (like the compiler).
        if (!rel.properties) continue;
        const props = this.model.properties.get(rel.properties);
        if (!props || keyedConnectionEdge(this.model, rel)) throw new Fallback("keyed edge filter");
        const f = this.edge(props, value);
        parts.push(f === undefined || f === TRUE ? f : { $edge: f });
        continue;
      }
      throw new Fallback(`unknown connection filter ${key}`);
    }
    return allOf(parts);
  }

  /**
   * A `${Properties}Where` on the edge (`role: { eq }`, `AND` / `OR` / `NOT`), as the engine's
   * `$edge` filter of the related node.
   */
  edge(props: PropertiesType, where: unknown): Filter {
    if (!isFilterObject(where)) return undefined;
    const fields = this.schema.edgeFields.get(props.name);
    if (!fields) throw new Fallback(`${props.name} is not in the engine`);
    const parts: Filter[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      const l = this.logical(key, value, (w) => this.edge(props, w));
      if (l.handled) {
        parts.push(l.where);
        continue;
      }
      const a = this.attribute({ fields }, props.attributes, key, value);
      if (!a.handled) throw new Fallback(`unknown filter ${props.name}Where.${key}`);
      parts.push(a.where);
    }
    return allOf(parts);
  }
}
