/**
 * v7 `where` inputs → native `where` inputs (the same shape as the typed client's `where`), for
 * operations and for rules. What has no native equivalent is reported, never dropped: a filter
 * left out would widen the result.
 *
 * @packageDocumentation
 */

import { isInterface, type NodeType, type Relationship } from "../v7/model.js";
import type { MigrationContext } from "./context.js";
import {
  andAll,
  field,
  isEmptyObj,
  isObj,
  list,
  NULL,
  num,
  obj,
  type Field,
  type ObjValue,
  type Value,
} from "./value.js";

/** How much an issue matters. */
export type IssueKind =
  /** Not translated: the operation (or rule) is left as it is. */
  | "blocking"
  /** Translated, with a loss the user should know about (e.g. a selected field with no equivalent). */
  | "note"
  /** Translated, with a semantic difference the native API has on purpose (reported by `compare`). */
  | "known";

/** One thing the migration tools could not translate exactly. */
export type MigrationIssue = {
  readonly kind: IssueKind;
  readonly message: string;
  /** Offset in the document, when the issue comes from one. */
  readonly loc?: number;
  /**
   * For a `known` difference: whether it can change any value of the result (`connect` as a
   * MERGE), so that `compare` reports every difference of the operation as known. Cursors are
   * not: only their values differ.
   */
  readonly wholeResult?: boolean;
};

/** Collects the issues of one translation. */
export class Issues {
  readonly list: MigrationIssue[] = [];

  add(kind: IssueKind, message: string, loc?: number, wholeResult?: boolean): void {
    if (this.list.some((i) => i.kind === kind && i.message === message)) return;
    this.list.push({ kind, message, loc, ...(wholeResult ? { wholeResult } : {}) });
  }

  block(message: string, loc?: number): void {
    this.add("blocking", message, loc);
  }

  get blocked(): boolean {
    return this.list.some((i) => i.kind === "blocking");
  }
}

/** v7 scalar filter operators → native ones (`undefined`: no native equivalent). */
const SCALAR_OPS: Record<string, string | undefined> = {
  eq: "equals",
  in: "in",
  lt: "lt",
  lte: "lte",
  gt: "gt",
  gte: "gte",
  contains: "contains",
  startsWith: "startsWith",
  endsWith: "endsWith",
  includes: "has",
  matches: undefined,
  distance: undefined,
};

/** Deprecated `title_STARTS_WITH` keys → generic operators. */
const SUFFIX_OPS: Record<string, string> = {
  EQ: "eq",
  IN: "in",
  LT: "lt",
  LTE: "lte",
  GT: "gt",
  GTE: "gte",
  CONTAINS: "contains",
  STARTS_WITH: "startsWith",
  ENDS_WITH: "endsWith",
  MATCHES: "matches",
  INCLUDES: "includes",
};
const SUFFIX_KEY = /^(.+?)_(EQ|IN|LT|LTE|GT|GTE|CONTAINS|STARTS_WITH|ENDS_WITH|MATCHES|INCLUDES)$/;
const QUANTIFIER_KEY = /^(.+?)_(SOME|ALL|NONE|SINGLE)$/;

/** Translates v7 `where` values of one document (or rule) into native ones. */
export class WhereTranslator {
  constructor(
    readonly ctx: MigrationContext,
    readonly issues: Issues,
  ) {}

  /**
   * A v7 `${Type}Where` on the nodes of `type` (a `@node` type, an interface or a union) → the
   * native `where`. `at` names the place in messages.
   */
  where(type: string, value: Value, at: string): Value {
    if (value.k === "null") return NULL;
    if (value.k === "var") {
      this.issues.block(
        `${at}: the variable $${value.name} holds a v7 ${type}Where; write the filter inline (or build the native where in the client)`,
        value.loc,
      );
      return value;
    }
    if (value.k !== "obj") {
      this.issues.block(`${at}: unexpected filter value`, value.loc);
      return value;
    }
    const union = this.ctx.v7.unions.get(type);
    if (union) return this.unionWhere(value, at);
    const node = this.ctx.v7Node(type);
    if (!node) {
      this.issues.block(`${at}: ${type} is not a @node type, interface or union`, value.loc);
      return value;
    }
    return this.nodeWhere(node, value, at);
  }

