/**
 * Translates a GraphQL root field (arguments and selection set) into the arguments of one client
 * operation, and the client's result back into a response keyed by response key (aliases).
 *
 * The selection is collected per concrete type, as GraphQL executes it: fragments are resolved,
 * `@skip` / `@include` applied, variables substituted. A selection on an interface or a union
 * becomes the client's `$on`: one projection per implementation, evaluated only on its nodes.
 * A relation selected twice under different aliases becomes aliased relation loads
 * (`{ alias: { $relation, … } }`), so the whole selection is one statement.
 *
 * @packageDocumentation
 */

import {
  GraphQLIncludeDirective,
  GraphQLSkipDirective,
  Kind,
  getArgumentValues,
  getDirectiveValues,
  isAbstractType,
  type FieldNode,
  type GraphQLField,
  type GraphQLObjectType,
  type GraphQLResolveInfo,
  type GraphQLSchema,
  type SelectionSetNode,
} from "graphql";
import type {
  ResolvedNodeModel,
  ResolvedRelationField,
  ResolvedRelationshipModel,
  ResolvedScalarField,
} from "@cyphra/schema";
import type { ApiModel } from "./api.js";
import { forbidden, type RequestAuth } from "./auth.js";
import type { Limits } from "./config.js";
import { badInput, limitError } from "./errors.js";
import { toGlobalId } from "./relay.js";
import { names, TYPE } from "./schema.js";

type AnyRecord = Record<string, unknown>;
type Shaped = Record<string | symbol, unknown>;

/** Rows a list is assumed to load when it sets no `take` and there is no `maxTake`. */
const DEFAULT_ROWS = 100;

/** Keys the client gives a meaning in `select` and in its rows: never used for an aliased load. */
const RESERVED_KEY = /^(\$|__)|^_count$/;

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The client `select` of one selection, how to shape its rows, and its estimated row count. */
export type Translation = {
  readonly select: AnyRecord;
  readonly shape: (row: AnyRecord) => Shaped;
  /** Rows the nested relation loads may read (for `limits.maxComplexity`). */
  readonly cost: number;
};

/** Collected fields of one selection on one type: response key → field nodes. */
type Fields = Map<string, FieldNode[]>;

/** A point input without its absent axes (`height: null` is "no height"). */
export function cleanPoint(v: unknown): unknown {
  if (!isPlainObject(v)) return v;
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined));
}

/** Translates the root field being resolved; one per resolver call. */
export class Translator {
  private readonly gql: GraphQLSchema;
  private readonly aliased = new Set<FieldNode>();

  constructor(
    private readonly api: ApiModel,
    private readonly info: GraphQLResolveInfo,
    private readonly limits: Limits,
    /** The request's auth: context-only field rules it denies. */
    private readonly auth?: RequestAuth,
  ) {
    this.gql = info.schema;
  }

  /** Fail when a context-only field rule denies `model.field` to the request (filter, sort, …). */
  private usable(model: ResolvedNodeModel, field: string, use: string): void {
    if (this.auth?.fieldDenied(model, field)) throw this.auth.fieldForbidden(model, field, use);
  }

