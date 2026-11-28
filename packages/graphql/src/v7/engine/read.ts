/**
 * Translates v7 root queries (`movies(where, sort, limit, offset)`, `moviesConnection(where,
 * sort, first, after)`) with their whole selection into one engine operation (`findMany`, plus a
 * `count` in the same read transaction for `totalCount` / `pageInfo`), and the raw rows back into
 * the v7 result, as the compat compiler's decoders shape it:
 *
 * - attributes are read from their property and decoded like the compat compiler (`Int` as a
 *   number, `BigInt` as a string, temporal values as the driver gives them);
 * - nested relationship fields are aliased relation loads with their `where`, `sort`, `limit` and
 *   `offset` (and the type's `@limit`);
 * - connections page with v7's offset cursors (`after` is an offset, `first` the page size), and
 *   `totalCount` is a count of the same `where`; `pageInfo` follows v7 (including its
 *   `hasNextPage` on a type with `@limit`).
 *
 * - `@authorization` READ rules are ANDed into the `where` of the root, of each relation load and
 *   of each connection (see `rules.ts`), with the rules of the attributes selected there;
 * - `@authentication` is checked where the compiler checks it (each projected node selection with
 *   its fields, each connection), and its first failure is raised once the request translates.
 *
 * Connection edge filters and sorts are the engine's `$edge` filters and sorts of the related node.
 *
 * Connection `aggregate` selections are engine list aggregates (`$aggregate`, and `$values` on the
 * root `aggregate`), `@cypher` fields engine `CALL` clauses (see `cypher.ts`), `@fulltext` queries
 * an engine `search`, and root `@cypher` fields a `findMany` from the statement's rows (`$from`) or
 * the statement itself (`runCypherFragment`).
 *
 * Anything else throws {@link Fallback} (custom resolvers' fields, interfaces, unions, READ
 * validations that may fail, …).
 *
 * @packageDocumentation
 */

import { getArgumentValues, type FieldNode, type GraphQLObjectType } from "graphql";
import { int as neo4jInt, isInt } from "neo4j-driver";
import { runCypherFragment, withReadTransaction } from "@cyphra/runtime";
import {
  aggregateValueDecoder,
  attributeDecoder,
  collectFields,
  cursorToOffset,
  narrowFieldNodes,
  offsetToCursor,
  pageLimit,
  subSelections,
  type SelectionInfo,
} from "../cypher/select.js";
import { checkAuthentication, forbidden, type AuthContext } from "../auth/context.js";
import {
  keyedConnectionEdge,
  type Attribute,
  type AuthOperation,
  type CypherNodeField,
  type CypherRootField,
  type FulltextIndex,
  type NodeType,
  type PropertiesType,
  type Relationship,
  type V7Model,
} from "../model.js";
import {
  expressionList,
  expressionNodes,
  expressionValue,
  listCall,
  nodesCall,
  rootNodesCall,
  rootScalarStatement,
  scalarCall,
} from "./cypher.js";
import { EngineAuthRules } from "./rules.js";
import { ENGINE_SCALAR_TYPES, type EngineNode, type EngineSchema } from "./schema.js";
import {
  Fallback,
  WhereTranslator,
  allOf,
  isPlainObject,
  rootWhere,
  type Filter,
} from "./where.js";

type AnyRecord = Record<string, unknown>;
type Shape = (row: AnyRecord) => unknown;
type Delegate = Record<string, (args: AnyRecord) => Promise<unknown>>;

/** A translated selection: the engine `select` and how to shape one row of it. */
type Projection = { select: AnyRecord; shape: (row: AnyRecord) => AnyRecord };

/** A translated root field, run on the request's engine client. */
export type ReadPlan = (client: object) => Promise<unknown>;

/** `fn` in a write transaction of an ORM client (its `$transaction`). */
function inWriteTransaction<T>(client: object, fn: (tx: object) => Promise<T>): Promise<T> {
  const transaction = (client as { $transaction?: (f: (tx: object) => Promise<T>) => Promise<T> })
    .$transaction;
  if (typeof transaction !== "function") {
    throw new Error("Internal error: the engine client has no $transaction.");
  }
  return transaction.call(client, fn);
}

/** The delegate of a model on an ORM client. */
export function delegate(client: object, model: string): Delegate {
  const d = (client as Record<string, unknown>)[model.charAt(0).toLowerCase() + model.slice(1)];
  if (!d) throw new Error(`Internal error: the engine client has no delegate for ${model}.`);
  return d as Delegate;
}

function toNumber(v: unknown): number {
  return isInt(v) ? v.toNumber() : Number(v);
}

/** A page size or offset as the compat compiler passes it: a non-negative integer, or nothing. */
function count(value: unknown): number | undefined {
  return typeof value === "number" ? Math.max(0, Math.trunc(value)) : undefined;
}

/** Collects the per-row counts (`totalCount` of nested connections) of one projection. */
type Counts = Map<string, unknown>;

/** Translates one root field; one per resolver call. */
export class ReadTranslator {
  private readonly where: WhereTranslator;
  /** The request's `@authorization` rules. */
  readonly rules: EngineAuthRules;
  private keys = 0;

  constructor(
    private readonly model: V7Model,
    private readonly schema: EngineSchema,
    private readonly info: SelectionInfo,
    private readonly auth: AuthContext,
  ) {
    this.jwt = auth.jwt ?? {};
    this.where = new WhereTranslator(model, schema, false, this.jwt);
    this.ruleWhere = new WhereTranslator(model, schema, true, this.jwt);
    this.rules = new EngineAuthRules(this.ruleWhere, auth);
  }

  /** `$jwt` of `@cypher` statements (v7: `{}` when not authenticated). */
  private readonly jwt: unknown;
  private readonly ruleWhere: WhereTranslator;