  private unionWhere(value: ObjValue, at: string): Value {
    const on: Field[] = [];
    for (const f of value.fields) {
      const member = this.ctx.nativeModel(f.key)?.name ?? f.key;
      on.push(field(member, this.where(f.key, f.value, `${at}.${f.key}`), f.loc));
    }
    return on.length ? obj([field("_on", obj(on))], value.loc) : obj([], value.loc);
  }

  private nodeWhere(node: NodeType, value: ObjValue, at: string): ObjValue {
    const parts: ObjValue[] = [];
    // Deprecated suffix keys of one field are merged into its generic filter first.
    const grouped = this.groupSuffixKeys(node, value);
    for (const f of grouped) {
      const here = `${at}.${f.key}`;
      if (f.key === "AND" || f.key === "OR") {
        if (f.value.k === "var") {
          this.issues.block(`${here}: the variable $${f.value.name} holds v7 filters`, f.loc);
          continue;
        }
        const items = f.value.k === "list" ? f.value.items : [f.value];
        parts.push(
          obj([
            field(
              f.key,
              list(items.map((x, i) => this.where(node.name, x, `${here}[${i}]`))),
              f.loc,
            ),
          ]),
        );
        continue;
      }
      if (f.key === "NOT") {
        parts.push(obj([field("NOT", this.where(node.name, f.value, here), f.loc)]));
        continue;
      }
      if (f.key === "typename" && isInterface(node)) {
        parts.push(obj([field("_typename", this.typename(f.value, here), f.loc)]));
        continue;
      }
      const attr = node.attributes.find((a) => a.name === f.key);
      if (attr) {
        const target = this.ctx.nativeScalar(node.name, attr)?.name;
        if (target === undefined) {
          this.issues.block(
            `${here}: ${node.name}.${attr.name} is not a field of the Cyphra model`,
            f.loc,
          );
          continue;
        }
        if (attr.cypher) {
          this.issues.add(
            "note",
            `${here}: filters on the @cypher field ${node.name}.${attr.name} need a cypherFields entry of the same name in the native config`,
            f.loc,
          );
        }
        const filter = this.scalarFilter(f.value, here, attr.type.list);
        if (filter) parts.push(obj([field(target, filter, f.loc)]));
        continue;
      }
      const rel = node.relationships.find((r) => r.name === f.key);
      if (rel) {
        parts.push(...this.relationFilter(node, rel, f.value, here, f.loc));
        continue;
      }
      const conn = node.relationships.find((r) => `${r.name}Connection` === f.key);
      if (conn) {
        parts.push(...this.connectionFilter(node, conn, f.value, here, f.loc));
        continue;
      }
      const agg = node.relationships.find((r) => `${r.name}Aggregate` === f.key);
      if (agg) {
        const p = this.aggregateFilter(node, agg, f.value, here);
        if (p) parts.push(p);
        continue;
      }
      if (node.cypherNodes.some((c) => c.name === f.key || f.key.startsWith(`${c.name}_`))) {
        this.issues.block(
          `${here}: filters on the @cypher node field ${node.name}.${f.key.replace(/_[A-Z]+$/, "")} have no native equivalent (filter with a Cypher-backed scalar field)`,
          f.loc,
        );
        continue;
      }
      const quant = QUANTIFIER_KEY.exec(f.key);
      if (quant) {
        const [, base, q] = quant;
        const r = node.relationships.find((x) => x.name === base);
        const c = node.relationships.find((x) => `${x.name}Connection` === base);
        const wrapped = obj([field(q!.toLowerCase(), f.value, f.loc)]);
        if (r) {
          parts.push(...this.relationFilter(node, r, wrapped, here, f.loc));
          continue;
        }
        if (c) {
          parts.push(...this.connectionFilter(node, c, wrapped, here, f.loc));
          continue;
        }
      }
      this.issues.block(`${here}: unknown v7 filter on ${node.name}`, f.loc);
    }
    return andAll(parts);
  }

