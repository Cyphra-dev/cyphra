/**
 * Compiles one v7 root query field (`movies`, `moviesConnection`) with its whole selection set into a
 * single Cypher statement, plus a decoder that turns the returned value into the GraphQL result.
 *
 * Nested relationship fields become `COLLECT { … }` subqueries, connections become a `COUNT { … }`
 * (for `totalCount` / `pageInfo`) and a `COLLECT { … }` of edges. Cursors are v7 offset cursors:
 * `base64("arrayconnection:<offset>")`.
 *
 * Connection `aggregate` selections follow v7 7.6: `count.nodes` / `count.edges` count distinct
 * nodes / relationships; each `node.<field>` / `edge.<field>` aggregate runs over the distinct nodes
 * (relationships) matching the connection `where` (not `first` / `after`); `shortest` / `longest` are
 * the last / first values ordered by `size(…)` descending; `sum` of an empty set is `0`, the other
 * aggregates are `null`. Int `average` is a Float, BigInt values (including `average`) are strings.
 *
 * Authorization (v7 7.6): the READ `filter` rules of the type (and of the selected fields) are part
 * of the `WHERE` of every node selection, root or nested, and of connection `totalCount`; connection
 * `aggregate` selections use the AGGREGATE rules instead. When READ (AGGREGATE) `validate` rules fail
 * for one node matching the selection's filters (before pagination, like v7), the selection is
 * replaced by a {@link FORBIDDEN_KEY} marker and the field fails with `Forbidden`: the projection of
 * a node that is not allowed is never returned by the database.
 *
 * @packageDocumentation
 */

import {
  GraphQLIncludeDirective,
  GraphQLSkipDirective,
  Kind,
  getArgumentValues,
  getDirectiveValues,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLField,
  type GraphQLObjectType,
  type GraphQLSchema,
  type SelectionNode,
  type SelectionSetNode,
} from "graphql";
import neo4j, { isInt } from "neo4j-driver";
import { checkAuthentication, type AuthContext } from "../auth/context.js";
import { AuthRules } from "../auth/rules.js";
import {
  edgeValue,
  isInterface,
  isUnionRelationship,
  keyedConnectionEdge,
  selectedMembers,
  unionMembers,
  type Attribute,
  type InterfaceType,
  type CypherAnnotation,
  type CypherNodeField,
  type CypherRootField,
  type FulltextIndex,
  type NodeType,
  type PropertiesType,
  type Relationship,
  type UnionType,
  type V7Model,
} from "../model.js";
import {
  CypherContext,
  labels,
  listAggregate,
  labelPredicate,
  nodePattern,
  property,
  q,
  withList,
  type ListAggregate,
} from "./context.js";
import { WhereCompiler, relationshipPattern } from "./where.js";
import { AGGREGATE_MARK, column, hasStatement, scalarClause, statementCall } from "./custom.js";

type AnyRecord = Record<string, unknown>;
export type Decoder = (raw: unknown) => unknown;

/**
 * Key of the marker map that replaces a selection whose `validate` rules failed. Not a GraphQL name
 * (`:`), so no alias can produce it.
 */
export const FORBIDDEN_KEY = "cyphra:forbidden";
const FORBIDDEN_MARKER = `{ ${"`"}${FORBIDDEN_KEY}${"`"}: true }`;

/** Whether a raw result contains the {@link FORBIDDEN_KEY} marker (maps and lists, any depth). */
export function containsForbidden(raw: unknown): boolean {
  if (Array.isArray(raw)) return raw.some(containsForbidden);
  if (typeof raw !== "object" || raw === null) return false;
  const proto = Object.getPrototypeOf(raw) as unknown;
  if (proto !== Object.prototype && proto !== null) return false;
  if (Object.prototype.hasOwnProperty.call(raw, FORBIDDEN_KEY)) return true;
  return Object.values(raw as AnyRecord).some(containsForbidden);
}

function and(parts: readonly (string | undefined)[]): string | undefined {
  const ps = parts.filter((p): p is string => p !== undefined);
  if (ps.length === 0) return undefined;
  if (ps.length === 1) return ps[0];
  return ps.map((p) => `(${p})`).join(" AND ");
}

/**
 * The projection of one row, or the marker when the row's node fails validation. Checked again on
 * the projected row itself (on top of {@link gate}), so a concurrent change between the two cannot
 * let a projection through.
 */
function rowGate(failure: string | undefined, expr: string, marker: string): string {
  return failure === undefined ? expr : `CASE WHEN ${failure} THEN ${marker} ELSE ${expr} END`;
}

/**
 * `CASE WHEN EXISTS { MATCH … WHERE <filters> AND <failure> } THEN <marker> ELSE expr END`: like
 * v7, a selection fails when one node matching its filters fails validation, not only the nodes of
 * the requested page.
 */
function gate(
  match: string,
  predicate: string | undefined,
  failure: string | undefined,
  expr: string,
  marker: string,
): string {
  if (failure === undefined) return expr;
  return `CASE WHEN EXISTS { MATCH ${match} WHERE ${and([predicate, failure])} } THEN ${marker} ELSE ${expr} END`;
}

/**
 * Clauses to run before the expression of a projection is evaluated (in the same query part, right
 * before its `RETURN`): subqueries that contain a `@cypher` statement are hoisted there (see
 * `custom.ts`).
 */
export type Scope = string[];

/**
 * `@cypher` sort values computed before an `ORDER BY` (`CALL` clauses) and the variables holding
 * them, by `<variable>.<field>`: a projection of the same field reuses the value, like v7.
 */
type SortScope = { clauses: string[]; vars: Map<string, string> };

function sortScope(): SortScope {
  return { clauses: [], vars: new Map() };
}

/** What the compiler needs from `GraphQLResolveInfo`. */
export type SelectionInfo = {
  readonly schema: GraphQLSchema;
  readonly fragments: Record<string, FragmentDefinitionNode>;
  readonly variableValues: Record<string, unknown>;
};

export type CompiledQuery = {
  readonly cypher: string;
  readonly params: Record<string, unknown>;
  /** Turns the returned records (`this` column) into the field's GraphQL value. */
  readonly decode: (rows: readonly unknown[]) => unknown;
};

const CURSOR_PREFIX = "arrayconnection:";