  /** `translate()` for the `where` of a root read (see `WhereTranslator.root`). */
  private atRoot<T>(translate: () => T): T {
    return this.where.atRoot(() => this.ruleWhere.atRoot(translate));
  }

  /** `translate()` for the `where` of a load of a projection (see `WhereTranslator.load`). */
  private atLoad<T>(translate: () => T): T {
    return this.where.atLoad(() => this.ruleWhere.atLoad(translate));
  }

  /**
   * `true`: the projection of a mutation's response, in the write statement (`@cypher` fields as
   * expressions, see `cypher.ts`).
   */
  private write = false;

  /** Translates the response of a mutation from now on. */
  forWrite(): void {
    this.write = true;
    this.where.write = true;
    this.ruleWhere.write = true;
  }

  /** The first `@authentication` failure met while translating (thrown once it succeeds). */
  private authFailure: { error: unknown } | undefined;

  /**
   * `@authentication` for `operation` on the type and on each of `fields`, where and in the order
   * the compiler checks them (a node it projects, a connection, a write). A failure is kept and
   * thrown by {@link authenticated} when the whole request translates: a request that falls back
   * gets the compiler's own checks.
   */
  authenticate(node: NodeType, operation: AuthOperation, fields: readonly string[] = []): void {
    if (this.authFailure) return;
    try {
      checkAuthentication(this.model, this.auth, node, [operation]);
      for (const f of fields) checkAuthentication(this.model, this.auth, node, [operation], f);
    } catch (error) {
      this.authFailure = { error };
    }
  }

  /** Throws the first `@authentication` failure of the translated request, if any. */
  authenticated(): void {
    if (this.authFailure) throw this.authFailure.error;
  }

  /**
   * The attributes of `node` selected by `fieldNodes` (their field rules apply with the type's),
   * like the compiler's `selectedAttributes`.
   */
  selectedAttributes(node: NodeType, fieldNodes: readonly FieldNode[]): Attribute[] {
    const names = new Set(
      [...collectFields(this.info, subSelections(fieldNodes)).values()].map(
        (n) => n[0]!.name.value,
      ),
    );
    return node.attributes.filter((a) => names.has(a.name));
  }

  /**
   * The `edges { node }` field nodes of a connection selection, as the compiler reads them for the
   * READ rules (from the response key `edges`).
   */
  private edgeNodeFields(fieldNodes: readonly FieldNode[]): FieldNode[] {
    const conn = collectFields(this.info, subSelections(fieldNodes));
    return [...collectFields(this.info, subSelections(conn.get("edges") ?? []))]
      .filter(([, n]) => n[0]!.name.value === "node")
      .flatMap(([, n]) => n);
  }

  /** A fresh key for a relation load of `engine`'s projection (never one of its fields). */
  private key(engine: EngineNode): string {
    let k: string;
    do k = `r${this.keys++}`;
    while (engine.model.fields.some((f) => f.name === k));
    return k;
  }

  private objectType(name: string): GraphQLObjectType {
    return this.info.schema.getType(name) as GraphQLObjectType;
  }

  /** `sort: [{ title: ASC }]` → engine `orderBy` (`undefined` without keys). */
  private orderBy(node: NodeType, sort: unknown): AnyRecord[] | undefined {
    const engine = this.where.engineNode(node);
    const items: AnyRecord[] = [];
    for (const s of Array.isArray(sort) ? sort : []) {
      if (s === null || typeof s !== "object") continue;
      items.push(...this.sortItems(engine, s as AnyRecord));
    }
    return items.length ? items : undefined;
  }

  private sortItems(engine: EngineNode, sort: AnyRecord): AnyRecord[] {
    const items: AnyRecord[] = [];
    for (const [name, dir] of Object.entries(sort)) {
      if (dir !== "ASC" && dir !== "DESC") continue;
      const attr = engine.v7.attributes.find((a) => a.name === name);
      if (attr?.cypher) {
        // In a mutation's projection: an expression (see `cypherAttribute`).
        items.push(
          this.write
            ? { $cypher: this.cypherSort(attr, dir) }
            : { $call: this.cypherSort(attr, dir) },
        );
        continue;
      }
      const field = attr ? engine.fields.get(attr.name) : undefined;
      if (!field) throw new Fallback(`sort on ${engine.v7.name}.${name}`);
      items.push({ [field]: dir === "ASC" ? "asc" : "desc" });
    }
    return items;
  }

  /**
   * The sort of a scalar `@cypher` field: a `$call` clause before the `ORDER BY` (v7 runs the
   * statement before sorting; arguments are not bound, so they are `NULL`), whose value the
   * projection of the field reuses when it has no arguments.
   */
  private cypherSort(attr: Attribute, dir: "ASC" | "DESC"): AnyRecord {
    const type = attr.kind === "enum" ? "String" : ENGINE_SCALAR_TYPES[attr.type.name];
    if (attr.type.list || !type) throw new Fallback(`sort on @cypher ${attr.name}`);
    if (this.write) {
      return {
        expr: expressionValue(attr.cypher!, attr.args, {}, this.jwt),
        type,
        sort: dir === "ASC" ? "asc" : "desc",
      };
    }
    return {
      expr: scalarCall(attr.cypher!, attr.args, {}, this.jwt),
      type,
      sort: dir === "ASC" ? "asc" : "desc",
      ...(attr.args.length === 0 ? { key: attr.name } : {}),
    };
  }