  /** `title_GT: 1, title_LT: 3` → `title: { gt: 1, lt: 3 }` (when `title` is an attribute). */
  private groupSuffixKeys(node: NodeType, value: ObjValue): Field[] {
    const out: Field[] = [];
    for (const f of value.fields) {
      const m = SUFFIX_KEY.exec(f.key);
      const attr = m && node.attributes.find((a) => a.name === m[1]);
      if (!m || !attr) {
        out.push(f);
        continue;
      }
      const op = field(SUFFIX_OPS[m[2]!]!, f.value, f.loc);
      const existing = out.findIndex((g) => g.key === attr.name && isObj(g.value));
      const prev = existing >= 0 ? out[existing]!.value : undefined;
      if (isObj(prev) && !prev.fields.some((x) => x.key === op.key)) {
        out[existing] = field(attr.name, obj([...prev.fields, op]), f.loc);
      } else if (!prev) {
        out.push(field(attr.name, obj([op]), f.loc));
      } else {
        out.push(field("AND", list([obj([field(attr.name, obj([op]))])]), f.loc));
      }
    }
    return out;
  }

  /** v7 scalar filters (`{ eq, in, gt, … }`) → the native ones; `null` for `{ eq: null }`. */
  scalarFilter(value: Value, at: string, isList: boolean): Value | undefined {
    if (value.k === "var") {
      this.issues.block(
        `${at}: the variable $${value.name} holds v7 scalar filters ({ eq, … }); write the filter inline`,
        value.loc,
      );
      return undefined;
    }
    if (value.k !== "obj") {
      this.issues.block(`${at}: unexpected filter value`, value.loc);
      return undefined;
    }
    const ops: Field[] = [];
    let isNull = false;
    for (const f of value.fields) {
      if (f.key === "eq" && f.value.k === "null") {
        isNull = true;
        continue;
      }
      if (!(f.key in SCALAR_OPS)) {
        this.issues.block(`${at}.${f.key}: unknown v7 filter operator`, f.loc);
        continue;
      }
      const native = SCALAR_OPS[f.key];
      if (!native) {
        this.issues.block(
          `${at}.${f.key}: the native API has no ${f.key === "matches" ? "regular expression" : f.key} filter`,
          f.loc,
        );
        continue;
      }
      if (f.key === "eq" && isList) ops.push(field("equals", f.value, f.loc));
      else ops.push(field(native, f.value, f.loc));
    }
    if (isNull && ops.length) {
      this.issues.block(`${at}: { eq: null } with other operators`, value.loc);
      return undefined;
    }
    if (isNull) return NULL;
    return obj(ops, value.loc);
  }

  /** `typename: [Lab, Quiz]` → `_typename: { in: [Lab, Quiz] }`. */
  private typename(value: Value, at: string): Value {
    if (value.k === "var") {
      this.issues.block(`${at}: the variable $${value.name} holds v7 typenames`, value.loc);
      return value;
    }
    const items = value.k === "list" ? value.items : [value];
    return obj([
      field(
        "in",
        list(
          items.map((v) =>
            v.k === "enum" ? { k: "enum", v: this.ctx.nativeModel(v.v)?.name ?? v.v } : v,
          ),
        ),
      ),
    ]);
  }

  /** The native relation name of `rel`, or `undefined` (reported). */
  private relName(node: NodeType, rel: Relationship, at: string, loc?: number): string | undefined {
    const r = this.ctx.nativeRelation(node.name, rel);
    if (!r)
      this.issues.block(
        `${at}: ${node.name}.${rel.name} is not a relation of the Cyphra model`,
        loc,
      );
    return r?.name;
  }

