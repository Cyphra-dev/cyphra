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
  type SelectionSetNode,
} from "graphql";
import neo4j, { isInt } from "neo4j-driver";
import { FOLLOW_UP, notImplemented } from "../errors.js";
import {
  readNeedsAuth,
  type Attribute,
  type NodeType,
  type PropertiesType,
  type Relationship,
  type V7Model,
} from "../model.js";
import {
  CypherContext,
  labels,
  listAggregate,
  q,
  withList,
  type ListAggregate,
} from "./context.js";
import { WhereCompiler, relationshipPattern } from "./where.js";

type AnyRecord = Record<string, unknown>;
export type Decoder = (raw: unknown) => unknown;

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
function collectFields(
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

function subSelections(nodes: readonly FieldNode[]): (SelectionSetNode | undefined)[] {
  return nodes.map((n) => n.selectionSet);
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

function attributeDecoder(a: Attribute): Decoder {
  if (a.kind === "scalar" && a.type.name === "BigInt") {
    return (v) => mapValue(v, (x) => (isInt(x) ? x.toString() : x));
  }
  if (a.kind === "scalar" && (a.type.name === "Int" || a.type.name === "Float")) {
    return (v) => mapValue(v, integerToNumber);
  }
  return (v) => v ?? null;
}

function toNumber(v: unknown): number {
  return isInt(v) ? v.toNumber() : Number(v);
}

function intParam(ctx: CypherContext, value: unknown): string | undefined {
  if (typeof value !== "number") return undefined;
  return ctx.param(neo4j.int(Math.max(0, Math.trunc(value))));
}

function paging(ctx: CypherContext, offset: unknown, limit: unknown): string {
  const parts: string[] = [];
  const o = intParam(ctx, offset);
  if (o) parts.push(`SKIP ${o}`);
  const l = intParam(ctx, limit);
  if (l) parts.push(`LIMIT ${l}`);
  return parts.join(" ");
}

/** `WITH vars ORDER BY … SKIP … LIMIT …`, or nothing when there is no order and no paging. */
function withClause(vars: string, order: string, page: string): string {
  if (!order && !page) return "";
  return ["WITH", vars, order, page].filter(Boolean).join(" ");
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

  constructor(
    private readonly model: V7Model,
    private readonly info: SelectionInfo,
  ) {
    this.where = new WhereCompiler(model, this.ctx, (n) => this.assertReadable(n));
  }

  assertReadable(node: NodeType): void {
    if (readNeedsAuth(node)) {
      throw notImplemented(
        `reading ${node.name}, which has @authentication / @authorization rules`,
        FOLLOW_UP.authorization,
      );
    }
  }

  private sortItems(
    variable: string,
    attributes: readonly Attribute[],
    sort: unknown,
    owner: string,
  ): string[] {
    const items: string[] = [];
    if (sort === null || typeof sort !== "object") return items;
    for (const [field, dir] of Object.entries(sort as AnyRecord)) {
      if (dir !== "ASC" && dir !== "DESC") continue;
      const a = attributes.find((x) => x.name === field);
      if (!a) throw new Error(`Unknown sort field ${owner}.${field}`);
      if (a.cypher)
        throw notImplemented(`sorting on @cypher field ${owner}.${field}`, FOLLOW_UP.cypher);
      items.push(`${variable}.${q(a.property)} ${dir}`);
    }
    return items;
  }

  private nodeOrder(variable: string, node: NodeType, sort: unknown): string {
    const items = (Array.isArray(sort) ? sort : []).flatMap((s) =>
      this.sortItems(variable, node.attributes, s, node.name),
    );
    return items.length ? `ORDER BY ${items.join(", ")}` : "";
  }

  private connectionOrder(
    relVar: string,
    nodeVar: string,
    rel: Relationship,
    sort: unknown,
  ): string {
    const target = this.model.node(rel.target);
    const props = this.props(rel);
    const items: string[] = [];
    for (const s of Array.isArray(sort) ? sort : []) {
      if (s === null || typeof s !== "object") continue;
      for (const [k, v] of Object.entries(s as AnyRecord)) {
        if (k === "node") items.push(...this.sortItems(nodeVar, target.attributes, v, target.name));
        else if (k === "edge" && props)
          items.push(...this.sortItems(relVar, props.attributes, v, props.name));
      }
    }
    return items.length ? `ORDER BY ${items.join(", ")}` : "";
  }

  private props(rel: Relationship): PropertiesType | undefined {
    return rel.properties ? this.model.properties.get(rel.properties) : undefined;
  }

  /** `{ key: expr, … }` for a selection on a node variable, and its decoder. */
  projectNode(
    variable: string,
    node: NodeType,
    fieldNodes: readonly FieldNode[],
  ): { expr: string; decode: Decoder } {
    this.assertReadable(node);
    const type = objectType(this.info, node.name);
    const gqlFields = type.getFields();
    const entries: string[] = [];
    const decoders: [string, Decoder][] = [];
    for (const [key, nodes] of collectFields(this.info, subSelections(fieldNodes))) {
      const name = nodes[0]!.name.value;
      if (name === "__typename") continue;
      const attr = node.attributes.find((a) => a.name === name);
      if (attr) {
        if (attr.cypher)
          throw notImplemented(`@cypher field ${node.name}.${name}`, FOLLOW_UP.cypher);
        entries.push(`${q(key)}: ${variable}.${q(attr.property)}`);
        decoders.push([key, attributeDecoder(attr)]);
        continue;
      }
      const gqlField = gqlFields[name];
      if (!gqlField) throw new Error(`Unknown field ${node.name}.${name}`);
      const args = fieldArgs(gqlField, nodes[0]!, this.info);
      const rel = node.relationships.find((r) => r.name === name);
      if (rel) {
        const p = this.relationshipList(variable, rel, args, nodes);
        entries.push(`${q(key)}: ${p.expr}`);
        decoders.push([key, p.decode]);
        continue;
      }
      const connRel = name.endsWith("Connection")
        ? node.relationships.find((r) => `${r.name}Connection` === name)
        : undefined;
      if (connRel) {
        const p = this.relationshipConnection(variable, connRel, args, nodes);
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

  private projectProperties(
    relVar: string,
    props: PropertiesType,
    fieldNodes: readonly FieldNode[],
  ): { expr: string; decode: Decoder } {
    const entries: string[] = [];
    const decoders: [string, Decoder][] = [];
    for (const [key, nodes] of collectFields(this.info, subSelections(fieldNodes))) {
      const name = nodes[0]!.name.value;
      if (name === "__typename") continue;
      const attr = props.attributes.find((a) => a.name === name);
      if (!attr) throw new Error(`Unknown field ${props.name}.${name}`);
      entries.push(`${q(key)}: ${relVar}.${q(attr.property)}`);
      decoders.push([key, attributeDecoder(attr)]);
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

  private relationshipList(
    variable: string,
    rel: Relationship,
    args: AnyRecord,
    fieldNodes: readonly FieldNode[],
  ): { expr: string; decode: Decoder } {
    const target = this.model.node(rel.target);
    const m = this.ctx.variable("this");
    const pattern = relationshipPattern(this.model, variable, rel, m);
    const pred = this.where.node(m, target, args.where);
    const order = this.nodeOrder(m, target, args.sort);
    const page = paging(this.ctx, args.offset, args.limit);
    const inner = this.projectNode(m, target, fieldNodes);
    const body = [
      `MATCH ${pattern}`,
      pred ? `WHERE ${pred}` : "",
      withClause(m, order, page),
      `RETURN ${inner.expr}`,
    ]
      .filter(Boolean)
      .join(" ");
    return {
      expr: `COLLECT { ${body} }`,
      decode: (raw) => (Array.isArray(raw) ? raw.map(inner.decode) : []),
    };
  }

  /**
   * A connection over `match` (a pattern binding `nodeVar` and, for relationships, `relVar`):
   * `{ total: COUNT { … }, edges: COLLECT { … } }` and the decoder that builds edges, cursors and
   * `pageInfo` from the selection.
   */
  private connection(opts: {
    match: string;
    predicate?: string;
    order: string;
    nodeVar: string;
    relVar?: string;
    projectNode: (fieldNodes: readonly FieldNode[]) => { expr: string; decode: Decoder };
    projectProperties?: (fieldNodes: readonly FieldNode[]) => { expr: string; decode: Decoder };
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

    const edgeEntries: string[] = [];
    const edgeDecoders: [string, (raw: AnyRecord, index: number) => unknown][] = [];
    const edgeFieldNodes: FieldNode[] = [];
    const aggregates: [string, Decoder][] = [];
    const aggregateEntries: string[] = [];
    let needsTotal = false;
    let needsEdges = false;
    const where = opts.predicate ? ` WHERE ${opts.predicate}` : "";
    for (const [key, nodes] of conn) {
      const name = nodes[0]!.name.value;
      if (name === "aggregate") {
        const p = this.aggregate(
          {
            base: `MATCH ${opts.match}${where}`,
            nodeVar: opts.nodeVar,
            relVar: opts.relVar,
            node: opts.node,
            props: opts.props,
            owner: opts.owner,
          },
          nodes,
        );
        aggregateEntries.push(`${q(key)}: ${p.expr}`);
        aggregates.push([key, p.decode]);
      }
      if (name === "edges") edgeFieldNodes.push(...nodes);
      if (name === "edges" || name === "pageInfo") needsEdges = true;
      if (name === "totalCount" || name === "pageInfo") needsTotal = true;
    }
    for (const [key, nodes] of collectFields(this.info, subSelections(edgeFieldNodes))) {
      const name = nodes[0]!.name.value;
      if (name === "cursor") {
        edgeDecoders.push([key, (_raw, i) => offsetToCursor(offset + i)]);
      } else if (name === "node") {
        const p = opts.projectNode(nodes);
        edgeEntries.push(`${q(key)}: ${p.expr}`);
        edgeDecoders.push([key, (raw) => p.decode(raw[key])]);
      } else if (name === "properties" && opts.projectProperties) {
        const p = opts.projectProperties(nodes);
        edgeEntries.push(`${q(key)}: ${p.expr}`);
        edgeDecoders.push([key, (raw) => p.decode(raw[key])]);
      }
    }

    const withVars = opts.relVar ? `${opts.relVar}, ${opts.nodeVar}` : opts.nodeVar;
    const page = paging(this.ctx, offset || undefined, opts.args.first);
    const edgesBody = [
      `MATCH ${opts.match}${where}`,
      withClause(withVars, opts.order, page),
      `RETURN { ${edgeEntries.join(", ")} }`,
    ]
      .filter(Boolean)
      .join(" ");
    const parts: string[] = [];
    if (needsTotal) parts.push(`total: COUNT { MATCH ${opts.match}${where} }`);
    if (needsEdges) parts.push(`edges: COLLECT { ${edgesBody} }`);
    if (aggregateEntries.length) parts.push(`aggregate: { ${aggregateEntries.join(", ")} }`);
    const expr = `{ ${parts.join(", ")} }`;

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
                case "hasNextPage":
                  info[pk] = offset + edges.length < total;
                  break;
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
          counts.push(`${q(ck)}: COUNT { ${scope.base} WITH DISTINCT ${v} RETURN ${v} }`);
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
      this.assertReadable(scope.node);
      const fieldEntries: string[] = [];
      const fieldDecoders: [string, Decoder][] = [];
      for (const [fk, fn] of collectFields(this.info, subSelections(nodes))) {
        const field = fn[0]!.name.value;
        if (field === "__typename") continue;
        const attr = attributes.find((a) => a.name === field);
        if (!attr) throw new Error(`Unknown field ${scope.owner}.aggregate.${name}.${field}`);
        const p = this.aggregateAttribute(scope.base, variable, attr, fn);
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
    base: string,
    variable: string,
    attr: Attribute,
    fieldNodes: readonly FieldNode[],
  ): { expr: string; decode: Decoder } {
    const prop = `${variable}.${q(attr.property)}`;
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
      const list = `COLLECT { ${values} WITH ${variable} ORDER BY size(${prop}) DESC RETURN ${prop} }`;
      const items = ops.map(
        ([k, op]) =>
          `${q(k)}: ${op === "longest" ? `head(${l})` : op === "shortest" ? `last(${l})` : "null"}`,
      );
      return {
        expr: withList(list, l, () => `{ ${items.join(", ")} }`),
        decode: mapDecoder(decoders),
      };
    }
    const list = `COLLECT { ${values} RETURN ${prop} }`;
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
    variable: string,
    rel: Relationship,
    args: AnyRecord,
    fieldNodes: readonly FieldNode[],
  ): { expr: string; decode: Decoder } {
    const target = this.model.node(rel.target);
    this.assertReadable(target);
    const m = this.ctx.variable("this");
    const r = this.ctx.variable("edge");
    const props = this.props(rel);
    return this.connection({
      match: relationshipPattern(this.model, variable, rel, m, r),
      predicate: this.where.connection(r, m, rel, args.where),
      order: this.connectionOrder(r, m, rel, args.sort),
      nodeVar: m,
      relVar: r,
      projectNode: (nodes) => this.projectNode(m, target, nodes),
      projectProperties: props ? (nodes) => this.projectProperties(r, props, nodes) : undefined,
      node: target,
      props,
      args,
      fieldNodes,
      owner: `${rel.source}.${rel.name}Connection`,
    });
  }

  /** `movies(where, sort, limit, offset)`. */
  rootList(node: NodeType, args: AnyRecord, fieldNodes: readonly FieldNode[]): CompiledQuery {
    this.assertReadable(node);
    const v = this.ctx.variable("this");
    const pred = this.where.node(v, node, args.where);
    const order = this.nodeOrder(v, node, args.sort);
    const page = paging(this.ctx, args.offset, args.limit);
    const proj = this.projectNode(v, node, fieldNodes);
    const cypher = [
      `MATCH (${v}${labels(node.labels)})`,
      pred ? `WHERE ${pred}` : "",
      withClause(v, order, page),
      `RETURN ${proj.expr} AS this`,
    ]
      .filter(Boolean)
      .join("\n");
    return { cypher, params: this.ctx.params, decode: (rows) => rows.map(proj.decode) };
  }

  /** `moviesConnection(where, sort, first, after)`. */
  rootConnection(node: NodeType, args: AnyRecord, fieldNodes: readonly FieldNode[]): CompiledQuery {
    this.assertReadable(node);
    const v = this.ctx.variable("this");
    const c = this.connection({
      match: `(${v}${labels(node.labels)})`,
      predicate: this.where.node(v, node, args.where),
      order: this.nodeOrder(v, node, args.sort),
      nodeVar: v,
      projectNode: (nodes) => this.projectNode(v, node, nodes),
      node,
      args,
      fieldNodes,
      owner: `${node.plural}Connection`,
    });
    return {
      cypher: `RETURN ${c.expr} AS this`,
      params: this.ctx.params,
      decode: (rows) => c.decode(rows[0]),
    };
  }
}