  /**
   * The engine `select` entry of a scalar or list `@cypher` attribute: a `$call` clause (`$key`:
   * the value of the sort on it, without arguments), or an expression in a mutation's projection.
   * `edge`: an attribute of the relationship the node was reached through.
   */
  private cypherAttribute(attr: Attribute, values: AnyRecord, edge = false): AnyRecord {
    // Projected as the driver returns it (the type only names the value): decoded like v7.
    const type = attr.kind === "enum" ? "String" : (ENGINE_SCALAR_TYPES[attr.type.name] ?? "Json");
    const list = attr.type.list ? { $list: true } : {};
    if (this.write) {
      if (edge) throw new Fallback("@cypher edge property, in a mutation");
      const expr = attr.type.list
        ? expressionList(attr.cypher!, attr.args, values, this.jwt)
        : expressionValue(attr.cypher!, attr.args, values, this.jwt);
      return { $cypher: expr, $type: type, ...list };
    }
    const body = attr.type.list
      ? listCall(attr.cypher!, attr.args, values, this.jwt)
      : scalarCall(attr.cypher!, attr.args, values, this.jwt);
    return {
      $call: body,
      $type: type,
      ...list,
      ...(attr.args.length === 0 && !attr.type.list ? { $key: attr.name } : {}),
      ...(edge ? { $edge: true } : {}),
    };
  }

  /**
   * `where`, `sort`, `offset`, `limit` of a node list → engine arguments, with the READ rules of
   * the nodes `fieldNodes` select (`root`: of a root list).
   */
  private listArgs(
    node: NodeType,
    args: AnyRecord,
    fieldNodes: readonly FieldNode[],
    root = false,
  ): AnyRecord {
    const filter = () =>
      allOf([
        this.where.node(node, args.where),
        this.rules.read(node, this.selectedAttributes(node, fieldNodes)),
      ]);
    const where = rootWhere(root ? this.atRoot(filter) : this.atLoad(filter));
    const orderBy = this.orderBy(node, args.sort);
    const skip = count(args.offset);
    const take = count(pageLimit(node, args.limit));
    return {
      ...(where !== undefined ? { where } : {}),
      ...(orderBy !== undefined ? { orderBy } : {}),
      ...(skip !== undefined ? { skip } : {}),
      ...(take !== undefined ? { take } : {}),
    };
  }

  /** The projection of a selection on a node (`fieldNodes` are the fields selecting it). */
  node(node: NodeType, fieldNodes: readonly FieldNode[]): Projection {
    const engine = this.where.engineNode(node);
    const gqlFields = this.objectType(node.name).getFields();
    const select: AnyRecord = {};
    const shapers: [string, Shape][] = [];
    const counts: Counts = new Map();
    const selection = collectFields(this.info, subSelections(fieldNodes));
    // The compiler checks READ for every node selection it projects, with the selected fields.
    this.authenticate(
      node,
      "READ",
      [...selection.values()].map((n) => n[0]!.name.value),
    );
    for (const [key, nodes] of selection) {
      const name = nodes[0]!.name.value;
      if (name === "__typename") continue;
      if (node.userFields.some((f) => f.name === name)) throw new Fallback("custom resolver field");
      const attr = node.attributes.find((a) => a.name === name);
      if (attr?.cypher) {
        const gql = gqlFields[name];
        const values =
          attr.args.length && gql
            ? getArgumentValues(gql, nodes[0]!, this.info.variableValues)
            : {};
        const k = this.key(engine);
        select[k] = this.cypherAttribute(attr, values);
        const decode = attributeDecoder(attr);
        shapers.push([key, (row) => decode(row[k])]);
        continue;
      }
      if (attr) {
        const field = engine.fields.get(attr.name);
        if (!field) throw new Fallback(`${node.name}.${name}`);
        select[field] = true;
        const decode = attributeDecoder(attr);
        shapers.push([key, (row) => decode(row[field])]);
        continue;
      }
      const gqlField = gqlFields[name];
      if (!gqlField) throw new Fallback(`${node.name}.${name}`);
      const args = getArgumentValues(gqlField, nodes[0]!, this.info.variableValues);
      const cypherNode = node.cypherNodes.find((c) => c.name === name);
      if (cypherNode) {
        const p = this.cypherNodes(engine, cypherNode, args, nodes);
        Object.assign(select, p.select);
        shapers.push([key, p.shape]);
        continue;
      }
      const rel = node.relationships.find((r) => r.name === name);
      if (rel) {
        const { name: relation, target } = this.where.relation(node, rel);
        const inner = this.node(target, nodes);
        const k = this.key(engine);
        select[k] = {
          $relation: relation,
          ...this.listArgs(target, args, nodes),
          select: inner.select,
        };
        shapers.push([
          key,
          rel.list
            ? (row) => (Array.isArray(row[k]) ? (row[k] as AnyRecord[]).map(inner.shape) : [])
            : (row) =>
                row[k] === null || row[k] === undefined ? null : inner.shape(row[k] as AnyRecord),
        ]);
        continue;
      }
      const connRel = name.endsWith("Connection")
        ? node.relationships.find((r) => `${r.name}Connection` === name)
        : undefined;
      if (connRel) {
        const c = this.relationshipConnection(engine, connRel, args, nodes, counts);
        Object.assign(select, c.select);
        shapers.push([key, c.shape]);
        continue;
      }
      throw new Fallback(`${node.name}.${name}`);
    }
    if (counts.size) {
      select._count = { select: Object.fromEntries(counts) };
    }
    return {
      select,
      shape: (row) => {
        const out: AnyRecord = {};
        for (const [key, shape] of shapers) out[key] = shape(row);
        return out;
      },
    };
  }