  /** `actors: { some, all, none, single }`, `author: { … }` / `author: null`. */
  private relationFilter(
    node: NodeType,
    rel: Relationship,
    value: Value,
    at: string,
    loc?: number,
  ): ObjValue[] {
    const name = this.relName(node, rel, at, loc);
    if (!name) return [];
    if (value.k === "var") {
      this.issues.block(
        `${at}: the variable $${value.name} holds a v7 relationship filter`,
        value.loc,
      );
      return [];
    }
    if (!rel.list) {
      // v7: `author: null` (no related node), `author: {}` (no filter), `author: { … }`.
      if (value.k === "null") {
        // v7 ignores `null` on a to-one relationship to a union (every node matches).
        if (this.ctx.v7.unions.has(rel.target)) return [];
        return [obj([field(name, NULL, loc)])];
      }
      if (isEmptyObj(value)) return [];
      return [obj([field(name, obj([field("is", this.where(rel.target, value, at))]), loc)])];
    }
    if (value.k !== "obj") {
      this.issues.block(`${at}: unexpected relationship filter`, value.loc);
      return [];
    }
    const quantifiers: Field[] = [];
    const extra: ObjValue[] = [];
    const union = this.ctx.v7.unions.has(rel.target);
    for (const q of value.fields) {
      const w = this.where(rel.target, q.value, `${at}.${q.key}`);
      // v7 ignores a quantifier whose filter is empty (`some: {}` matches every node).
      if (isEmptyObj(w)) continue;
      if (union && (q.key === "all" || q.key === "single")) {
        this.issues.block(
          `${at}.${q.key}: v7 applies ${q.key} per union member; the native API has no equivalent (filter each member with some / none)`,
          q.loc,
        );
        continue;
      }
      if (q.key === "some" || q.key === "none") quantifiers.push(field(q.key, w, q.loc));
      else if (q.key === "all") {
        // v7 `all` needs at least one related node (not vacuously true): `every` and `some: {}`.
        quantifiers.push(field("every", w, q.loc));
      } else if (q.key === "single") extra.push(this.countWhere(name, 1, w, q.loc));
      else this.issues.block(`${at}.${q.key}: unknown v7 relationship filter`, q.loc);
    }
    if (quantifiers.some((q) => q.key === "every") && !quantifiers.some((q) => q.key === "some")) {
      quantifiers.push(field("some", obj([])));
    }
    return [...(quantifiers.length ? [obj([field(name, obj(quantifiers), loc)])] : []), ...extra];
  }

  /** `_count: { actors: { equals: n, where } }`: exactly `n` related nodes match. */
  private countWhere(rel: string, n: number, where: Value, loc?: number): ObjValue {
    const filter: Field[] = [field("equals", num(n))];
    if (!(where.k === "obj" && where.fields.length === 0)) filter.push(field("where", where));
    return obj([field("_count", obj([field(rel, obj(filter))]), loc)]);
  }

  /** `actorsConnection: { some: { node, edge } }`, `ownerConnection: { node, edge }`. */
  private connectionFilter(
    node: NodeType,
    rel: Relationship,
    value: Value,
    at: string,
    loc?: number,
  ): ObjValue[] {
    if (value.k === "var") {
      this.issues.block(
        `${at}: the variable $${value.name} holds a v7 connection filter`,
        value.loc,
      );
      return [];
    }
    if (value.k !== "obj") {
      this.issues.block(`${at}: unexpected connection filter`, value.loc);
      return [];
    }
    if (!rel.list) {
      if (isEmptyObj(value)) return [];
      return this.relationFilter(node, rel, this.connectionWhere(rel, value, at), at, loc);
    }
    const parts: ObjValue[] = [];
    const quantified: Field[] = [];
    for (const q of value.fields) {
      if (q.key === "aggregate") {
        const p = this.aggregateFilter(node, rel, q.value, `${at}.aggregate`, true);
        if (p) parts.push(p);
        continue;
      }
      quantified.push(field(q.key, this.connectionWhere(rel, q.value, `${at}.${q.key}`), q.loc));
    }
    if (quantified.length) parts.push(...this.relationFilter(node, rel, obj(quantified), at, loc));
    return parts;
  }