export function offsetToCursor(offset: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${offset}`, "utf8").toString("base64");
}

/** Offset of the cursor, or `undefined` when it is not a valid v7 cursor (first page then). */
export function cursorToOffset(cursor: unknown): number | undefined {
  if (typeof cursor !== "string") return undefined;
  const decoded = Buffer.from(cursor, "base64").toString("utf8");
  if (!decoded.startsWith(CURSOR_PREFIX)) return undefined;
  const n = Number(decoded.slice(CURSOR_PREFIX.length));
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Fields of a selection set, merged by response key (aliases), fragments and @skip/@include applied. */
export function collectFields(
  info: SelectionInfo,
  sets: readonly (SelectionSetNode | undefined)[],
  out = new Map<string, FieldNode[]>(),
): Map<string, FieldNode[]> {
  for (const set of sets) {
    for (const sel of set?.selections ?? []) {
      const skip = getDirectiveValues(GraphQLSkipDirective, sel, info.variableValues);
      if (skip?.if === true) continue;
      const include = getDirectiveValues(GraphQLIncludeDirective, sel, info.variableValues);
      if (include?.if === false) continue;
      if (sel.kind === Kind.FIELD) {
        const key = sel.alias?.value ?? sel.name.value;
        const list = out.get(key) ?? [];
        list.push(sel);
        out.set(key, list);
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        collectFields(info, [sel.selectionSet], out);
      } else {
        const frag = info.fragments[sel.name.value];
        if (frag) collectFields(info, [frag.selectionSet], out);
      }
    }
  }
  return out;
}

export function subSelections(nodes: readonly FieldNode[]): (SelectionSetNode | undefined)[] {
  return nodes.map((n) => n.selectionSet);
}

/**
 * The selections of a union-typed selection set that apply to the member `type`: fields, and the
 * fragments on the member or on the union (fragment spreads become inline fragments, keeping their
 * `@skip` / `@include`). Nested field selections are left as they are.
 */
function narrowSelectionSet(
  info: SelectionInfo,
  set: SelectionSetNode,
  type: string,
  union: string,
): SelectionSetNode {
  const applies = (t: string | undefined) => t === undefined || t === type || t === union;
  const selections: SelectionNode[] = [];
  for (const sel of set.selections) {
    if (sel.kind === Kind.FIELD) {
      selections.push(sel);
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      if (!applies(sel.typeCondition?.name.value)) continue;
      selections.push({
        ...sel,
        typeCondition: undefined,
        selectionSet: narrowSelectionSet(info, sel.selectionSet, type, union),
      });
    } else {
      const frag = info.fragments[sel.name.value];
      if (!frag || !applies(frag.typeCondition.name.value)) continue;
      selections.push({
        kind: Kind.INLINE_FRAGMENT,
        directives: sel.directives,
        selectionSet: narrowSelectionSet(info, frag.selectionSet, type, union),
      });
    }
  }
  return { kind: Kind.SELECTION_SET, selections };
}

/** The field nodes of a union-typed field, with only the selections that apply to `type`. */
export function narrowFieldNodes(
  info: SelectionInfo,
  nodes: readonly FieldNode[],
  type: string,
  union: string,
): FieldNode[] {
  return nodes.map((n) =>
    n.selectionSet
      ? { ...n, selectionSet: narrowSelectionSet(info, n.selectionSet, type, union) }
      : n,
  );
}

/** Hidden keys of union rows (not GraphQL names, like {@link FORBIDDEN_KEY}). */
const TYPE_KEY = "cyphra:type";
const ID_KEY = "cyphra:id";
const SORT_KEY = "cyphra:sort";

/** `[offset..offset + limit]` / `[offset..]`: v7 ignores `0` (and missing) values. */
function slice(ctx: CypherContext, offset: unknown, limit: unknown): string {
  const o =
    typeof offset === "number" && offset > 0 ? ctx.param(neo4j.int(Math.trunc(offset))) : "0";
  if (typeof limit !== "number" || Math.trunc(limit) === 0) return `[${o}..]`;
  const l = ctx.param(neo4j.int(Math.max(0, Math.trunc(limit))));
  return `[${o}..${o === "0" ? l : `${o} + ${l}`}]`;
}

/** `pageInfo` of a connection page. */
function pageInfoValue(
  info: SelectionInfo,
  nodes: readonly FieldNode[],
  offset: number,
  count: number,
  total: number,
): AnyRecord {
  const out: AnyRecord = {};
  for (const [pk, pn] of collectFields(info, subSelections(nodes))) {
    switch (pn[0]!.name.value) {
      case "hasNextPage":
        out[pk] = offset + count < total;
        break;
      case "hasPreviousPage":
        out[pk] = offset > 0;
        break;
      case "startCursor":
        out[pk] = count ? offsetToCursor(offset) : null;
        break;
      case "endCursor":
        out[pk] = count ? offsetToCursor(offset + count - 1) : null;
        break;
    }
  }
  return out;
}

function objectType(info: SelectionInfo, name: string): GraphQLObjectType {
  return info.schema.getType(name) as GraphQLObjectType;
}

function fieldArgs(
  field: GraphQLField<unknown, unknown>,
  node: FieldNode,
  info: SelectionInfo,
): AnyRecord {
  return getArgumentValues(field, node, info.variableValues);
}

function mapValue(v: unknown, f: (x: unknown) => unknown): unknown {
  if (v === null || v === undefined) return null;
  return Array.isArray(v) ? v.map(f) : f(v);
}

function integerToNumber(x: unknown): unknown {
  return isInt(x) ? x.toNumber() : x;
}

function attributeDecoder(a: Pick<Attribute, "kind" | "type">): Decoder {
  if (a.kind === "scalar" && a.type.name === "BigInt") {
    return (v) => mapValue(v, (x) => (isInt(x) ? x.toString() : x));
  }
  if (a.kind === "scalar" && (a.type.name === "Int" || a.type.name === "Float")) {
    return (v) => mapValue(v, integerToNumber);
  }
  return (v) => v ?? null;
}

function toFloat(v: unknown): number {
  return isInt(v) ? v.toNumber() : Number(v);
}

function toNumber(v: unknown): number {
  return isInt(v) ? v.toNumber() : Number(v);
}

function intParam(ctx: CypherContext, value: unknown): string | undefined {
  if (typeof value !== "number") return undefined;
  return ctx.param(neo4j.int(Math.max(0, Math.trunc(value))));
}

/**
 * The page size of a read of `node` (v7 `getOptions` / `getConnectionOptions`): the requested
 * `limit` / `first`, else `@limit(default)`, else `@limit(max)`, capped by `@limit(max)`.
 *
 * Deliberate difference with v7: v7 ignores a requested `0` after applying `@limit`, so `limit: 0`
 * / `first: 0` returned every node and bypassed `max`. Here `0` counts as "not given" on a type with
 * `@limit`, so `max` always holds. Without `@limit`, `0` still means "no limit" (like v7).
 */
export function pageLimit(node: NodeType | undefined, requested: unknown): unknown {
  const l = node?.limit;
  if (!l) return requested;
  const given =
    typeof requested === "number" && Math.trunc(requested) !== 0 ? requested : undefined;
  const limit = given ?? l.default ?? l.max;
  return limit !== undefined && l.max !== undefined ? Math.min(limit, l.max) : limit;
}

function paging(ctx: CypherContext, offset: unknown, limit: unknown): string {
  const parts: string[] = [];
  const o = intParam(ctx, offset);
  if (o) parts.push(`SKIP ${o}`);
  const l = intParam(ctx, limit);
  if (l) parts.push(`LIMIT ${l}`);
  return parts.join(" ");
}

/**
 * `WITH vars ORDER BY … SKIP … LIMIT …`, or nothing when there is no order and no paging. The
 * `@cypher` sort values are carried along for the projection.
 */
function withClause(vars: string, order: string, page: string, sort?: SortScope): string {
  if (!order && !page) return "";
  const all = [vars, ...(sort ? sort.vars.values() : [])].join(", ");
  return ["WITH", all, order, page].filter(Boolean).join(" ");
}

const AGGREGATE_FUNCTIONS: Record<string, ListAggregate> = {
  min: "min",
  max: "max",
  average: "avg",
  sum: "sum",
};

/**
 * Result of one aggregate (`IntAggregateSelection.average`, …): Int min / max / sum are Int and
 * `average` a Float; BigInt values are strings (the `BigInt` scalar serializes an `average` float).
 */
function aggregateValueDecoder(type: string): Decoder {
  if (type === "Int" || type === "Float") return (v) => mapValue(v, integerToNumber);
  if (type === "BigInt") return (v) => mapValue(v, (x) => (isInt(x) ? x.toString() : x));
  return (v) => v ?? null;
}

function mapDecoder(decoders: readonly [string, Decoder][]): Decoder {
  return (raw) => {
    const r = (raw ?? {}) as AnyRecord;
    const out: AnyRecord = {};
    for (const [key, dec] of decoders) out[key] = dec(r[key]);
    return out;
  };
}

export class SelectionCompiler {
  readonly ctx = new CypherContext();
  private readonly where: WhereCompiler;
  readonly rules: AuthRules;

  constructor(
    private readonly model: V7Model,
    private readonly info: SelectionInfo,
    readonly auth: AuthContext,
  ) {
    this.where = new WhereCompiler(model, this.ctx);
    this.rules = new AuthRules(model, this.ctx, auth);
    this.ctx.jwt = auth.jwt ?? {};
  }

  /**
   * `COLLECT { <body> RETURN ret }` / `COUNT { <body> }` / `EXISTS { <body> }` as an expression or,
   * when the subquery contains a `@cypher` statement, hoisted into `scope` as
   * `CALL (*) { <body> RETURN collect(ret) | count(*) AS v }` (the variable is the value).
   */
  subquery(
    scope: Scope,
    kind: "collect" | "count" | "exists",
    body: readonly string[],
    ret?: string,
  ): string {
    const text = body.filter(Boolean).join(" ");
    if (!hasStatement(text, ret)) {
      if (kind === "collect") return `COLLECT { ${text} RETURN ${ret} }`;
      if (kind === "count") return `COUNT { ${text}${ret ? ` RETURN ${ret}` : ""} }`;
      return `EXISTS { ${text} }`;
    }
    const v = this.ctx.variable("sub");
    const agg =
      kind === "collect" ? `collect(${ret})` : kind === "count" ? "count(*)" : "count(*) > 0";
    scope.push(["CALL (*) {", text, `RETURN ${agg} AS ${v}`, "}"].join("\n"));
    return v;
  }

  /** {@link gate} with the existence check hoisted when it contains a statement. */
  private gate(
    scope: Scope,
    match: string,
    predicate: string | undefined,
    failure: string | undefined,
    expr: string,
    marker: string,
  ): string {
    if (failure === undefined) return expr;
    if (!hasStatement(predicate, failure)) return gate(match, predicate, failure, expr, marker);
    const denied = this.subquery(scope, "exists", [
      `MATCH ${match} WHERE ${and([predicate, failure])}`,
    ]);
    return `CASE WHEN ${denied} THEN ${marker} ELSE ${expr} END`;
  }

  /** {@link rowGate} with the check hoisted when it contains a statement. */
  private rowGate(scope: Scope, failure: string | undefined, expr: string, marker: string): string {
    if (failure === undefined || !hasStatement(failure)) return rowGate(failure, expr, marker);
    const denied = this.subquery(scope, "exists", [`WITH * WHERE ${failure}`]);
    return `CASE WHEN ${denied} THEN ${marker} ELSE ${expr} END`;
  }

  /** `@authentication` for `operation` on the type (and on each of `fields`). */
  authenticate(
    node: NodeType,
    operation: "READ" | "AGGREGATE",
    fields: readonly string[] = [],
  ): void {
    checkAuthentication(this.model, this.auth, node, [operation]);
    for (const f of fields) checkAuthentication(this.model, this.auth, node, [operation], f);
  }

  /**
   * The fields selected on `node`, merged by response key, with the `requires` selection of every
   * selected `@customResolver` field (v7 merges it in, so the resolver's parent always has it).
   */
  nodeSelection(node: NodeType, fieldNodes: readonly FieldNode[]): Map<string, FieldNode[]> {
    const sets = subSelections(fieldNodes);
    const fields = collectFields(this.info, sets);
    if (!node.userFields.length) return fields;
    const names = new Set([...fields.values()].map((n) => n[0]!.name.value));
    const requires = node.userFields.flatMap((f) =>
      f.requires && names.has(f.name) ? [f.requires] : [],
    );
    return requires.length ? collectFields(this.info, [...sets, ...requires]) : fields;
  }

  /** Attributes of `node` selected in `fieldNodes` (they bring their field-level rules). */
  selectedAttributes(node: NodeType, fieldNodes: readonly FieldNode[]): Attribute[] {
    const names = new Set(
      [...this.nodeSelection(node, fieldNodes).values()].map((n) => n[0]!.name.value),
    );
    return node.attributes.filter((a) => names.has(a.name));
  }

  /**
   * READ rules of a node selection: the `filter` predicate and the `validate` failure (BEFORE) for
   * the type and the selected attributes.
   */
  readRules(
    variable: string,
    node: NodeType,
    fieldNodes: readonly FieldNode[],
  ): { filter?: string; failure?: string } {
    if (isInterface(node)) {
      // The rules of each implementation, with the fields selected on it (fragments included).
      const attrsOf = (impl: NodeType) =>
        this.selectedAttributes(
          impl,
          narrowFieldNodes(this.info, fieldNodes, impl.name, node.name),
        );
      return {
        filter: this.rules.perImplementation(variable, node, [], (impl) =>
          this.rules.filter(variable, impl, "READ", attrsOf(impl)),
        ),
        failure: this.rules.perImplementation(variable, node, [], (impl) =>
          this.rules.fails(variable, impl, "READ", "BEFORE", attrsOf(impl)),
        ),
      };
    }
    const attrs = this.selectedAttributes(node, fieldNodes);
    return {
      filter: this.rules.filter(variable, node, "READ", attrs),
      failure: this.rules.fails(variable, node, "READ", "BEFORE", attrs),
    };
  }

  /** `[marker]` for a list selection that is not allowed. */
  forbiddenList(): string {
    return `[${FORBIDDEN_MARKER}]`;
  }

  forbiddenMap(): string {
    return FORBIDDEN_MARKER;
  }

  private sortItems(
    variable: string,
    attributes: readonly Attribute[],
    sort: unknown,
    owner: string,
    pre: SortScope,
  ): string[] {
    const items: string[] = [];
    if (sort === null || typeof sort !== "object") return items;
    for (const [field, dir] of Object.entries(sort as AnyRecord)) {
      if (dir !== "ASC" && dir !== "DESC") continue;
      const a = attributes.find((x) => x.name === field);
      if (!a) throw new Error(`Unknown sort field ${owner}.${field}`);
      if (a.cypher) {
        items.push(`${this.sortValue(variable, a, pre)} ${dir}`);
        continue;
      }
      items.push(`${property(variable, a)} ${dir}`);
    }
    return items;
  }

  /** The variable holding a `@cypher` sort value, computed once per field (v7). */
  private sortValue(variable: string, a: Attribute, pre: SortScope): string {
    const key = `${variable}.${a.name}`;
    let v = pre.vars.get(key);
    if (!v) {
      const c = scalarClause(this.ctx, variable, a.cypher!, a.args, {}, a.type.list);
      pre.clauses.push(c.clause);
      pre.vars.set(key, c.variable);
      v = c.variable;
    }
    return v;
  }

  private nodeOrder(variable: string, node: NodeType, sort: unknown, pre: SortScope): string {
    const items = (Array.isArray(sort) ? sort : []).flatMap((s) =>
      this.sortItems(variable, node.attributes, s, node.name, pre),
    );
    return items.length ? `ORDER BY ${items.join(", ")}` : "";
  }

  private connectionOrder(
    relVar: string,
    nodeVar: string,
    rel: Relationship,
    sort: unknown,
    pre: SortScope,
  ): string {
    const target = this.model.node(rel.target);
    const props = this.props(rel);
    const items: string[] = [];
    for (const s of Array.isArray(sort) ? sort : []) {
      if (s === null || typeof s !== "object") continue;
      for (const [k, v] of Object.entries(s as AnyRecord)) {
        if (k === "node")
          items.push(...this.sortItems(nodeVar, target.attributes, v, target.name, pre));
        else if (k === "edge" && props) {
          // `edge: { ContainsProperties: … }` on relationships an interface declares.
          const edge = edgeValue(props, keyedConnectionEdge(this.model, rel), v);
          items.push(...this.sortItems(relVar, props.attributes, edge, props.name, pre));
        }
      }
    }
    return items.length ? `ORDER BY ${items.join(", ")}` : "";
  }

  /**
   * The value of a scalar `@cypher` field of `variable` for the response key: the sort value when
   * the field was sorted on (same field, no arguments), else a new `CALL` clause in `scope`.
   */
  private cypherValue(
    scope: Scope,
    variable: string,
    attr: Attribute,
    fieldNode: FieldNode,
    gqlType: GraphQLObjectType,
    pre?: SortScope,
  ): string {
    const reused = attr.args.length ? undefined : pre?.vars.get(`${variable}.${attr.name}`);
    if (reused) return reused;
    const values = attr.args.length
      ? fieldArgs(gqlType.getFields()[attr.name]!, fieldNode, this.info)
      : {};
    const c = scalarClause(this.ctx, variable, attr.cypher!, attr.args, values, attr.type.list);
    scope.push(c.clause);
    return c.variable;
  }

  private props(rel: Relationship): PropertiesType | undefined {
    return rel.properties ? this.model.properties.get(rel.properties) : undefined;
  }

  /** `{ key: expr, … }` for a selection on a node variable, and its decoder. */
  projectNode(
    variable: string,
    node: NodeType,
    fieldNodes: readonly FieldNode[],
    scope: Scope,
    pre?: SortScope,
    /** Entries added to the projected map (the hidden keys of union rows). */
    extra: readonly string[] = [],
  ): { expr: string; decode: Decoder } {
    if (isInterface(node))
      return this.projectInterface(variable, node, fieldNodes, scope, pre, extra);
    const selection = this.nodeSelection(node, fieldNodes);
    const fields = [...selection.values()].map((n) => n[0]!.name.value);
    this.authenticate(node, "READ", fields);
    const type = objectType(this.info, node.name);
    const gqlFields = type.getFields();
    const entries: string[] = [...extra];
    const decoders: [string, Decoder][] = [];
    for (const [key, nodes] of selection) {
      const name = nodes[0]!.name.value;
      if (name === "__typename") continue;
      // Served by the application's resolvers (with the parent): not in the statement.
      if (node.userFields.some((f) => f.name === name)) continue;
      const attr = node.attributes.find((a) => a.name === name);
      if (attr) {
        const value = attr.cypher
          ? this.cypherValue(scope, variable, attr, nodes[0]!, type, pre)
          : `${variable}.${q(attr.property)}`;
        entries.push(`${q(key)}: ${value}`);
        decoders.push([key, attributeDecoder(attr)]);
        continue;
      }
      const gqlField = gqlFields[name];
      if (!gqlField) throw new Error(`Unknown field ${node.name}.${name}`);
      const args = fieldArgs(gqlField, nodes[0]!, this.info);
      const cypherNode = node.cypherNodes.find((c) => c.name === name);
      if (cypherNode) {
        const p = this.cypherNodeField(scope, variable, cypherNode, args, nodes);
        entries.push(`${q(key)}: ${p.expr}`);
        decoders.push([key, p.decode]);
        continue;
      }
      const rel = node.relationships.find((r) => r.name === name);
      if (rel) {
        const p = isUnionRelationship(this.model, rel)
          ? this.unionList(scope, variable, rel, args, nodes)
          : this.relationshipList(scope, variable, rel, args, nodes);
        if (rel.list) {
          entries.push(`${q(key)}: ${p.expr}`);
          decoders.push([key, p.decode]);
          continue;
        }
        // To-one (v7: `head(collect(…))`): the first related node, or null.
        entries.push(`${q(key)}: head(${p.expr})`);
        decoders.push([
          key,
          (raw) => (raw === null || raw === undefined ? null : (p.decode([raw]) as unknown[])[0]),
        ]);
        continue;
      }
      const connRel = name.endsWith("Connection")
        ? node.relationships.find((r) => `${r.name}Connection` === name)
        : undefined;
      if (connRel) {
        const p = isUnionRelationship(this.model, connRel)
          ? this.unionConnection(scope, variable, connRel, args, nodes)
          : this.relationshipConnection(scope, variable, connRel, args, nodes);
        entries.push(`${q(key)}: ${p.expr}`);
        decoders.push([key, p.decode]);
        continue;
      }
      throw new Error(`Unknown field ${node.name}.${name}`);
    }
    return {
      expr: `{ ${entries.join(", ")} }`,
      decode: (raw) => {
        const r = (raw ?? {}) as AnyRecord;
        const out: AnyRecord = {};
        for (const [key, dec] of decoders) out[key] = dec(r[key]);
        return out;
      },
    };
  }

  /**
   * The projection of a node of an interface: `CASE WHEN v:Lab THEN { <Lab projection> } WHEN …
   * END`, each implementation with the selections that apply to it (fragments on it or on the
   * interface), and its type in the row for `__typename` / type resolution.
   */
  private projectInterface(
    variable: string,
    iface: InterfaceType,
    fieldNodes: readonly FieldNode[],
    scope: Scope,
    pre: SortScope | undefined,
    extra: readonly string[],
  ): { expr: string; decode: Decoder } {
    const decoders = new Map<string, Decoder>();
    const whens = iface.implementations.map((name, i) => {
      const impl = this.model.node(name);
      const nodes = narrowFieldNodes(this.info, fieldNodes, name, iface.name);
      const p = this.projectNode(variable, impl, nodes, scope, pre, [
        ...extra,
        `${q(TYPE_KEY)}: ${this.ctx.param(name)}`,
      ]);
      decoders.set(name, p.decode);
      return `WHEN ${variable}${labels(iface.labelSets[i]!)} THEN ${p.expr}`;
    });
    return { expr: `CASE ${whens.join(" ")} END`, decode: this.unionDecoder(decoders) };
  }

  private projectProperties(
    relVar: string,
    props: PropertiesType,
    fieldNodes: readonly FieldNode[],
    scope: Scope,
    pre?: SortScope,
  ): { expr: string; decode: Decoder } {
    const entries: string[] = [];
    const decoders: [string, Decoder][] = [];
    const type = objectType(this.info, props.name);
    // `properties` may be a union of properties types (relationships an interface declares):
    // only the fragments on this type apply.
    const narrowed = narrowFieldNodes(this.info, fieldNodes, props.name, props.name);
    for (const [key, nodes] of collectFields(this.info, subSelections(narrowed))) {
      const name = nodes[0]!.name.value;
      if (name === "__typename") continue;
      const attr = props.attributes.find((a) => a.name === name);
      if (!attr) throw new Error(`Unknown field ${props.name}.${name}`);
      const value = attr.cypher
        ? this.cypherValue(scope, relVar, attr, nodes[0]!, type, pre)
        : `${relVar}.${q(attr.property)}`;
      entries.push(`${q(key)}: ${value}`);
      decoders.push([key, attributeDecoder(attr)]);
    }
    return {
      expr: `{ ${entries.join(", ")} }`,
      decode: (raw) => {
        const r = (raw ?? {}) as AnyRecord;
        // The type, for `properties` unions (`LearningActivityTracksRelationshipProperties`).
        const out: AnyRecord = { __typename: props.name };
        for (const [key, dec] of decoders) out[key] = dec(r[key]);
        return out;
      },
    };
  }

  private relationshipList(
    scope: Scope,
    variable: string,
    rel: Relationship,
    args: AnyRecord,
    fieldNodes: readonly FieldNode[],
  ): { expr: string; decode: Decoder } {
    const target = this.model.node(rel.target);
    const m = this.ctx.variable("this");
    const pattern = relationshipPattern(this.model, variable, rel, m);
    const auth = this.readRules(m, target, fieldNodes);
    const pred = and([this.where.node(m, target, args.where), auth.filter]);
    const pre = sortScope();
    const order = this.nodeOrder(m, target, args.sort, pre);
    const page = paging(this.ctx, args.offset, pageLimit(target, args.limit));
    const inner: Scope = [];
    const proj = this.projectNode(m, target, fieldNodes, inner, pre);
    const row = this.rowGate(inner, auth.failure, proj.expr, this.forbiddenMap());
    const body = [
      `MATCH ${pattern}`,
      pred ? `WHERE ${pred}` : "",
      ...pre.clauses,
      withClause(m, order, page, pre),
      ...inner,
    ];
    const list = this.subquery(scope, "collect", body, row);
    return {
      expr: this.gate(scope, pattern, pred, auth.failure, list, this.forbiddenList()),
      decode: (raw) => (Array.isArray(raw) ? raw.map(proj.decode) : []),
    };
  }

  /**
   * A `@cypher` field returning nodes: `CALL (v) { <statement> WITH col AS n WHERE n IS NOT NULL
   * AND <READ filter> … RETURN collect(<projection>) AS s }` (`head(…)` for one node). The READ rules
   * of the returned type apply (a node failing `validate` makes the field `Forbidden`), like v7.
   */
  private cypherNodeField(
    scope: Scope,
    variable: string,
    field: CypherNodeField,
    args: AnyRecord,
    fieldNodes: readonly FieldNode[],
  ): { expr: string; decode: Decoder } {
    const target = this.model.node(field.target);
    const call = statementCall(this.ctx, field.cypher, field.args, args, variable);
    const p = this.cypherNodes(call, field.cypher, target, fieldNodes, field.type.list);
    const s = this.ctx.variable("cypher");
    const value = field.type.list ? `collect(${p.row})` : `head(collect(${p.row}))`;
    scope.push([`CALL (${variable}) {`, ...p.clauses, `RETURN ${value} AS ${s}`, "}"].join("\n"));
    return {
      expr: s,
      decode: field.type.list
        ? (raw) => (Array.isArray(raw) ? raw.map(p.decode) : [])
        : (raw) => (raw === null || raw === undefined ? null : p.decode(raw)),
    };
  }

  /**
   * Clauses that run a statement returning nodes and keep the readable ones (`WHERE n IS NOT NULL
   * AND <READ filter>`), and the projection of one row (or the forbidden marker).
   */
  private cypherNodes(
    call: string,
    cypher: CypherAnnotation,
    target: NodeType,
    fieldNodes: readonly FieldNode[],
    list: boolean,
  ): { clauses: string[]; row: string; decode: Decoder } {
    const n = this.ctx.variable("this");
    const auth = this.readRules(n, target, fieldNodes);
    const inner: Scope = [];
    const proj = this.projectNode(n, target, fieldNodes, inner);
    const row = this.rowGate(inner, auth.failure, proj.expr, this.forbiddenMap());
    // v7 applies the type's `@limit` to `@cypher` fields returning a list of it.
    const page = list ? paging(this.ctx, undefined, pageLimit(target, undefined)) : "";
    return {
      clauses: [
        call,
        `WITH ${column(cypher)} AS ${n} WHERE ${and([`${n} IS NOT NULL`, auth.filter])}`,
        ...(page ? [`WITH ${n} ${page}`] : []),
        ...inner,
      ],
      row,
      decode: proj.decode,
    };
  }

  /**
   * A connection over `match` (a pattern binding `nodeVar` and, for relationships, `relVar`):
   * `{ total: COUNT { … }, edges: COLLECT { … } }` and the decoder that builds edges, cursors and
   * `pageInfo` from the selection.
   */
  private connection(opts: {
    scope: Scope;
    match: string;
    /** The connection `where`. */
    predicate?: string;
    order: string;
    /** `@cypher` sort values (computed after the `MATCH`, before the `ORDER BY`). */
    pre: SortScope;
    nodeVar: string;
    relVar?: string;
    projectNode: (
      fieldNodes: readonly FieldNode[],
      scope: Scope,
      pre: SortScope,
    ) => { expr: string; decode: Decoder };
    projectProperties?: (
      fieldNodes: readonly FieldNode[],
      scope: Scope,
      pre: SortScope,
    ) => { expr: string; decode: Decoder };
    /** Node type and relationship properties the `aggregate` selection aggregates over. */
    node: NodeType;
    props?: PropertiesType;
    args: AnyRecord;
    fieldNodes: readonly FieldNode[];
    owner: string;
  }): { expr: string; decode: Decoder } {
    const afterOffset = cursorToOffset(opts.args.after);
    const offset = afterOffset === undefined ? 0 : afterOffset + 1;
    const conn = collectFields(this.info, subSelections(opts.fieldNodes));
    // v7: READ authentication of the type for every connection, READ rules on `totalCount` /
    // `edges` (with the attributes selected in `edges.node`), AGGREGATE rules on `aggregate`.
    this.authenticate(opts.node, "READ");
    const edgeNodeFields = [...collectFields(this.info, subSelections(conn.get("edges") ?? []))]
      .filter(([, n]) => n[0]!.name.value === "node")
      .flatMap(([, n]) => n);
    const readAuth = this.readRules(opts.nodeVar, opts.node, edgeNodeFields);
    const readPredicate = and([opts.predicate, readAuth.filter]);

    const edgeEntries: string[] = [];
    const edgeDecoders: [string, (raw: AnyRecord, index: number) => unknown][] = [];
    const edgeFieldNodes: FieldNode[] = [];
    const aggregates: [string, Decoder][] = [];
    const aggregateEntries: string[] = [];
    let needsTotal = false;
    let needsEdges = false;
    const where = readPredicate ? ` WHERE ${readPredicate}` : "";
    for (const [key, nodes] of conn) {
      const name = nodes[0]!.name.value;
      if (name === "aggregate") {
        const aggNodeFields = [...collectFields(this.info, subSelections(nodes))]
          .filter(([, n]) => n[0]!.name.value === "node")
          .flatMap(([, n]) => n);
        const aggAttrs = this.selectedAttributes(opts.node, aggNodeFields);
        this.authenticate(
          opts.node,
          "AGGREGATE",
          aggAttrs.map((a) => a.name),
        );
        const aggPredicate = and([
          opts.predicate,
          this.rules.filter(opts.nodeVar, opts.node, "AGGREGATE", aggAttrs),
        ]);
        const aggFailure = this.rules.fails(
          opts.nodeVar,
          opts.node,
          "AGGREGATE",
          "BEFORE",
          aggAttrs,
        );
        const p = this.aggregate(
          {
            scope: opts.scope,
            base: `MATCH ${opts.match}${aggPredicate ? ` WHERE ${aggPredicate}` : ""}`,
            nodeVar: opts.nodeVar,
            relVar: opts.relVar,
            node: opts.node,
            props: opts.props,
            owner: opts.owner,
          },
          nodes,
        );
        aggregateEntries.push(
          `${q(key)}: ${this.gate(opts.scope, opts.match, aggPredicate, aggFailure, p.expr, this.forbiddenMap())}`,
        );
        aggregates.push([key, p.decode]);
      }
      if (name === "edges") edgeFieldNodes.push(...nodes);
      if (name === "edges" || name === "pageInfo") needsEdges = true;
      if (name === "totalCount" || name === "pageInfo") needsTotal = true;
    }
    const edgeScope: Scope = [];
    for (const [key, nodes] of collectFields(this.info, subSelections(edgeFieldNodes))) {
      const name = nodes[0]!.name.value;
      if (name === "cursor") {
        edgeDecoders.push([key, (_raw, i) => offsetToCursor(offset + i)]);
      } else if (name === "node") {
        const p = opts.projectNode(nodes, edgeScope, opts.pre);
        edgeEntries.push(`${q(key)}: ${p.expr}`);
        edgeDecoders.push([key, (raw) => p.decode(raw[key])]);
      } else if (name === "properties" && opts.projectProperties) {
        const p = opts.projectProperties(nodes, edgeScope, opts.pre);
        edgeEntries.push(`${q(key)}: ${p.expr}`);
        edgeDecoders.push([key, (raw) => p.decode(raw[key])]);
      }
    }

    const withVars = opts.relVar ? `${opts.relVar}, ${opts.nodeVar}` : opts.nodeVar;
    const page = paging(this.ctx, offset || undefined, pageLimit(opts.node, opts.args.first));
    const edgeRow = this.rowGate(
      edgeScope,
      needsEdges ? readAuth.failure : undefined,
      `{ ${edgeEntries.join(", ")} }`,
      this.forbiddenMap(),
    );
    const edgesBody = [
      `MATCH ${opts.match}${where}`,
      ...opts.pre.clauses,
      withClause(withVars, opts.order, page, opts.pre),
      ...edgeScope,
    ];
    const parts: string[] = [];
    if (needsTotal)
      parts.push(`total: ${this.subquery(opts.scope, "count", [`MATCH ${opts.match}${where}`])}`);
    if (needsEdges)
      parts.push(`edges: ${this.subquery(opts.scope, "collect", edgesBody, edgeRow)}`);
    if (aggregateEntries.length) parts.push(`aggregate: { ${aggregateEntries.join(", ")} }`);
    const map = `{ ${parts.join(", ")} }`;
    const expr =
      needsTotal || needsEdges
        ? this.gate(
            opts.scope,
            opts.match,
            readPredicate,
            readAuth.failure,
            map,
            this.forbiddenMap(),
          )
        : map;

    return {
      expr,
      decode: (raw) => {
        const r = (raw ?? {}) as AnyRecord;
        const total = toNumber(r.total ?? 0);
        const rawEdges = (Array.isArray(r.edges) ? r.edges : []) as AnyRecord[];
        const edges = rawEdges.map((e, i) => {
          const out: AnyRecord = {};
          for (const [key, dec] of edgeDecoders) out[key] = dec(e ?? {}, i);
          return out;
        });
        const out: AnyRecord = {};
        for (const [key, nodes] of conn) {
          const name = nodes[0]!.name.value;
          if (name === "totalCount") out[key] = total;
          else if (name === "edges") out[key] = edges;
          else if (name === "aggregate") {
            const agg = (r.aggregate ?? {}) as AnyRecord;
            out[key] = aggregates.find(([k]) => k === key)![1](agg[key]);
          } else if (name === "pageInfo") {
            const info: AnyRecord = {};
            for (const [pk, pn] of collectFields(this.info, subSelections(nodes))) {
              switch (pn[0]!.name.value) {
                case "hasNextPage": {
                  // v7 computes it from the requested `first` (not the `@limit` page size).
                  const first = opts.args.first;
                  info[pk] = !opts.node.limit
                    ? offset + edges.length < total
                    : typeof first === "number"
                      ? offset + (first || edges.length) < total
                      : false;
                  break;
                }
                case "hasPreviousPage":
                  info[pk] = offset > 0;
                  break;
                case "startCursor":
                  info[pk] = edges.length ? offsetToCursor(offset) : null;
                  break;
                case "endCursor":
                  info[pk] = edges.length ? offsetToCursor(offset + edges.length - 1) : null;
                  break;
              }
            }
            out[key] = info;
          }
        }
        return out;
      },
    };
  }

  /**
   * `{ count: …, node: { field: … }, edge: { field: … } }` for a connection `aggregate` selection:
   * one `COUNT { … }` per count and one `COLLECT { … }` of the values per field (reduced with list
   * expressions, see `listAggregate`), like v7's one subquery per field.
   */
  private aggregate(
    scope: {
      scope: Scope;
      /** `MATCH <pattern> [WHERE <connection where>]`. */
      base: string;
      nodeVar: string;
      relVar?: string;
      node: NodeType;
      props?: PropertiesType;
      owner: string;
    },
    fieldNodes: readonly FieldNode[],
  ): { expr: string; decode: Decoder } {
    const entries: string[] = [];
    const decoders: [string, Decoder][] = [];
    for (const [key, nodes] of collectFields(this.info, subSelections(fieldNodes))) {
      const name = nodes[0]!.name.value;
      if (name === "__typename") continue;
      if (name === "count") {
        const counts: string[] = [];
        const keys: string[] = [];
        for (const [ck, cn] of collectFields(this.info, subSelections(nodes))) {
          const what = cn[0]!.name.value;
          const v = what === "nodes" ? scope.nodeVar : what === "edges" ? scope.relVar : undefined;
          if (!v) continue;
          counts.push(
            `${q(ck)}: ${this.subquery(scope.scope, "count", [scope.base, `WITH DISTINCT ${v}`], v)}`,
          );
          keys.push(ck);
        }
        entries.push(`${q(key)}: { ${counts.join(", ")} }`);
        decoders.push([
          key,
          (raw) => {
            const r = (raw ?? {}) as AnyRecord;
            return Object.fromEntries(keys.map((k) => [k, toNumber(r[k] ?? 0)]));
          },
        ]);
        continue;
      }
      const isEdge = name === "edge";
      if (name !== "node" && !isEdge)
        throw new Error(`Unknown field ${scope.owner}.aggregate.${name}`);
      const variable = isEdge ? scope.relVar : scope.nodeVar;
      const attributes = isEdge ? scope.props?.attributes : scope.node.attributes;
      if (!variable || !attributes)
        throw new Error(`Unknown field ${scope.owner}.aggregate.${name}`);
      const fieldEntries: string[] = [];
      const fieldDecoders: [string, Decoder][] = [];
      for (const [fk, fn] of collectFields(this.info, subSelections(nodes))) {
        const field = fn[0]!.name.value;
        if (field === "__typename") continue;
        const attr = attributes.find((a) => a.name === field);
        if (!attr) throw new Error(`Unknown field ${scope.owner}.aggregate.${name}.${field}`);
        const p = this.aggregateAttribute(scope.scope, scope.base, variable, attr, fn);
        fieldEntries.push(`${q(fk)}: ${p.expr}`);
        fieldDecoders.push([fk, p.decode]);
      }
      entries.push(`${q(key)}: { ${fieldEntries.join(", ")} }`);
      decoders.push([key, mapDecoder(fieldDecoders)]);
    }
    return { expr: `{ ${entries.join(", ")} }`, decode: mapDecoder(decoders) };
  }

  /** `min` / `max` / `average` / `sum` / `shortest` / `longest` of one attribute, v7 semantics. */
  private aggregateAttribute(
    scope: Scope,
    base: string,
    variable: string,
    attr: Attribute,
    fieldNodes: readonly FieldNode[],
  ): { expr: string; decode: Decoder } {
    const prop = property(variable, attr);
    const type = attr.type.name;
    const ops: [string, string][] = [];
    for (const [k, n] of collectFields(this.info, subSelections(fieldNodes))) {
      const op = n[0]!.name.value;
      if (op !== "__typename") ops.push([k, op]);
    }
    if (ops.length === 0) return { expr: "{}", decode: () => ({}) };
    const decoders: [string, Decoder][] = ops.map(([k]) => [k, aggregateValueDecoder(type)]);
    const l = this.ctx.variable("list");
    const values = `${base} WITH DISTINCT ${variable} WHERE ${prop} IS NOT NULL`;
    if (type === "String") {
      // v7: ordered by size descending, `longest` is the first value and `shortest` the last.
      const list = this.subquery(
        scope,
        "collect",
        [values, `WITH ${variable} ORDER BY size(${prop}) DESC`],
        prop,
      );
      const items = ops.map(
        ([k, op]) =>
          `${q(k)}: ${op === "longest" ? `head(${l})` : op === "shortest" ? `last(${l})` : "null"}`,
      );
      return {
        expr: withList(list, l, () => `{ ${items.join(", ")} }`),
        decode: mapDecoder(decoders),
      };
    }
    const list = this.subquery(scope, "collect", [values], prop);
    const items = ops.map(([k, op]) => {
      const fn = AGGREGATE_FUNCTIONS[op];
      return `${q(k)}: ${fn ? listAggregate(fn, l) : "null"}`;
    });
    return {
      expr: withList(list, l, () => `{ ${items.join(", ")} }`),
      decode: mapDecoder(decoders),
    };
  }

  private relationshipConnection(
    scope: Scope,
    variable: string,
    rel: Relationship,
    args: AnyRecord,
    fieldNodes: readonly FieldNode[],
  ): { expr: string; decode: Decoder } {
    const target = this.model.node(rel.target);
    const m = this.ctx.variable("this");
    const r = this.ctx.variable("edge");
    const props = this.props(rel);
    const pre = sortScope();
    return this.connection({
      scope,
      match: relationshipPattern(this.model, variable, rel, m, r),
      predicate: this.where.connection(r, m, rel, args.where),
      order: this.connectionOrder(r, m, rel, args.sort, pre),
      pre,
      nodeVar: m,
      relVar: r,
      projectNode: (nodes, sc, p) => this.projectNode(m, target, nodes, sc, p),
      projectProperties: props
        ? (nodes, sc, p) => this.projectProperties(r, props, nodes, sc, p)
        : undefined,
      node: target,
      props,
      args,
      fieldNodes,
      owner: `${rel.source}.${rel.name}Connection`,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Unions
  // -------------------------------------------------------------------------------------------

  /**
   * One `UNION` branch per member of a union selection: `MATCH <pattern(member)> WHERE <where of the
   * member> AND <READ filter> … RETURN <row> AS x`. Like v7, `UNION` (not `UNION ALL`) removes
   * identical rows, so rows carry the node's `elementId`: a node reached twice is returned once.
   */
  private unionBranch(opts: {
    member: NodeType;
    union: string;
    match: string;
    nodeVar: string;
    predicate: string | undefined;
    /** Node selections (narrowed to the member) whose READ rules apply. */
    ruleNodes: readonly FieldNode[];
    /** The row, from the scope its subqueries go to. */
    row: (scope: Scope, pre: SortScope) => string;
    out: string;
  }): string {
    const auth = this.readRules(opts.nodeVar, opts.member, opts.ruleNodes);
    const pred = and([opts.predicate, auth.filter]);
    const inner: Scope = [];
    const pre = sortScope();
    const row = this.rowGate(inner, auth.failure, opts.row(inner, pre), this.forbiddenMap());
    return [
      `MATCH ${opts.match}`,
      pred ? `WHERE ${pred}` : "",
      ...pre.clauses,
      ...inner,
      `RETURN ${row} AS ${opts.out}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** `CALL (imports) { <branches joined by UNION> }`, or `undefined` without branches. */
  private unionCall(imports: string, branches: readonly string[]): string | undefined {
    if (!branches.length) return undefined;
    return [`CALL (${imports}) {`, branches.join("\nUNION\n"), "}"].join("\n");
  }

  /** `any(x IN list WHERE x is the forbidden marker)`. */
  private anyForbidden(list: string): string {
    const x = this.ctx.variable("row");
    return `any(${x} IN ${list} WHERE ${x}.${q(FORBIDDEN_KEY)} IS NOT NULL)`;
  }

  /** The hidden `cyphra:type` / `cyphra:id` entries of a member row. */
  private memberKeys(member: NodeType, nodeVar: string): string[] {
    return [
      `${q(TYPE_KEY)}: ${this.ctx.param(member.name)}`,
      `${q(ID_KEY)}: elementId(${nodeVar})`,
    ];
  }

  /** Decodes a member row with its member's decoder, adding `__typename` for `__resolveType`. */
  private unionDecoder(decoders: ReadonlyMap<string, Decoder>): Decoder {
    return (raw) => {
      const r = (raw ?? {}) as AnyRecord;
      const type = r[TYPE_KEY] as string;
      const dec = decoders.get(type);
      if (!dec) throw new Error(`Unknown union member ${String(type)}`);
      return { ...(dec(r) as AnyRecord), __typename: type };
    };
  }

  /**
   * A list of union members (`favorites(where, limit, offset)` or the root `contents(…)`), v7 7.6:
   * one branch per member selected by `where` (see `selectedMembers`), with the member's READ rules;
   * `offset` / `limit` apply to the rows of every branch (no order: unspecified, like v7). A row
   * failing READ `validate` rules makes the field `Forbidden`.
   */
  private unionRows(
    imports: string,
    members: readonly { rel?: Relationship; node: NodeType; where: unknown }[],
    union: string,
    fromVar: string | undefined,
    fieldNodes: readonly FieldNode[],
  ): { call?: string; out: string; decoders: Map<string, Decoder> } {
    const x = this.ctx.variable("member");
    const decoders = new Map<string, Decoder>();
    const branches = members.map(({ rel, node, where }) => {
      const t = this.ctx.variable("this");
      const nodes = narrowFieldNodes(this.info, fieldNodes, node.name, union);
      return this.unionBranch({
        member: node,
        union,
        match:
          rel && fromVar !== undefined
            ? relationshipPattern(this.model, fromVar, rel, t)
            : nodePattern(t, node),
        nodeVar: t,
        predicate: this.where.node(t, node, where),
        ruleNodes: nodes,
        row: (inner) => {
          const p = this.projectNode(t, node, nodes, inner, undefined, this.memberKeys(node, t));
          decoders.set(node.name, p.decode);
          return p.expr;
        },
        out: x,
      });
    });
    return { call: this.unionCall(imports, branches), out: x, decoders };
  }

  private unionList(
    scope: Scope,
    variable: string,
    rel: Relationship,
    args: AnyRecord,
    fieldNodes: readonly FieldNode[],
  ): { expr: string; decode: Decoder } {
    const members = selectedMembers(unionMembers(this.model, rel), args.where).map((m) => ({
      rel: m.rel,
      node: this.model.node(m.rel.target),
      where: m.where,
    }));
    const rows = this.unionRows(variable, members, rel.target, variable, fieldNodes);
    const decode = this.unionDecoder(rows.decoders);
    if (!rows.call) return { expr: "[]", decode: () => [] };
    const all = this.ctx.variable("rows");
    const v = this.ctx.variable("union");
    scope.push(
      [
        AGGREGATE_MARK,
        `CALL (${variable}) {`,
        rows.call,
        `WITH collect(${rows.out}) AS ${all}`,
        `RETURN CASE WHEN ${this.anyForbidden(all)} THEN ${this.forbiddenList()} ELSE ${all}${slice(this.ctx, args.offset, args.limit)} END AS ${v}`,
        "}",
      ].join("\n"),
    );
    return { expr: v, decode: (raw) => (Array.isArray(raw) ? raw.map(decode) : []) };
  }

  /** `contents(where, limit, offset)`: the root query of a union. */
  rootUnion(union: UnionType, args: AnyRecord, fieldNodes: readonly FieldNode[]): CompiledQuery {
    const members = union.members.map((m) => this.model.node(m));
    const where = (args.where ?? undefined) as AnyRecord | undefined;
    const keyed =
      where && Object.keys(where).length
        ? members.filter((m) => where[m.name]).map((m) => ({ node: m, where: where[m.name] }))
        : members.map((m) => ({ node: m, where: undefined }));
    const rows = this.unionRows("", keyed, union.name, undefined, fieldNodes);
    const decode = this.unionDecoder(rows.decoders);
    if (!rows.call)
      return { cypher: "RETURN [] AS this", params: this.ctx.params, decode: () => [] };
    const all = this.ctx.variable("rows");
    return {
      cypher: [
        rows.call,
        `WITH collect(${rows.out}) AS ${all}`,
        `RETURN CASE WHEN ${this.anyForbidden(all)} THEN ${this.forbiddenList()} ELSE ${all}${slice(this.ctx, args.offset, args.limit)} END AS this`,
      ].join("\n"),
      params: this.ctx.params,
      decode: (rs) => (Array.isArray(rs[0]) ? rs[0].map(decode) : []),
    };
  }

  /**
   * A connection to a union (`favoritesConnection(where, sort, first, after)`), v7 7.6: the edges of
   * every member selected by `where` (`{ Movie: { node, edge }, … }`), with the member's READ rules,
   * deduplicated like v7's `UNION` (same node, same selected properties: one edge); `totalCount`
   * counts them; `sort` orders on edge properties; cursors are offsets.
   */
  private unionConnection(
    scope: Scope,
    variable: string,
    rel: Relationship,
    args: AnyRecord,
    fieldNodes: readonly FieldNode[],
  ): { expr: string; decode: Decoder } {
    const afterOffset = cursorToOffset(args.after);
    const offset = afterOffset === undefined ? 0 : afterOffset + 1;
    const conn = collectFields(this.info, subSelections(fieldNodes));
    const edgeFieldNodes = [...conn]
      .filter(([, n]) => n[0]!.name.value === "edges")
      .flatMap(([, n]) => n);
    const edgeFields = collectFields(this.info, subSelections(edgeFieldNodes));
    const props = this.props(rel);
    const sortKeys: { attr: Attribute; dir: string }[] = [];
    for (const s of Array.isArray(args.sort) ? args.sort : []) {
      if (s === null || typeof s !== "object") continue;
      const edge = (s as AnyRecord).edge;
      if (!props || edge === null || typeof edge !== "object") continue;
      for (const [field, dir] of Object.entries(edge as AnyRecord)) {
        if (dir !== "ASC" && dir !== "DESC") continue;
        const attr = props.attributes.find((a) => a.name === field);
        if (!attr) throw new Error(`Unknown sort field ${props.name}.${field}`);
        sortKeys.push({ attr, dir });
      }
    }
    const e = this.ctx.variable("edge");
    const nodeDecoders = new Map<string, Map<string, Decoder>>();
    const propDecoders = new Map<string, Decoder>();
    const members = selectedMembers(unionMembers(this.model, rel), args.where);
    const branches = members.map(({ rel: m, where }) => {
      const node = this.model.node(m.target);
      this.authenticate(node, "READ");
      const t = this.ctx.variable("this");
      const r = this.ctx.variable("edge");
      const nodeFields = [...edgeFields]
        .filter(([, n]) => n[0]!.name.value === "node")
        .flatMap(([, n]) => narrowFieldNodes(this.info, n, node.name, rel.target));
      return this.unionBranch({
        member: node,
        union: rel.target,
        match: relationshipPattern(this.model, variable, m, t, r),
        nodeVar: t,
        predicate: this.where.connection(r, t, m, where),
        ruleNodes: nodeFields,
        row: (inner, pre) => {
          const entries = this.memberKeys(node, t);
          sortKeys.forEach(({ attr }, i) => {
            const value = attr.cypher ? this.sortValue(r, attr, pre) : `${r}.${q(attr.property)}`;
            entries.push(`${q(`${SORT_KEY}${i}`)}: ${value}`);
          });
          for (const [key, nodes] of edgeFields) {
            const name = nodes[0]!.name.value;
            if (name === "node") {
              const narrowed = narrowFieldNodes(this.info, nodes, node.name, rel.target);
              const p = this.projectNode(t, node, narrowed, inner, pre);
              entries.push(`${q(key)}: ${p.expr}`);
              const byType = nodeDecoders.get(key) ?? new Map<string, Decoder>();
              byType.set(node.name, p.decode);
              nodeDecoders.set(key, byType);
            } else if (name === "properties" && props) {
              const p = this.projectProperties(r, props, nodes, inner, pre);
              entries.push(`${q(key)}: ${p.expr}`);
              propDecoders.set(key, p.decode);
            }
          }
          return `{ ${entries.join(", ")} }`;
        },
        out: e,
      });
    });
    const call = this.unionCall(variable, branches);
    const v = this.ctx.variable("union");
    if (call) {
      const all = this.ctx.variable("edges");
      const order = sortKeys.length
        ? `WITH ${e} ORDER BY ${sortKeys.map(({ dir }, i) => `${e}.${q(`${SORT_KEY}${i}`)} ${dir}`).join(", ")}`
        : "";
      const page = slice(this.ctx, offset, args.first);
      scope.push(
        [
          AGGREGATE_MARK,
          `CALL (${variable}) {`,
          call,
          order,
          `WITH collect(${e}) AS ${all}`,
          `RETURN CASE WHEN ${this.anyForbidden(all)} THEN ${this.forbiddenMap()} ELSE { total: size(${all}), edges: ${all}${page} } END AS ${v}`,
          "}",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    const decodeEdge = (raw: AnyRecord, i: number): AnyRecord => {
      const type = raw[TYPE_KEY] as string;
      const out: AnyRecord = {};
      for (const [key, nodes] of edgeFields) {
        const name = nodes[0]!.name.value;
        if (name === "cursor") out[key] = offsetToCursor(offset + i);
        else if (name === "node") {
          const dec = nodeDecoders.get(key)?.get(type);
          out[key] = dec ? { ...(dec(raw[key]) as AnyRecord), __typename: type } : null;
        } else if (name === "properties") out[key] = propDecoders.get(key)?.(raw[key]) ?? null;
      }
      return out;
    };
    return {
      expr: call ? v : "{ total: 0, edges: [] }",
      decode: (raw) => {
        const r = (raw ?? {}) as AnyRecord;
        const total = toNumber(r.total ?? 0);
        const edges = ((Array.isArray(r.edges) ? r.edges : []) as AnyRecord[]).map((x, i) =>
          decodeEdge(x ?? {}, i),
        );
        const out: AnyRecord = {};
        for (const [key, nodes] of conn) {
          const name = nodes[0]!.name.value;
          if (name === "totalCount") out[key] = total;
          else if (name === "edges") out[key] = edges;
          else if (name === "pageInfo")
            out[key] = pageInfoValue(this.info, nodes, offset, edges.length, total);
        }
        return out;
      },
    };
  }

  /** `movies(where, sort, limit, offset)`. */
  rootList(node: NodeType, args: AnyRecord, fieldNodes: readonly FieldNode[]): CompiledQuery {
    const v = this.ctx.variable("this");
    const auth = this.readRules(v, node, fieldNodes);
    const pred = and([this.where.node(v, node, args.where), auth.filter]);
    const pre = sortScope();
    const order = this.nodeOrder(v, node, args.sort, pre);
    const page = paging(this.ctx, args.offset, pageLimit(node, args.limit));
    const inner: Scope = [];
    const proj = this.projectNode(v, node, fieldNodes, inner, pre);
    const head = [
      `MATCH ${nodePattern(v, node)}`,
      pred ? `WHERE ${pred}` : "",
      ...pre.clauses,
      withClause(v, order, page, pre),
      ...inner,
    ];
    if (auth.failure !== undefined) {
      // One row: the projections, or the marker when a matching node fails validation.
      const root: Scope = [];
      const row = this.rowGate(inner, auth.failure, proj.expr, this.forbiddenMap());
      const list = this.subquery(root, "collect", head, row);
      const match = nodePattern(v, node);
      const value = this.gate(root, match, pred, auth.failure, list, this.forbiddenList());
      return {
        cypher: [...root, `RETURN ${value} AS this`].join("\n"),
        params: this.ctx.params,
        decode: (rows) => (Array.isArray(rows[0]) ? rows[0].map(proj.decode) : []),
      };
    }
    const cypher = [...head, `RETURN ${proj.expr} AS this`].filter(Boolean).join("\n");
    return { cypher, params: this.ctx.params, decode: (rows) => rows.map(proj.decode) };
  }

  /** `moviesConnection(where, sort, first, after)`. */
  rootConnection(node: NodeType, args: AnyRecord, fieldNodes: readonly FieldNode[]): CompiledQuery {
    const v = this.ctx.variable("this");
    const root: Scope = [];
    const pre = sortScope();
    const c = this.connection({
      scope: root,
      match: nodePattern(v, node),
      predicate: this.where.node(v, node, args.where),
      order: this.nodeOrder(v, node, args.sort, pre),
      pre,
      nodeVar: v,
      projectNode: (nodes, sc, p) => this.projectNode(v, node, nodes, sc, p),
      node,
      args,
      fieldNodes,
      owner: `${node.plural}Connection`,
    });
    return {
      cypher: [...root, `RETURN ${c.expr} AS this`].join("\n"),
      params: this.ctx.params,
      decode: (rows) => c.decode(rows[0]),
    };
  }

  /**
   * A `Query` / `Mutation` `@cypher` field: `CALL () { <statement> }` then one row per returned
   * value (a scalar list column is flattened, like v7). A non-list field takes the first row.
   * Returned nodes get the READ rules of their type and the selection's projection.
   */
  rootCypher(
    field: CypherRootField,
    args: AnyRecord,
    fieldNodes: readonly FieldNode[],
  ): CompiledQuery {
    const call = statementCall(this.ctx, field.cypher, field.args, args);
    const list = field.type.list;
    if (field.kind !== "node") {
      const decode = attributeDecoder({ kind: field.kind as "scalar" | "enum", type: field.type });
      const x = this.ctx.variable("value");
      const cypher = list
        ? [call, `UNWIND ${column(field.cypher)} AS ${x}`, `RETURN ${x} AS this`]
        : [call, `RETURN ${column(field.cypher)} AS this`];
      return {
        cypher: cypher.join("\n"),
        params: this.ctx.params,
        decode: list
          ? (rows) => rows.map((r) => decode(r))
          : (rows) => (rows.length ? decode(rows[0]) : null),
      };
    }
    const target = this.model.node(field.type.name);
    this.authenticate(target, "READ");
    const p = this.cypherNodes(call, field.cypher, target, fieldNodes, list);
    return {
      cypher: [...p.clauses, `RETURN ${p.row} AS this`].join("\n"),
      params: this.ctx.params,
      decode: list
        ? (rows) => rows.map(p.decode)
        : (rows) => (rows.length ? p.decode(rows[0]) : null),
    };
  }

  /**
   * A `@fulltext` query (`moviesByTitle(phrase, where, sort, first, after)`), v7 7.6:
   * `db.index.fulltext.queryNodes(index, phrase)` keeps the nodes of the type that match `where`
   * (`score: { min, max }` and `node`) and its READ filter rules; `totalCount` counts them,
   * `edges` (`node`, `score`, offset cursors) are ordered by `sort` (no order: the index order,
   * best score first) and paginated by `first` / `after`. A matching node that fails READ
   * `validate` rules makes the query `Forbidden`.
   */
  rootFulltext(
    node: NodeType,
    index: FulltextIndex,
    args: AnyRecord,
    fieldNodes: readonly FieldNode[],
  ): CompiledQuery {
    this.authenticate(node, "READ");
    const v = this.ctx.variable("this");
    const score = this.ctx.variable("score");
    const conn = collectFields(this.info, subSelections(fieldNodes));
    const edgeFields = [...conn]
      .filter(([, n]) => n[0]!.name.value === "edges")
      .flatMap(([, n]) => n);
    const nodeFields = [...collectFields(this.info, subSelections(edgeFields))]
      .filter(([, n]) => n[0]!.name.value === "node")
      .flatMap(([, n]) => n);
    const auth = this.readRules(v, node, nodeFields);
    const where = (args.where ?? {}) as AnyRecord;
    const scoreWhere = (where.score ?? {}) as AnyRecord;
    const pred = and([
      labelPredicate(v, node),
      typeof scoreWhere.min === "number"
        ? `${score} >= ${this.ctx.param(scoreWhere.min)}`
        : undefined,
      typeof scoreWhere.max === "number"
        ? `${score} <= ${this.ctx.param(scoreWhere.max)}`
        : undefined,
      this.where.node(v, node, where.node),
      auth.filter,
    ]);
    const pre = sortScope();
    const items: string[] = [];
    for (const s of Array.isArray(args.sort) ? args.sort : []) {
      if (s === null || typeof s !== "object") continue;
      for (const [k, dir] of Object.entries(s as AnyRecord)) {
        if (k === "score" && (dir === "ASC" || dir === "DESC")) items.push(`${score} ${dir}`);
        else if (k === "node")
          items.push(...this.sortItems(v, node.attributes, dir, node.name, pre));
      }
    }
    const afterOffset = cursorToOffset(args.after);
    const offset = afterOffset === undefined ? 0 : afterOffset + 1;
    const page = paging(this.ctx, offset || undefined, pageLimit(node, args.first));
    const edges = this.ctx.variable("edges");
    const e = this.ctx.variable("edge");
    const inner: Scope = [];
    const entries: string[] = [`score: ${score}`];
    const decoders: [string, (raw: AnyRecord, i: number) => unknown][] = [];
    for (const [key, nodes] of collectFields(this.info, subSelections(edgeFields))) {
      const name = nodes[0]!.name.value;
      if (name === "cursor") decoders.push([key, (_r, i) => offsetToCursor(offset + i)]);
      else if (name === "score") decoders.push([key, (r) => toFloat(r.score)]);
      else if (name === "node") {
        const p = this.projectNode(v, node, nodes, inner, pre);
        entries.push(`${q(key)}: ${p.expr}`);
        decoders.push([key, (r) => p.decode(r[key])]);
      }
    }
    const order = items.length ? `ORDER BY ${items.join(", ")}` : "";
    const denied = this.ctx.variable("denied");
    const pageVar = this.ctx.variable("page");
    const result = `{ edges: ${pageVar}, total: size(${edges}) }`;
    const cypher = [
      `CALL db.index.fulltext.queryNodes(${this.ctx.param(index.indexName)}, ${this.ctx.param(args.phrase ?? "")}) YIELD node AS ${v}, score AS ${score}`,
      `WHERE ${pred}`,
      `WITH collect({ node: ${v}, score: ${score} }) AS ${edges}${
        auth.failure ? `, sum(CASE WHEN ${auth.failure} THEN 1 ELSE 0 END) > 0 AS ${denied}` : ""
      }`,
      `CALL (${edges}) {`,
      `UNWIND ${edges} AS ${e}`,
      `WITH ${e}.node AS ${v}, ${e}.score AS ${score}`,
      ...pre.clauses,
      withClause(`${v}, ${score}`, order, page, pre),
      ...inner,
      `RETURN collect({ ${entries.join(", ")} }) AS ${pageVar}`,
      `}`,
      `RETURN ${auth.failure ? `CASE WHEN ${denied} THEN ${this.forbiddenMap()} ELSE ${result} END` : result} AS this`,
    ]
      .filter(Boolean)
      .join("\n");
    return {
      cypher,
      params: this.ctx.params,
      decode: (rows) => {
        const r = (rows[0] ?? {}) as AnyRecord;
        const total = toNumber(r.total ?? 0);
        const rawEdges = (Array.isArray(r.edges) ? r.edges : []) as AnyRecord[];
        const out: AnyRecord = {};
        const list = rawEdges.map((raw, i) =>
          Object.fromEntries(decoders.map(([k, dec]) => [k, dec(raw ?? {}, i)])),
        );
        for (const [key, nodes] of conn) {
          const name = nodes[0]!.name.value;
          if (name === "totalCount") out[key] = total;
          else if (name === "edges") out[key] = list;
          else if (name === "pageInfo") {
            const info: AnyRecord = {};
            for (const [pk, pn] of collectFields(this.info, subSelections(nodes))) {
              const n = pn[0]!.name.value;
              if (n === "hasNextPage") info[pk] = offset + list.length < total;
              else if (n === "hasPreviousPage") info[pk] = offset > 0;
              else if (n === "startCursor") info[pk] = list.length ? offsetToCursor(offset) : null;
              else if (n === "endCursor")
                info[pk] = list.length ? offsetToCursor(offset + list.length - 1) : null;
            }
            out[key] = info;
          }
        }
        return out;
      },
    };
  }
}