  /**
   * A `@cypher` field returning nodes: the nodes of every row of its statement that the READ rules
   * of their type let through, each projected (`@limit` applies to a list), like the compiler's
   * `WITH col AS n WHERE n IS NOT NULL AND <READ filter>`.
   */
  private cypherNodes(
    engine: EngineNode,
    field: CypherNodeField,
    args: AnyRecord,
    fieldNodes: readonly FieldNode[],
  ): { select: AnyRecord; shape: Shape } {
    const target = this.model.node(field.target);
    this.where.engineNode(target);
    const where = rootWhere(
      this.atLoad(() => this.rules.read(target, this.selectedAttributes(target, fieldNodes))),
    );
    const inner = this.node(target, fieldNodes);
    const list = field.type.list;
    const take = list ? count(pageLimit(target, undefined)) : undefined;
    const k = this.key(engine);
    const select = {
      [k]: {
        ...(this.write
          ? { $cypher: expressionNodes(field.cypher, field.args, args, this.jwt) }
          : { $call: nodesCall(field.cypher, field.args, args, this.jwt) }),
        $model: target.name,
        $many: true,
        // v7 keeps every node the statement returns (`IS NOT NULL`), whatever its labels.
        $labelTest: false,
        ...(where !== undefined ? { where } : {}),
        ...(take !== undefined ? { take } : {}),
        select: inner.select,
      },
    };
    return {
      select,
      shape: (row) => {
        const rows = (Array.isArray(row[k]) ? row[k] : []) as AnyRecord[];
        if (list) return rows.map(inner.shape);
        return rows.length ? inner.shape(rows[0]!) : null;
      },
    };
  }

  /**
   * The edges of a connection: the projection of its `node` selections (merged: their relation
   * loads have distinct keys) and of its `properties` selections, and the decoder of one edge.
   */
  private edges(
    node: NodeType,
    edgeFieldNodes: readonly FieldNode[],
    rel: Relationship | undefined,
    offset: number,
  ): { select: AnyRecord; edge: (row: AnyRecord, index: number) => AnyRecord } {
    const select: AnyRecord = {};
    const decoders: [string, (row: AnyRecord, index: number) => unknown][] = [];
    for (const [key, nodes] of collectFields(this.info, subSelections(edgeFieldNodes))) {
      const name = nodes[0]!.name.value;
      if (name === "cursor") {
        decoders.push([key, (_row, i) => offsetToCursor(offset + i)]);
      } else if (name === "node") {
        const p = this.node(node, nodes);
        Object.assign(select, p.select);
        decoders.push([key, (row) => p.shape(row)]);
      } else if (name === "properties" && rel?.properties) {
        const props = this.model.properties.get(rel.properties)!;
        // Relationships an interface declares have a union of properties types.
        if (keyedConnectionEdge(this.model, rel)) throw new Fallback("keyed edge properties");
        const fields: [string, (edge: AnyRecord, row: AnyRecord) => unknown][] = [];
        const narrowed = narrowFieldNodes(this.info, nodes, props.name, props.name);
        const gqlFields = this.objectType(props.name).getFields();
        for (const [pk, pn] of collectFields(this.info, subSelections(narrowed))) {
          const pname = pn[0]!.name.value;
          if (pname === "__typename") continue;
          const attr = props.attributes.find((a) => a.name === pname);
          if (!attr || attr.variants) throw new Fallback(`${props.name}.${pname}`);
          const decode = attributeDecoder(attr);
          if (attr.cypher) {
            // A `$call` on the edge, projected next to the node's fields.
            const gql = gqlFields[pname];
            const values =
              attr.args.length && gql
                ? getArgumentValues(gql, pn[0]!, this.info.variableValues)
                : {};
            const k = this.key(this.where.engineNode(node));
            select[k] = this.cypherAttribute(attr, values, true);
            fields.push([pk, (_edge, row) => decode(row[k])]);
            continue;
          }
          fields.push([pk, (edge) => decode(edge[attr.property])]);
        }
        decoders.push([
          key,
          (row) => {
            const edge = (row.$edge ?? {}) as AnyRecord;
            const out: AnyRecord = { __typename: props.name };
            for (const [pk, shape] of fields) out[pk] = shape(edge, row);
            return out;
          },
        ]);
      }
    }
    return {
      select,
      edge: (row, index) => {
        const out: AnyRecord = {};
        for (const [key, dec] of decoders) out[key] = dec(row, index);
        return out;
      },
    };
  }