  /**
   * A v7 `${Type}${Rel}ConnectionWhere` (`{ node, edge, AND, OR, NOT }`) → a v7 `where` on the
   * related node (translated by the caller). Edge filters have no native equivalent.
   */
  connectionWhere(rel: Relationship, value: Value, at: string): Value {
    if (value.k === "var") {
      this.issues.block(
        `${at}: the variable $${value.name} holds a v7 connection filter`,
        value.loc,
      );
      return obj([]);
    }
    if (value.k !== "obj") return value;
    const fields: Field[] = [];
    for (const f of value.fields) {
      if (f.key === "node" || f.key === rel.target) {
        if (isObj(f.value)) fields.push(...f.value.fields);
        else this.issues.block(`${at}.node: unexpected value`, f.loc);
      } else if (f.key === "edge" || (rel.properties && f.key === rel.properties)) {
        if (!(isObj(f.value) && f.value.fields.length === 0)) {
          this.issues.block(
            `${at}.edge: the native API has no filters on edge properties (filter on the related node, or use a Cypher-backed field)`,
            f.loc,
          );
        }
      } else if (this.ctx.v7.unions.get(rel.target)?.members.includes(f.key)) {
        // A union relationship: `{ Movie: { node, edge } }`, a filter per member.
        fields.push(
          field(
            f.key,
            this.connectionWhere({ ...rel, target: f.key }, f.value, `${at}.${f.key}`),
            f.loc,
          ),
        );
      } else if (f.key === "AND" || f.key === "OR") {
        const items = f.value.k === "list" ? f.value.items : [f.value];
        fields.push(
          field(
            f.key,
            list(items.map((x, i) => this.connectionWhere(rel, x, `${at}.${f.key}[${i}]`))),
            f.loc,
          ),
        );
      } else if (f.key === "NOT") {
        fields.push(field("NOT", this.connectionWhere(rel, f.value, `${at}.NOT`), f.loc));
      } else {
        this.issues.block(`${at}.${f.key}: unknown v7 connection filter`, f.loc);
      }
    }
    return obj(fields, value.loc);
  }

  /**
   * v7 aggregation filters (`actorsAggregate: { count: { gt: 2 } }`, `actorsConnection: {
   * aggregate: { count: { nodes: … } } }`) → `_count` filters; the others have no equivalent.
   */
  private aggregateFilter(
    node: NodeType,
    rel: Relationship,
    value: Value,
    at: string,
    connection = false,
  ): ObjValue | undefined {
    const name = this.relName(node, rel, at, value.loc);
    if (!name) return undefined;
    if (value.k === "var") {
      this.issues.block(
        `${at}: the variable $${value.name} holds a v7 aggregation filter`,
        value.loc,
      );
      return undefined;
    }
    if (value.k !== "obj") return undefined;
    if (!rel.list) {
      this.issues.block(
        `${at}: aggregation filters on a to-one relationship have no native equivalent`,
        value.loc,
      );
      return undefined;
    }
    const parts: ObjValue[] = [];
    const count = (v: Value, here: string, loc?: number) => {
      const f = this.scalarFilter(v, here, false);
      if (f === undefined) return;
      if (f.k === "null") {
        this.issues.block(`${here}: { eq: null } on a count`, loc);
        return;
      }
      parts.push(obj([field("_count", obj([field(name, f)]), loc)]));
    };
    for (const f of value.fields) {
      const here = `${at}.${f.key}`;
      if (f.key === "count") {
        if (connection) {
          if (!isObj(f.value)) {
            this.issues.block(`${here}: unexpected value`, f.loc);
            continue;
          }
          for (const c of f.value.fields) {
            if (c.key === "nodes") count(c.value, `${here}.nodes`, c.loc);
            else
              this.issues.block(
                `${here}.${c.key}: counting edges has no native equivalent (_count counts related nodes)`,
                c.loc,
              );
          }
        } else count(f.value, here, f.loc);
        continue;
      }
      const suffix = /^count_(EQ|LT|LTE|GT|GTE)$/.exec(f.key);
      if (suffix) {
        count(obj([field(SUFFIX_OPS[suffix[1]!]!, f.value)]), here, f.loc);
        continue;
      }
      if (f.key === "AND" || f.key === "OR") {
        const items = f.value.k === "list" ? f.value.items : [f.value];
        const translated = items
          .map((x, i) => this.aggregateFilter(node, rel, x, `${here}[${i}]`, connection))
          .filter((x): x is ObjValue => x !== undefined);
        parts.push(obj([field(f.key, list(translated), f.loc)]));
        continue;
      }
      if (f.key === "NOT") {
        const t = this.aggregateFilter(node, rel, f.value, here, connection);
        if (t) parts.push(obj([field("NOT", t, f.loc)]));
        continue;
      }
      this.issues.block(
        `${here}: aggregation filters on ${f.key === "edge" ? "edge properties" : "related node fields"} have no native equivalent (only counts: _count)`,
        f.loc,
      );
    }
    return andAll(parts);
  }
}