  /** The selection sets of the root field being resolved. */
  rootSelections(): SelectionSetNode[] {
    return this.info.fieldNodes.flatMap((n) => (n.selectionSet ? [n.selectionSet] : []));
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  private included(node: { directives?: readonly unknown[] }): boolean {
    const n = node as FieldNode;
    if (!n.directives?.length) return true;
    const vars = this.info.variableValues;
    if (getDirectiveValues(GraphQLSkipDirective, n, vars)?.if === true) return false;
    if (getDirectiveValues(GraphQLIncludeDirective, n, vars)?.if === false) return false;
    return true;
  }

  private applies(condition: string | undefined, typeName: string): boolean {
    if (!condition || condition === typeName) return true;
    const cond = this.gql.getType(condition);
    const type = this.gql.getType(typeName);
    if (!cond || !type || !isAbstractType(cond)) return false;
    return this.gql.isSubType(cond, type as GraphQLObjectType);
  }

  /** The fields selected on `typeName` (a concrete type, or a type without fragments). */
  collect(sets: readonly SelectionSetNode[], typeName: string, out: Fields = new Map()): Fields {
    for (const set of sets) {
      for (const sel of set.selections) {
        if (!this.included(sel)) continue;
        if (sel.kind === Kind.FIELD) {
          const key = sel.alias?.value ?? sel.name.value;
          if (sel.alias && sel.alias.value !== sel.name.value) this.aliased.add(sel);
          const list = out.get(key);
          if (list) list.push(sel);
          else out.set(key, [sel]);
        } else if (sel.kind === Kind.INLINE_FRAGMENT) {
          if (this.applies(sel.typeCondition?.name.value, typeName)) {
            this.collect([sel.selectionSet], typeName, out);
          }
        } else {
          const frag = this.info.fragments[sel.name.value];
          if (frag && this.applies(frag.typeCondition.name.value, typeName)) {
            this.collect([frag.selectionSet], typeName, out);
          }
        }
      }
    }
    return out;
  }

  private subSelections(nodes: readonly FieldNode[]): SelectionSetNode[] {
    return nodes.flatMap((n) => (n.selectionSet ? [n.selectionSet] : []));
  }

  private fieldDef(typeName: string, name: string): GraphQLField<unknown, unknown> {
    const t = this.gql.getType(typeName) as GraphQLObjectType | undefined;
    const f = t?.getFields()[name];
    if (!f) throw badInput(`Unknown field "${typeName}.${name}".`);
    return f;
  }

  args(typeName: string, node: FieldNode): AnyRecord {
    return getArgumentValues(
      this.fieldDef(typeName, node.name.value),
      node,
      this.info.variableValues,
    );
  }

  /** `take` with `limits.maxTake` applied: the default when absent, and the cap. */
  take(value: unknown, where: string): number | undefined {
    const max = this.limits.maxTake;
    if (value === undefined || value === null) return max;
    if (max !== undefined && typeof value === "number" && value > max) {
      throw limitError("maxTake", `${where}: take ${value} is above the limit (maxTake: ${max}).`);
    }
    return value as number;
  }

  /** Checks `maxAliases` (call once the whole selection is translated). */
  checkAliases(): void {
    const max = this.limits.maxAliases;
    if (max !== undefined && this.aliased.size > max) {
      throw limitError(
        "maxAliases",
        `The selection has ${this.aliased.size} aliased fields; the limit is ${max} (maxAliases).`,
      );
    }
  }

  /** Checks `maxComplexity` for a root loading `rows` rows with nested loads costing `cost`. */
  checkComplexity(rows: number, cost: number): void {
    const max = this.limits.maxComplexity;
    if (max !== undefined && rows + cost > max) {
      throw limitError(
        "maxComplexity",
        `The query may load up to ${rows + cost} rows; the limit is ${max} (maxComplexity). Lower take or select fewer relations.`,
      );
    }
  }

  /** Rows a list loads at most, for the complexity estimate. */
  listRows(take: number | undefined): number {
    return take ?? this.limits.maxTake ?? DEFAULT_ROWS;
  }

  /**
   * The `select` of a selection on `model` (concrete or abstract) and how to shape the rows.
   * `edge`: the edge model of the relation the nodes are reached through (for `_edge`).
   */
  node(
    model: ResolvedNodeModel,
    sets: readonly SelectionSetNode[],
    edge: ResolvedRelationshipModel | undefined,
    depth: number,
    rows: number,
  ): Translation {
    if (!model.abstract)
      return this.concrete(model, this.collect(sets, model.name), edge, depth, rows);
    const on: AnyRecord = {};
    const shapes = new Map<string, Translation["shape"]>();
    let cost = 0;
    for (const impl of this.api.concrete(model)) {
      const t = this.concrete(impl, this.collect(sets, impl.name), edge, depth, rows, false);
      if (Object.keys(t.select).length > 0) on[impl.name] = t.select;
      shapes.set(impl.name, t.shape);
      cost = Math.max(cost, t.cost);
    }
    const select = Object.keys(on).length > 0 ? { $on: on } : {};
    return {
      select,
      cost,
      shape: (row) => {
        const typename = row.__typename as string;
        const shape = shapes.get(typename);
        if (!shape) {
          throw new Error(
            `A ${model.name} node has none of the labels of its implementations (${[...shapes.keys()].join(", ")}).`,
          );
        }
        return shape(row);
      },
    };
  }

  private concrete(
    model: ResolvedNodeModel,
    fields: Fields,
    edge: ResolvedRelationshipModel | undefined,
    depth: number,
    rows: number,
    nonEmpty = true,
  ): Translation {
    const select: AnyRecord = {};
    const parts: ((row: AnyRecord, out: Shaped) => void)[] = [];
    const scalarNames = new Set(model.fields.filter((f) => f.kind === "scalar").map((f) => f.name));
    const usedKeys = new Set(fields.keys());
    let generated = 0;
    const loadKey = (key: string, relation: string): string => {
      if (key === relation) return key;
      if (!RESERVED_KEY.test(key) && !scalarNames.has(key)) return key;
      let k: string;
      do k = `r${generated++}_${relation}`;
      while (usedKeys.has(k) || scalarNames.has(k));
      usedKeys.add(k);
      return k;
    };
    let cost = 0;
    const counts: AnyRecord = {};

    for (const [key, nodes] of fields) {
      const first = nodes[0]!;
      const name = first.name.value;
      if (name === "__typename") continue;
      if (name === "_edge") {
        if (!edge) {
          throw badInput(
            `_edge is only available on ${model.name} reached through a relation with a relationship model.`,
          );
        }
        parts.push((row, out) => {
          const e = row.$edge;
          out[key] = isPlainObject(e) ? { ...e, [TYPE]: edge.name } : null;
        });
        continue;
      }
      if (name === "_count") {
        const countType = names.count(model.name);
        const sub = this.collect(this.subSelections(nodes), countType);
        const keys: [string, string][] = [];
        for (const [k, ns] of sub) {
          const rel = ns[0]!.name.value;
          if (rel === "__typename") continue;
          this.usable(model, rel, "counted");
          const field = model.fields.find((f) => f.name === rel) as ResolvedRelationField;
          const where = this.where(this.api.node(field.target), this.args(countType, ns[0]!).where);
          const spec = where === undefined ? true : { where };
          const prev = counts[rel];
          if (prev !== undefined && JSON.stringify(prev) !== JSON.stringify(spec)) {
            throw badInput(
              `_count.${rel} is selected twice with different arguments; count it once per selection.`,
            );
          }
          counts[rel] = spec;
          keys.push([k, rel]);
        }
        parts.push((row, out) => {
          const c = (row._count ?? {}) as AnyRecord;
          const o: Shaped = { [TYPE]: countType };
          for (const [k, rel] of keys) o[k] = c[rel] ?? 0;
          out[key] = o;
        });
        continue;
      }
      if (name === "_labels") {
        select.$labels = true;
        parts.push((row, out) => {
          out[key] = row.$labels ?? [];
        });
        continue;
      }
      const relayKey = this.api.relayKey(model);
      if (name === "id" && relayKey) {
        select[relayKey.name] = true;
        parts.push((row, out) => {
          out[key] = toGlobalId(model.name, row[relayKey.name]);
        });
        continue;
      }
      const fieldName = this.api.fieldOfOutput(model, name);
      const field = model.fields.find((f) => f.name === fieldName);
      if (!field) throw badInput(`Unknown field "${model.name}.${name}".`);
      if (this.auth?.fieldDenied(model, fieldName)) {
        // Not read: `null` with a FORBIDDEN error at its path (the field is nullable).
        const error = forbidden(`${model.name}.${fieldName} is not readable by this request.`, {
          model: model.name,
          field: fieldName,
        });
        parts.push((_row, out) => {
          out[key] = error;
        });
        continue;
      }
      if (field.kind === "scalar") {
        select[fieldName] = true;
        parts.push((row, out) => {
          out[key] = row[fieldName] ?? null;
        });
        continue;
      }
      // A relation.
      if (this.limits.maxDepth !== undefined && depth + 1 > this.limits.maxDepth) {
        throw limitError(
          "maxDepth",
          `${model.name}.${name} is nested ${depth + 1} relations deep; the limit is ${this.limits.maxDepth} (maxDepth).`,
        );
      }
      const target = this.api.node(field.target);
      const args = this.args(model.name, first);
      const load: AnyRecord = {};
      let childRows = rows;
      if (field.many) {
        const where = this.where(target, args.where);
        if (where !== undefined) load.where = where;
        const orderBy = this.orderBy(target, args.orderBy);
        if (orderBy !== undefined) load.orderBy = orderBy;
        if (args.skip !== undefined && args.skip !== null) load.skip = args.skip;
        const take = this.take(args.take, `${model.name}.${name}`);
        if (take !== undefined) load.take = take;
        childRows = rows * this.listRows(take);
      }
      const edgeModel = field.edge ? this.api.edges.get(field.edge) : undefined;
      const sub = this.node(target, this.subSelections(nodes), edgeModel, depth + 1, childRows);
      cost += childRows + sub.cost;
      load.select = sub.select;
      const k = loadKey(key, name);
      select[k] = k === name ? load : { $relation: name, ...load };
      parts.push((row, out) => {
        const v = row[k];
        if (field.many) {
          out[key] = Array.isArray(v) ? v.map((x) => sub.shape(x as AnyRecord)) : [];
        } else {
          out[key] = isPlainObject(v) ? sub.shape(v) : null;
        }
      });
    }
    if (Object.keys(counts).length > 0) select._count = { select: counts };
    if (nonEmpty && Object.keys(select).length === 0) {
      // Only `__typename` (or `_edge`) selected: read one property so the projection is not empty.
      const any = model.fields.find((f): f is ResolvedScalarField => f.kind === "scalar");
      if (any) select[any.name] = true;
    }
    return {
      select,
      cost,
      shape: (row) => {
        const out: Shaped = { [TYPE]: model.name };
        for (const p of parts) p(row, out);
        return out;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Arguments
  // ---------------------------------------------------------------------------

  /** A GraphQL `<Model>Where` as the client's `where` (`_on` → `$on`, …), `undefined` if absent. */
  where(model: ResolvedNodeModel, w: unknown): AnyRecord | undefined {
    if (w === undefined || w === null) return undefined;
    if (!isPlainObject(w)) return undefined;
    const out: AnyRecord = {};
    for (const [k, v] of Object.entries(w)) {
      if (v === undefined) continue;
      switch (k) {
        case "AND":
        case "OR":
          if (Array.isArray(v)) out[k] = v.map((x) => this.where(model, x) ?? {});
          continue;
        case "NOT":
          if (v !== null) out.NOT = this.where(model, v) ?? {};
          continue;
        case "_typename":
          if (v !== null) out.__typename = v;
          continue;
        case "_labels":
          if (v !== null) out.$labels = v;
          continue;
        case "_count": {
          if (v === null) continue;
          const counts: AnyRecord = {};
          for (const [rel, filter] of Object.entries(v as AnyRecord)) {
            if (filter === undefined || filter === null) continue;
            const f = model.fields.find((x) => x.name === rel);
            if (f?.kind !== "relation")
              throw badInput(`Unknown relation "${model.name}.${rel}" in where._count.`);
            this.usable(model, rel, "counted");
            const ops: AnyRecord = {};
            for (const [op, x] of Object.entries(filter as AnyRecord)) {
              if (x === undefined || x === null) continue;
              ops[op] = op === "where" ? (this.where(this.api.node(f.target), x) ?? {}) : x;
            }
            counts[rel] = ops;
          }
          out._count = counts;
          continue;
        }
        case "_on": {
          if (v === null) continue;
          const on: AnyRecord = {};
          for (const [impl, sub] of Object.entries(v as AnyRecord)) {
            if (sub === undefined || sub === null) continue;
            on[impl] = this.where(this.api.node(impl), sub) ?? {};
          }
          out.$on = on;
          continue;
        }
      }
      const f = model.fields.find((x) => x.name === k);
      if (!f) throw badInput(`Unknown field "${model.name}.${k}" in where.`);
      this.usable(model, k, "filtered on");
      if (f.kind === "scalar") {
        out[k] = this.scalarFilter(f, v);
        continue;
      }
      if (v === null) {
        out[k] = null;
        continue;
      }
      const target = this.api.node(f.target);
      const rel: AnyRecord = {};
      for (const [op, sub] of Object.entries(v as AnyRecord)) {
        if (sub === undefined) continue;
        if (sub === null) {
          // `is: null` / `isNot: null` mean "no related node" / "one"; a null list filter is absent.
          if (!f.many) rel[op] = null;
          continue;
        }
        rel[op] = this.where(target, sub) ?? {};
      }
      out[k] = rel;
    }
    return out;
  }

  private scalarFilter(f: ResolvedScalarField, v: unknown): unknown {
    if ((f.type !== "Point" && f.type !== "CartesianPoint") || f.list || !isPlainObject(v))
      return v;
    const out: AnyRecord = {};
    for (const [op, x] of Object.entries(v)) {
      if (x === undefined) continue;
      if (op === "distance" && isPlainObject(x)) out[op] = { ...x, from: cleanPoint(x.from) };
      else if (op === "withinBBox" && isPlainObject(x)) {
        out[op] = { lowerLeft: cleanPoint(x.lowerLeft), upperRight: cleanPoint(x.upperRight) };
      } else out[op] = cleanPoint(x);
    }
    return out;
  }

  /** `<Model>WhereUnique`: key fields are bare values, the rest are filters. */
  whereUnique(model: ResolvedNodeModel, w: unknown): AnyRecord {
    if (!isPlainObject(w)) return {};
    const keys = new Set([
      ...model.uniqueFields,
      ...(model.compoundUniques ?? []).map((c) => c.key),
    ]);
    const key: AnyRecord = {};
    const rest: AnyRecord = {};
    for (const [k, v] of Object.entries(w)) {
      if (keys.has(k)) {
        if (v !== null && v !== undefined) {
          for (const f of model.compoundUniques?.find((c) => c.key === k)?.fields ?? [k]) {
            this.usable(model, f, "filtered on");
          }
          key[k] = v;
        }
      } else rest[k] = v;
    }
    return { ...(this.where(model, rest) ?? {}), ...key };
  }

  /** A GraphQL `orderBy` list as the client's: one key per element, `_typename` → `__typename`. */
  orderBy(model: ResolvedNodeModel, list: unknown): AnyRecord[] | undefined {
    if (list === undefined || list === null) return undefined;
    const items = Array.isArray(list) ? list : [list];
    const one = (item: unknown, where: string): [string, unknown] => {
      const entries = isPlainObject(item)
        ? Object.entries(item).filter(([, v]) => v !== undefined && v !== null)
        : [];
      if (entries.length !== 1) {
        throw badInput(
          `${where}: each element of orderBy takes exactly one key, got ${entries.length === 0 ? "none" : entries.map(([k]) => k).join(", ")}.`,
        );
      }
      return entries[0]!;
    };
    return items.map((item, i) => {
      const [k, v] = one(item, `orderBy[${i}]`);
      if (k === "_typename") return { __typename: v };
      const f = model.fields.find((x) => x.name === k);
      if (!f) throw badInput(`Unknown field "${model.name}.${k}" in orderBy.`);
      this.usable(model, k, "sorted on");
      if (f.kind === "scalar") {
        if ((f.type === "Point" || f.type === "CartesianPoint") && isPlainObject(v)) {
          return {
            [k]: {
              distanceFrom: cleanPoint(v.distanceFrom),
              ...(v.sort !== undefined && v.sort !== null ? { sort: v.sort } : {}),
            },
          };
        }
        return { [k]: v };
      }
      const target = this.api.node(f.target);
      if (f.many) {
        const spec = v as AnyRecord;
        const where = this.where(target, spec.where);
        return { [k]: { _count: spec._count, ...(where ? { where } : {}) } };
      }
      const [field, dir] = one(v, `orderBy[${i}].${k}`);
      this.usable(target, field, "sorted on");
      return { [k]: { [field]: dir } };
    });
  }
}
