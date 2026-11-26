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
 * Anything else throws {@link Fallback} (connection `aggregate`, edge filters and sorts, `@cypher`
 * fields, custom resolvers' fields, interfaces, unions, rules, …).
 *
 * @packageDocumentation
 */

import { getArgumentValues, type FieldNode, type GraphQLObjectType } from "graphql";
import { withReadTransaction } from "@cyphra/runtime";
import {
  attributeDecoder,
  collectFields,
  cursorToOffset,
  narrowFieldNodes,
  offsetToCursor,
  pageLimit,
  subSelections,
  type SelectionInfo,
} from "../cypher/select.js";
import { keyedConnectionEdge, type NodeType, type Relationship, type V7Model } from "../model.js";
import type { EngineNode, EngineSchema } from "./schema.js";
import { Fallback, WhereTranslator, isPlainObject, rootWhere } from "./where.js";

type AnyRecord = Record<string, unknown>;
type Shape = (row: AnyRecord) => unknown;
type Delegate = Record<string, (args: AnyRecord) => Promise<unknown>>;

/** A translated selection: the engine `select` and how to shape one row of it. */
type Projection = { select: AnyRecord; shape: (row: AnyRecord) => AnyRecord };

/** A translated root field, run on the request's engine client. */
export type ReadPlan = (client: object) => Promise<unknown>;

/** The delegate of a model on an ORM client. */
export function delegate(client: object, model: string): Delegate {
  const d = (client as Record<string, unknown>)[model.charAt(0).toLowerCase() + model.slice(1)];
  if (!d) throw new Error(`Internal error: the engine client has no delegate for ${model}.`);
  return d as Delegate;
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
  private keys = 0;

  constructor(
    private readonly model: V7Model,
    schema: EngineSchema,
    private readonly info: SelectionInfo,
  ) {
    this.where = new WhereTranslator(model, schema);
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
      const field = attr && !attr.cypher ? engine.fields.get(attr.name) : undefined;
      if (!field) throw new Fallback(`sort on ${engine.v7.name}.${name}`);
      items.push({ [field]: dir === "ASC" ? "asc" : "desc" });
    }
    return items;
  }

  /** `where`, `sort`, `offset`, `limit` of a node list → engine arguments. */
  private listArgs(node: NodeType, args: AnyRecord): AnyRecord {
    const where = rootWhere(this.where.node(node, args.where));
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
    for (const [key, nodes] of collectFields(this.info, subSelections(fieldNodes))) {
      const name = nodes[0]!.name.value;
      if (name === "__typename") continue;
      if (node.userFields.some((f) => f.name === name)) throw new Fallback("custom resolver field");
      const attr = node.attributes.find((a) => a.name === name);
      if (attr) {
        const field = attr.cypher ? undefined : engine.fields.get(attr.name);
        if (!field) throw new Fallback(`${node.name}.${name}`);
        select[field] = true;
        const decode = attributeDecoder(attr);
        shapers.push([key, (row) => decode(row[field])]);
        continue;
      }
      const gqlField = gqlFields[name];
      if (!gqlField || node.cypherNodes.some((c) => c.name === name)) {
        throw new Fallback(`${node.name}.${name}`);
      }
      const args = getArgumentValues(gqlField, nodes[0]!, this.info.variableValues);
      const rel = node.relationships.find((r) => r.name === name);
      if (rel) {
        const { name: relation, target } = this.where.relation(node, rel);
        const inner = this.node(target, nodes);
        const k = this.key(engine);
        select[k] = { $relation: relation, ...this.listArgs(target, args), select: inner.select };
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
        const fields: [string, Shape][] = [];
        const narrowed = narrowFieldNodes(this.info, nodes, props.name, props.name);
        for (const [pk, pn] of collectFields(this.info, subSelections(narrowed))) {
          const pname = pn[0]!.name.value;
          if (pname === "__typename") continue;
          const attr = props.attributes.find((a) => a.name === pname);
          if (!attr || attr.cypher || attr.variants) throw new Fallback(`${props.name}.${pname}`);
          const decode = attributeDecoder(attr);
          fields.push([pk, (edge) => decode(edge[attr.property])]);
        }
        decoders.push([
          key,
          (row) => {
            const edge = (row.$edge ?? {}) as AnyRecord;
            const out: AnyRecord = { __typename: props.name };
            for (const [pk, shape] of fields) out[pk] = shape(edge);
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
    needsEdges: boolean;
    needsTotal: boolean;
  } {
    const conn = collectFields(this.info, subSelections(fieldNodes));
    const edgeFieldNodes: FieldNode[] = [];
    let needsEdges = false;
    let needsTotal = false;
    for (const [, nodes] of conn) {
      const name = nodes[0]!.name.value;
      if (name === "aggregate") throw new Fallback("connection aggregate");
      if (name === "edges") edgeFieldNodes.push(...nodes);
      if (name === "edges" || name === "pageInfo") needsEdges = true;
      if (name === "totalCount" || name === "pageInfo") needsTotal = true;
    }
    return { conn, edgeFieldNodes, needsEdges, needsTotal };
  }

  /** `actorsConnection(where, sort, first, after)` on a node selection. */
  private relationshipConnection(
    engine: EngineNode,
    rel: Relationship,
    args: AnyRecord,
    fieldNodes: readonly FieldNode[],
    counts: Counts,
  ): { select: AnyRecord; shape: Shape } {
    const { name: relation, target } = this.where.relation(engine.v7, rel);
    // A to-one connection lists every edge the compiler finds (data may have several).
    if (!rel.list) throw new Fallback("to-one connection");
    const afterOffset = cursorToOffset(args.after);
    const offset = afterOffset === undefined ? 0 : afterOffset + 1;
    const { conn, edgeFieldNodes, needsEdges, needsTotal } = this.connectionNeeds(fieldNodes);
    const where = rootWhere(this.where.connection(rel, target, args.where));
    const orderBy = this.connectionOrder(rel, target, args.sort);
    const select: AnyRecord = {};
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
    if (needsTotal) {
      // One count per relation in a projection, and only of to-many relations.
      if (!rel.list || counts.has(relation)) throw new Fallback("connection totalCount");
      counts.set(relation, where === undefined ? true : { where });
    }
    return {
      select,
      shape: (row) => {
        const raw = rowsKey === undefined ? [] : row[rowsKey];
        const rows = (Array.isArray(raw) ? raw : raw ? [raw] : []) as AnyRecord[];
        const total = needsTotal
          ? ((((row._count ?? {}) as AnyRecord)[relation] as number | undefined) ?? 0)
          : 0;
        const edges = edge ? rows.map((r, i) => edge(r, i)) : [];
        return this.connectionValue(conn, target, args, offset, edges, total);
      },
    };
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
          throw new Fallback("edge sort");
        }
      }
    }
    return items.length ? items : undefined;
  }

  /** `movies(where, sort, limit, offset)`. */
  rootList(node: NodeType, args: AnyRecord, fieldNodes: readonly FieldNode[]): ReadPlan {
    const p = this.node(node, fieldNodes);
    const findArgs = { ...this.listArgs(node, args), select: p.select };
    return async (client) => {
      const rows = (await delegate(client, node.name).findMany!(findArgs)) as AnyRecord[];
      return rows.map(p.shape);
    };
  }

  /** `moviesConnection(where, sort, first, after)`. */
  rootConnection(node: NodeType, args: AnyRecord, fieldNodes: readonly FieldNode[]): ReadPlan {
    this.where.engineNode(node);
    const afterOffset = cursorToOffset(args.after);
    const offset = afterOffset === undefined ? 0 : afterOffset + 1;
    const { conn, edgeFieldNodes, needsEdges, needsTotal } = this.connectionNeeds(fieldNodes);
    const where = rootWhere(this.where.node(node, args.where));
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
    return async (client) => {
      const run = async (db: object) => {
        const d = delegate(db, node.name);
        const rows = needsEdges ? ((await d.findMany!(findArgs)) as AnyRecord[]) : [];
        const total = needsTotal ? ((await d.count!(countArgs)) as number) : 0;
        return { rows, total };
      };
      // The page and its total are read in one transaction, like the compiler's one statement.
      const { rows, total } =
        needsEdges && needsTotal ? await withReadTransaction(client, run) : await run(client);
      const edges = e ? rows.map((r, i) => e.edge(r, i)) : [];
      return this.connectionValue(conn, node, args, offset, edges, total);
    };
  }
}