  /**
   * The value of a connection selection (`totalCount`, `edges`, `pageInfo`) from its rows and total,
   * like the compat compiler's connection decoder.
   */
  private connectionValue(
    conn: Map<string, FieldNode[]>,
    node: NodeType,
    args: AnyRecord,
    offset: number,
    edges: readonly AnyRecord[],
    total: number,
  ): AnyRecord {
    const out: AnyRecord = {};
    for (const [key, nodes] of conn) {
      const name = nodes[0]!.name.value;
      if (name === "totalCount") out[key] = total;
      else if (name === "edges") out[key] = edges;
      else if (name === "pageInfo") {
        const info: AnyRecord = {};
        for (const [pk, pn] of collectFields(this.info, subSelections(nodes))) {
          switch (pn[0]!.name.value) {
            case "hasNextPage": {
              // v7 computes it from the requested `first` (not the `@limit` page size).
              const first = args.first;
              info[pk] = !node.limit
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
  }

  /** What a connection selection needs: its fields, the `edges` field nodes, rows and/or a total. */
  private connectionNeeds(fieldNodes: readonly FieldNode[]): {
    conn: Map<string, FieldNode[]>;
    edgeFieldNodes: FieldNode[];
    /** `aggregate` selections, by response key. */
    aggregates: [string, FieldNode[]][];
    needsEdges: boolean;
    needsTotal: boolean;
  } {
    const conn = collectFields(this.info, subSelections(fieldNodes));
    const edgeFieldNodes: FieldNode[] = [];
    const aggregates: [string, FieldNode[]][] = [];
    let needsEdges = false;
    let needsTotal = false;
    for (const [key, nodes] of conn) {
      const name = nodes[0]!.name.value;
      if (name === "aggregate") aggregates.push([key, nodes]);
      if (name === "edges") edgeFieldNodes.push(...nodes);
      if (name === "edges" || name === "pageInfo") needsEdges = true;
      if (name === "totalCount" || name === "pageInfo") needsTotal = true;
    }
    return { conn, edgeFieldNodes, aggregates, needsEdges, needsTotal };
  }

  /**
   * The values of an `aggregate` selection (`count { nodes edges }`, `node { field { min … } }`,
   * `edge { … }`) as engine list aggregates (`values` of `$aggregate`), and how to shape their
   * result like the compiler: `String` fields give `shortest` / `longest`, other fields `min`,
   * `max`, `average`, `sum`, and any other selection `null`.
   */
  private aggregateValues(
    node: NodeType,
    props: PropertiesType | undefined,
    fieldNodes: readonly FieldNode[],
    edges: boolean,
    /** `Forbidden` when the aggregated nodes are not none (a validation that fails). */
    gate: boolean,
  ): { values: AnyRecord; shape: (raw: AnyRecord) => AnyRecord; native: string[] } {
    const engine = this.where.engineNode(node);
    const values: AnyRecord = {};
    let n = 0;
    const id = () => `v${n++}`;
    type Out = [string, (raw: AnyRecord) => unknown];
    const out: Out[] = [];
    /** Values that count the nodes (the root uses the engine's own count). */
    const native: string[] = [];
    const gateKey = gate ? id() : undefined;
    if (gateKey) {
      values[gateKey] = { count: "nodes" };
      native.push(gateKey);
    }
    for (const [key, nodes] of collectFields(this.info, subSelections(fieldNodes))) {
      const name = nodes[0]!.name.value;
      if (name === "__typename") continue;
      if (name === "count") {
        const counts: Out[] = [];
        for (const [ck, cn] of collectFields(this.info, subSelections(nodes))) {
          const what = cn[0]!.name.value;
          if (what !== "nodes" && (what !== "edges" || !edges)) continue;
          const v = id();
          values[v] = { count: what };
          counts.push([ck, (raw) => toNumber(raw[v] ?? 0)]);
          if (what === "nodes") native.push(v);
        }
        out.push([key, (raw) => Object.fromEntries(counts.map(([k, f]) => [k, f(raw)]))]);
        continue;
      }
      const isEdge = name === "edge";
      if (name !== "node" && !isEdge) throw new Fallback(`aggregate selection ${name}`);
      if (isEdge && (!edges || !props)) throw new Fallback("edge aggregate without properties");
      const attributes = isEdge ? props!.attributes : node.attributes;
      const fields = isEdge ? this.schema.edgeFields.get(props!.name) : engine.fields;
      const fieldOuts: Out[] = [];
      for (const [fk, fn] of collectFields(this.info, subSelections(nodes))) {
        const fname = fn[0]!.name.value;
        if (fname === "__typename") continue;
        const attr = attributes.find((a) => a.name === fname);
        const field = attr && !attr.cypher ? fields?.get(attr.name) : undefined;
        if (!attr || !field) throw new Fallback(`aggregate on ${fname}`);
        const decode = aggregateValueDecoder(attr.type.name);
        const string = attr.type.name === "String";
        const ops: Out[] = [];
        for (const [ok, on] of collectFields(this.info, subSelections(fn))) {
          const op = on[0]!.name.value;
          if (op === "__typename") continue;
          const engineFn = string
            ? op === "longest" || op === "shortest"
              ? op
              : undefined
            : op === "average"
              ? "avg"
              : op === "min" || op === "max" || op === "sum"
                ? op
                : undefined;
          if (!engineFn) {
            ops.push([ok, () => null]);
            continue;
          }
          const v = id();
          values[v] = { [isEdge ? "edge" : "node"]: field, fn: engineFn };
          ops.push([ok, (raw) => decode(raw[v])]);
        }
        fieldOuts.push([fk, (raw) => Object.fromEntries(ops.map(([k, f]) => [k, f(raw)]))]);
      }
      out.push([key, (raw) => Object.fromEntries(fieldOuts.map(([k, f]) => [k, f(raw)]))]);
    }
    const shape = (raw: AnyRecord) => Object.fromEntries(out.map(([k, f]) => [k, f(raw)]));
    if (gateKey === undefined) return { values, native, shape };
    // Gated: only the number of nodes is read (no value leaves the database). With some, v7
    // answers `Forbidden`; without any, the values of an empty set: counts and sums 0, the others
    // null.
    const empty: AnyRecord = {};
    for (const [v, spec] of Object.entries(values)) {
      const s = spec as AnyRecord;
      if (s.count !== undefined || s.fn === "sum") empty[v] = neo4jInt(0);
    }
    return {
      values: { [gateKey]: values[gateKey] },
      native: [gateKey],
      shape: (raw) => {
        if (toNumber(raw[gateKey] ?? 0) > 0) throw forbidden();
        return shape(empty);
      },
    };
  }

  /**
   * The `AGGREGATE` side of an `aggregate` selection on `node` (`@authentication` with the
   * aggregated attributes, the `filter` rules, validations that hold): its filter.
   */
  private aggregateRules(
    node: NodeType,
    fieldNodes: readonly FieldNode[],
  ): { filter: Filter; forbidden: boolean } {
    const aggNodeFields = [...collectFields(this.info, subSelections(fieldNodes))]
      .filter(([, n]) => n[0]!.name.value === "node")
      .flatMap(([, n]) => n);
    const attrs = this.selectedAttributes(node, aggNodeFields);
    this.authenticate(
      node,
      "AGGREGATE",
      attrs.map((a) => a.name),
    );
    // A validation that fails for the request: the compiler answers `Forbidden` when it aggregates
    // any node.
    const forbidden = !this.rules.holds(node, "AGGREGATE", "BEFORE", attrs);
    return { filter: this.rules.filter(node, "AGGREGATE", attrs), forbidden };
  }

  /** `actorsConnection(where, sort, first, after)` on a node selection. */
  private relationshipConnection(
    engine: EngineNode,
    rel: Relationship,
    args: AnyRecord,
    fieldNodes: readonly FieldNode[],
    counts: Counts,
  ): { select: AnyRecord; shape: Shape } {
    const { name: own, target } = this.where.relation(engine.v7, rel);
    // A to-one connection lists every edge the compiler finds (data may have several): it reads
    // the to-many relation over the same edges.
    const relation = rel.list ? own : engine.allEdges.get(rel.name);
    if (relation === undefined) throw new Fallback("to-one connection");
    this.authenticate(target, "READ");
    const afterOffset = cursorToOffset(args.after);
    const offset = afterOffset === undefined ? 0 : afterOffset + 1;
    const { conn, edgeFieldNodes, aggregates, needsEdges, needsTotal } =
      this.connectionNeeds(fieldNodes);
    // Only the edges are a load (a `CALL` clause when a statement of the filter aggregates).
    const inLoad = <T>(translate: () => T): T =>
      !needsTotal && aggregates.length === 0 ? this.atLoad(translate) : translate();
    const connectionWhere = inLoad(() => this.where.connection(rel, target, args.where));
    const select: AnyRecord = {};
    const aggregateShapes = new Map<string, Shape>();
    for (const [key, nodes] of aggregates) {
      const rules = this.aggregateRules(target, nodes);
      const aggWhere = rootWhere(allOf([connectionWhere, rules.filter]));
      const props = rel.properties ? this.model.properties.get(rel.properties) : undefined;
      const a = this.aggregateValues(target, props, nodes, true, rules.forbidden);
      const k = this.key(engine);
      select[k] = {
        $aggregate: {
          $relation: relation,
          ...(aggWhere !== undefined ? { where: aggWhere } : {}),
          values: a.values,
        },
      };
      aggregateShapes.set(key, (row) => a.shape((row[k] ?? {}) as AnyRecord));
    }
    // The READ rules apply to `totalCount` and `edges` (the compiler gates only those).
    const where =
      needsEdges || needsTotal
        ? rootWhere(
            allOf([
              connectionWhere,
              inLoad(() =>
                this.rules.read(
                  target,
                  this.selectedAttributes(target, this.edgeNodeFields(fieldNodes)),
                ),
              ),
            ]),
          )
        : undefined;
    const orderBy = this.connectionOrder(rel, target, args.sort);
    let rowsKey: string | undefined;
    let edge: ((row: AnyRecord, index: number) => AnyRecord) | undefined;
    if (needsEdges) {
      const e = this.edges(target, edgeFieldNodes, rel, offset);
      edge = e.edge;
      rowsKey = this.key(engine);
      const skip = offset || undefined;
      const take = count(pageLimit(target, args.first));
      select[rowsKey] = {
        $relation: relation,
        ...(where !== undefined ? { where } : {}),
        ...(orderBy !== undefined ? { orderBy } : {}),
        ...(skip !== undefined ? { skip } : {}),
        ...(take !== undefined ? { take } : {}),
        select: e.select,
      };
    }
    // `_count` counts each relation once per projection; another count of it is the number of
    // its edges (each matching path, like the compiler's `COUNT { … }`).
    let totalKey: string | undefined;
    if (needsTotal) {
      if (!counts.has(relation)) counts.set(relation, where === undefined ? true : { where });
      else {
        totalKey = this.key(engine);
        select[totalKey] = {
          $aggregate: {
            $relation: relation,
            ...(where !== undefined ? { where } : {}),
            values: { total: { count: "edges" } },
          },
        };
      }
    }
    return {
      select,
      shape: (row) => {
        const raw = rowsKey === undefined ? [] : row[rowsKey];
        const rows = (Array.isArray(raw) ? raw : raw ? [raw] : []) as AnyRecord[];
        const total = !needsTotal
          ? 0
          : totalKey !== undefined
            ? toNumber(((row[totalKey] ?? {}) as AnyRecord).total ?? 0)
            : ((((row._count ?? {}) as AnyRecord)[relation] as number | undefined) ?? 0);
        const edges = edge ? rows.map((r, i) => edge(r, i)) : [];
        const value = this.connectionValue(conn, target, args, offset, edges, total);
        for (const [key, shape] of aggregateShapes) value[key] = shape(row);
        return value;
      },
    };
  }

  /** `edge: { role: ASC }` of a connection sort → `{ $edge: { role: "asc" } }` items. */
  private edgeSortItems(rel: Relationship, sort: unknown): AnyRecord[] {
    const props = this.model.properties.get(rel.properties!);
    if (!props || keyedConnectionEdge(this.model, rel)) throw new Fallback("keyed edge sort");
    const fields = this.schema.edgeFields.get(props.name);
    const items: AnyRecord[] = [];
    if (!isPlainObject(sort)) return items;
    for (const [name, dir] of Object.entries(sort)) {
      if (dir !== "ASC" && dir !== "DESC") continue;
      const attr = props.attributes.find((a) => a.name === name);
      if (attr?.cypher) {
        if (this.write) throw new Fallback("sort on a @cypher edge property, in a mutation");
        items.push({ $edge: { $call: this.cypherSort(attr, dir) } });
        continue;
      }
      const field = attr ? fields?.get(attr.name) : undefined;
      if (!field) throw new Fallback(`sort on ${props.name}.${name}`);
      items.push({ $edge: { [field]: dir === "ASC" ? "asc" : "desc" } });
    }
    return items;
  }

  /** A connection `sort` (`[{ node: … }, { edge: … }]`) → engine `orderBy` on the related node. */
  private connectionOrder(
    rel: Relationship,
    target: NodeType,
    sort: unknown,
  ): AnyRecord[] | undefined {
    const engine = this.where.engineNode(target);
    const items: AnyRecord[] = [];
    for (const s of Array.isArray(sort) ? sort : []) {
      if (s === null || typeof s !== "object") continue;
      for (const [k, v] of Object.entries(s as AnyRecord)) {
        if (k === "node" && isPlainObject(v)) items.push(...this.sortItems(engine, v));
        else if (k === "edge" && rel.properties && v !== null && v !== undefined) {
          items.push(...this.edgeSortItems(rel, v));
        }
      }
    }
    return items.length ? items : undefined;
  }

  /** `movies(where, sort, limit, offset)`. */
  rootList(node: NodeType, args: AnyRecord, fieldNodes: readonly FieldNode[]): ReadPlan {
    const p = this.node(node, fieldNodes);
    const findArgs = { ...this.listArgs(node, args, fieldNodes, true), select: p.select };
    return async (client) => {
      const rows = (await delegate(client, node.name).findMany!(findArgs)) as AnyRecord[];
      return rows.map(p.shape);
    };
  }

  /**
   * A `Query` / `Mutation` `@cypher` field (the compiler's `rootCypher`): the rows of its statement
   * (`runCypherFragment`; a list column flattened), or for a field returning nodes the nodes of its
   * rows that the READ rules of their type let through, projected (`findMany` with `$from`; the
   * type's `@limit` for a list). A field that is not a list takes the first row. A mutation runs
   * in a write transaction (one statement, like the compiler's).
   */
  rootCypher(
    field: CypherRootField,
    args: AnyRecord,
    fieldNodes: readonly FieldNode[],
    mutation: boolean,
  ): ReadPlan {
    const list = field.type.list;
    if (field.kind !== "node") {
      const decode = attributeDecoder({ kind: field.kind, type: field.type });
      const statement = rootScalarStatement(field.cypher, field.args, args, this.jwt, list);
      return async (client) => {
        const rows = await runCypherFragment(client, statement, { write: mutation });
        if (list) return rows.map((r) => decode(r.value));
        return rows.length ? decode(rows[0]!.value) : null;
      };
    }
    const target = this.model.node(field.type.name);
    this.where.engineNode(target);
    this.authenticate(target, "READ");
    const where = rootWhere(
      this.atRoot(() => this.rules.read(target, this.selectedAttributes(target, fieldNodes))),
    );
    const p = this.node(target, fieldNodes);
    const take = list ? count(pageLimit(target, undefined)) : undefined;
    const findArgs: AnyRecord = {
      $from: rootNodesCall(field.cypher, field.args, args, this.jwt),
      ...(where !== undefined ? { where } : {}),
      ...(take !== undefined ? { take } : {}),
      select: p.select,
    };
    return async (client) => {
      const read = async (db: object) =>
        (await delegate(db, target.name).findMany!(findArgs)) as AnyRecord[];
      const rows = mutation ? await inWriteTransaction(client, read) : await read(client);
      if (list) return rows.map(p.shape);
      return rows.length ? p.shape(rows[0]!) : null;
    };
  }

  /** `moviesConnection(where, sort, first, after)`. */
  rootConnection(node: NodeType, args: AnyRecord, fieldNodes: readonly FieldNode[]): ReadPlan {
    this.where.engineNode(node);
    this.authenticate(node, "READ");
    const afterOffset = cursorToOffset(args.after);
    const offset = afterOffset === undefined ? 0 : afterOffset + 1;
    const { conn, edgeFieldNodes, aggregates, needsEdges, needsTotal } =
      this.connectionNeeds(fieldNodes);
    const aggregatePlans = aggregates.map(([key, nodes]) => {
      const rules = this.aggregateRules(node, nodes);
      const a = this.aggregateValues(node, undefined, nodes, false, rules.forbidden);
      // The values are subqueries of the aggregate's result: `@cypher` filters that aggregate
      // cannot be in them (see `cypher.ts`).
      const valuesOnly = Object.keys(a.values).filter((v) => !a.native.includes(v));
      const filter = (): Filter => allOf([this.where.node(node, args.where), rules.filter]);
      const aggWhere = rootWhere(valuesOnly.length ? filter() : this.atRoot(filter));
      const aggregateArgs: AnyRecord = {
        ...(aggWhere !== undefined ? { where: aggWhere } : {}),
        ...(a.native.length ? { _count: true } : {}),
        ...(valuesOnly.length
          ? { $values: Object.fromEntries(valuesOnly.map((v) => [v, a.values[v]])) }
          : {}),
      };
      return {
        key,
        run: async (db: object) => {
          const r = (await delegate(db, node.name).aggregate!(aggregateArgs)) as AnyRecord;
          const raw: AnyRecord = { ...((r.$values ?? {}) as AnyRecord) };
          for (const v of a.native) raw[v] = r._count;
          return a.shape(raw);
        },
      };
    });
    // The READ rules apply to `totalCount` and `edges` (the compiler gates only those).
    const where = rootWhere(
      this.atRoot(() => {
        const parts: Filter[] = [this.where.node(node, args.where)];
        if (needsEdges || needsTotal) {
          const attrs = this.selectedAttributes(node, this.edgeNodeFields(fieldNodes));
          parts.push(this.rules.read(node, attrs));
        }
        return allOf(parts);
      }),
    );
    const orderBy = this.orderBy(node, args.sort);
    const e = needsEdges ? this.edges(node, edgeFieldNodes, undefined, offset) : undefined;
    const skip = offset || undefined;
    const take = count(pageLimit(node, args.first));
    const findArgs: AnyRecord = {
      ...(where !== undefined ? { where } : {}),
      ...(orderBy !== undefined ? { orderBy } : {}),
      ...(skip !== undefined ? { skip } : {}),
      ...(take !== undefined ? { take } : {}),
      select: e?.select ?? {},
    };
    const countArgs = where !== undefined ? { where } : {};
    const reads = (needsEdges ? 1 : 0) + (needsTotal ? 1 : 0) + aggregatePlans.length;
    return async (client) => {
      const run = async (db: object) => {
        const d = delegate(db, node.name);
        const rows = needsEdges ? ((await d.findMany!(findArgs)) as AnyRecord[]) : [];
        const total = needsTotal ? ((await d.count!(countArgs)) as number) : 0;
        const values: [string, AnyRecord][] = [];
        for (const p of aggregatePlans) values.push([p.key, await p.run(db)]);
        return { rows, total, values };
      };
      // Every read in one transaction, like the compiler's one statement.
      const { rows, total, values } =
        reads > 1 ? await withReadTransaction(client, run) : await run(client);
      const edges = e ? rows.map((r, i) => e.edge(r, i)) : [];
      const value = this.connectionValue(conn, node, args, offset, edges, total);
      for (const [key, v] of values) value[key] = v;
      return value;
    };
  }

  /**
   * `booksByTitle(phrase, where: { score, node }, sort, first, after)`: an engine `search` of the
   * index in the order v7 gives (its `sort`, else the index's), and the number of hits for
   * `totalCount` / `pageInfo` (a second search in the same transaction).
   */
  rootFulltext(
    node: NodeType,
    index: FulltextIndex,
    args: AnyRecord,
    fieldNodes: readonly FieldNode[],
  ): ReadPlan {
    const engine = this.where.engineNode(node);
    if (!engine.model.fulltextIndexes?.some((i) => i.name === index.indexName)) {
      throw new Fallback(`full-text index ${index.indexName}`);
    }
    this.authenticate(node, "READ");
    const phrase = args.phrase;
    // Lucene rejects an empty query (the compiler's statement fails); the engine answers nothing.
    if (typeof phrase !== "string" || phrase.trim() === "") throw new Fallback("empty phrase");
    const conn = collectFields(this.info, subSelections(fieldNodes));
    const edgeFields = [...conn]
      .filter(([, n]) => n[0]!.name.value === "edges")
      .flatMap(([, n]) => n);
    const nodeFields = [...collectFields(this.info, subSelections(edgeFields))]
      .filter(([, n]) => n[0]!.name.value === "node")
      .flatMap(([, n]) => n);
    const where = isPlainObject(args.where) ? args.where : {};
    const score = isPlainObject(where.score) ? where.score : {};
    const filter = rootWhere(
      this.atRoot(() =>
        allOf([
          this.where.node(node, where.node),
          this.rules.read(node, this.selectedAttributes(node, nodeFields)),
        ]),
      ),
    );
    const orderBy: AnyRecord[] = [];
    for (const s of Array.isArray(args.sort) ? args.sort : []) {
      if (s === null || typeof s !== "object") continue;
      for (const [k, dir] of Object.entries(s as AnyRecord)) {
        if (k === "score" && (dir === "ASC" || dir === "DESC")) {
          orderBy.push({ $score: dir === "ASC" ? "asc" : "desc" });
        } else if (k === "node" && isPlainObject(dir)) orderBy.push(...this.sortItems(engine, dir));
      }
    }
    const afterOffset = cursorToOffset(args.after);
    const offset = afterOffset === undefined ? 0 : afterOffset + 1;
    const take = count(pageLimit(node, args.first));
    // The engine answers `take: 0` without running the query (the compiler runs it).
    if (take === 0) throw new Fallback("first: 0");
    const searchArgs: AnyRecord = {
      index: index.indexName,
      query: phrase,
      ...(filter !== undefined ? { where: filter } : {}),
      ...(typeof score.min === "number" ? { minScore: score.min } : {}),
      ...(typeof score.max === "number" ? { $maxScore: score.max } : {}),
      $orderBy: orderBy,
    };
    const decoders: [string, (row: AnyRecord, i: number) => unknown][] = [];
    const select: AnyRecord = {};
    for (const [key, nodes] of collectFields(this.info, subSelections(edgeFields))) {
      const name = nodes[0]!.name.value;
      if (name === "cursor") decoders.push([key, (_r, i) => offsetToCursor(offset + i)]);
      else if (name === "score") decoders.push([key, (r) => r.$score]);
      else if (name === "node") {
        const p = this.node(node, nodes);
        Object.assign(select, p.select);
        decoders.push([key, (r) => p.shape(r)]);
      }
    }
    let needsEdges = false;
    let needsTotal = false;
    for (const [, nodes] of conn) {
      const name = nodes[0]!.name.value;
      if (name === "edges" || name === "pageInfo") needsEdges = true;
      if (name === "totalCount" || name === "pageInfo") needsTotal = true;
    }
    const pageArgs = {
      ...searchArgs,
      ...(offset ? { skip: offset } : {}),
      ...(take !== undefined ? { take } : {}),
      select,
    };
    return async (client) => {
      const run = async (db: object) => {
        const d = delegate(db, node.name);
        const rows = needsEdges ? ((await d.search!(pageArgs)) as AnyRecord[]) : [];
        const total = needsTotal
          ? ((await d.search!({ ...searchArgs, $orderBy: [], select: {} })) as unknown[]).length
          : 0;
        return { rows, total };
      };
      const { rows, total } =
        needsEdges && needsTotal ? await withReadTransaction(client, run) : await run(client);
      const list = rows.map((r, i) => Object.fromEntries(decoders.map(([k, d]) => [k, d(r, i)])));
      const out: AnyRecord = {};
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
            else if (n === "endCursor") {
              info[pk] = list.length ? offsetToCursor(offset + list.length - 1) : null;
            }
          }
          out[key] = info;
        }
      }
      return out;
    };
  }
}
