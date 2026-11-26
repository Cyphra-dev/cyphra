/**
 * Write arguments of the native API: GraphQL `data` / `create` / `update` inputs as the client's
 * (`_ops` merged into the fields, `_edge` → `$edge`, `_labels` → `$labels`, unique keys of
 * `connect` / `disconnect` / `set` / `delete`, nested `update` / `upsert` / `connectOrCreate`).
 * Validation issue paths are mapped back to GraphQL argument paths by `graphQLPath` (`errors.ts`).
 *
 * @packageDocumentation
 */

import type { ResolvedNodeModel, ResolvedRelationField, ResolvedScalarField } from "@cyphra/schema";
import type { ApiModel } from "./api.js";
import { badInput } from "./errors.js";
import { cleanPoint, type Translator } from "./translate.js";

type AnyRecord = Record<string, unknown>;

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isPoint = (f: ResolvedScalarField) =>
  !f.list && (f.type === "Point" || f.type === "CartesianPoint");

/** A scalar value as the client takes it (points without their absent axes). */
function scalarValue(f: ResolvedScalarField, v: unknown): unknown {
  return isPoint(f) && v !== null ? cleanPoint(v) : v;
}

/**
 * Merge `_ops` (`{ views: { increment: 1 } }`) into `out` (the fields given as values), as the
 * client's `{ views: { increment: 1 } }`. A field given both ways is a `BAD_USER_INPUT`.
 */
function mergeOps(owner: string, out: AnyRecord, ops: unknown, at: string): void {
  if (!isPlainObject(ops)) return;
  for (const [k, v] of Object.entries(ops)) {
    if (v === undefined || v === null) continue;
    if (out[k] !== undefined) {
      throw badInput(`${at}: ${owner}.${k} is given a value and an _ops update; use one of them.`, {
        field: k,
      });
    }
    const steps = Object.fromEntries(
      Object.entries(v as AnyRecord).filter(([, x]) => x !== undefined && x !== null),
    );
    if (Object.keys(steps).length > 0) out[k] = steps;
  }
}

/** Translates the write arguments of one root field (one per resolver call). */
export class WriteArgs {
  constructor(
    private readonly api: ApiModel,
    private readonly t: Translator,
  ) {}

  /** `<Model>CreateInput` (or `<Model>CreateManyInput`) as the client's create `data`. */
  create(model: ResolvedNodeModel, data: unknown, at = "data"): AnyRecord {
    return this.node(model, data, "create", at);
  }

  /** `<Model>UpdateInput` (or `<Model>UpdateManyInput`) as the client's update `data`. */
  update(model: ResolvedNodeModel, data: unknown, at = "data"): AnyRecord {
    return this.node(model, data, "update", at);
  }

  private node(
    model: ResolvedNodeModel,
    data: unknown,
    mode: "create" | "update",
    at: string,
  ): AnyRecord {
    if (!isPlainObject(data)) return {};
    const out: AnyRecord = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined || k === "_ops" || k === "_edge") continue;
      if (k === "_labels") {
        if (v !== null) out.$labels = v;
        continue;
      }
      const f = model.fields.find((x) => x.name === k);
      if (!f) throw badInput(`${at}: unknown field "${model.name}.${k}".`);
      if (f.kind === "scalar") {
        if (v === null && mode === "update" && !f.optional && !f.list) {
          throw badInput(`${at}.${k}: ${model.name}.${k} is required and cannot be null.`, {
            field: k,
          });
        }
        out[k] = scalarValue(f, v);
        continue;
      }
      if (v === null) continue;
      out[k] = this.relation(f, v, `${at}.${k}`);
    }
    if (mode === "update") mergeOps(model.name, out, data._ops, `${at}._ops`);
    return out;
  }

  /** `_edge` (with its `_ops`) as the client's `$edge`. */
  private edge(rel: ResolvedRelationField, v: unknown, at: string): AnyRecord | undefined {
    if (!isPlainObject(v)) return undefined;
    const model = rel.edge ? this.api.edges.get(rel.edge) : undefined;
    const out: AnyRecord = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined || k === "_ops") continue;
      const p = model?.properties.find((y) => y.name === k);
      out[k] = p ? scalarValue(p, x) : x;
    }
    mergeOps(model?.name ?? "edge", out, v._ops, `${at}._ops`);
    return out;
  }

  private withEdge(rel: ResolvedRelationField, item: AnyRecord, base: AnyRecord, at: string) {
    const $edge = this.edge(rel, item._edge, `${at}._edge`);
    return $edge ? { ...base, $edge } : base;
  }

  /** The member named by a union item (`{ Post: { … } }`): its model and value. */
  private member(item: AnyRecord, at: string): [ResolvedNodeModel, unknown] | undefined {
    const entries = Object.entries(item).filter(
      ([k, v]) => k !== "_edge" && v !== undefined && v !== null,
    );
    if (entries.length !== 1) {
      throw badInput(
        `${at}: name exactly one member, got ${entries.length === 0 ? "none" : entries.map(([k]) => k).join(", ")}.`,
      );
    }
    const [name, value] = entries[0]!;
    return [this.api.node(name), value];
  }

  /** One nested create item. */
  private createItem(rel: ResolvedRelationField, item: unknown, at: string): AnyRecord {
    const target = this.api.node(rel.target);
    if (!isPlainObject(item)) return {};
    if (target.union) {
      const [m, data] = this.member(item, at)!;
      return this.withEdge(rel, item, { [m.name]: this.create(m, data, `${at}.${m.name}`) }, at);
    }
    const { _edge: _ignored, ...data } = item;
    return this.withEdge(rel, item, this.create(target, data, at), at);
  }

  /** One related node by unique key (connect / set / disconnect item), `$edge` when given. */
  private uniqueItem(rel: ResolvedRelationField, item: unknown, at: string): AnyRecord {
    const target = this.api.node(rel.target);
    if (!isPlainObject(item)) return {};
    if (target.union) {
      const [m, key] = this.member(item, at)!;
      return this.withEdge(rel, item, { [m.name]: this.t.whereUnique(m, key) }, at);
    }
    const { _edge: _ignored, ...key } = item;
    return this.withEdge(rel, item, this.t.whereUnique(target, key), at);
  }

  /** One nested update: `{ where, data }` on a to-many relation, the data on a to-one. */
  private updateItem(rel: ResolvedRelationField, item: unknown, at: string): AnyRecord {
    const target = this.api.node(rel.target);
    if (!isPlainObject(item)) return {};
    if (!rel.many) return this.update(target, item, at);
    return {
      where: this.t.whereUnique(target, item.where),
      data: this.update(target, item.data, `${at}.data`),
    };
  }

  /**
   * One nested `upsert` (`{ where?, create, update }`) or `connectOrCreate` (`{ where, create }`)
   * item. The `_edge` of its `create` becomes the item's `$edge`, as the client takes it.
   */
  private upsertItem(
    rel: ResolvedRelationField,
    item: unknown,
    at: string,
    upsert: boolean,
  ): AnyRecord {
    const target = this.api.node(rel.target);
    if (!isPlainObject(item)) return {};
    const { $edge, ...create } = this.createItem(rel, item.create, `${at}.create`);
    const out: AnyRecord = { create };
    if (item.where !== undefined && item.where !== null) {
      out.where = this.t.whereUnique(target, item.where);
    }
    if (upsert) out.update = this.update(target, item.update, `${at}.update`);
    if ($edge !== undefined) out.$edge = $edge;
    return out;
  }

  /** The relation writes of a relation (`create`, `connect`, `update`, …) as the client's. */
  private relation(rel: ResolvedRelationField, spec: unknown, at: string): AnyRecord {
    if (!isPlainObject(spec)) return {};
    const out: AnyRecord = {};
    const each = (v: unknown, fn: (item: unknown, at: string) => AnyRecord, op: string) =>
      Array.isArray(v) ? v.map((x, i) => fn(x, `${at}.${op}[${i}]`)) : fn(v, `${at}.${op}`);
    for (const [op, v] of Object.entries(spec)) {
      if (v === undefined || v === null) continue;
      switch (op) {
        case "create":
          out.create = each(v, (x, a) => this.createItem(rel, x, a), op);
          break;
        case "connect":
        case "set":
          out[op] = each(v, (x, a) => this.uniqueItem(rel, x, a), op);
          break;
        case "disconnect":
          out.disconnect =
            typeof v === "boolean" ? v : each(v, (x, a) => this.uniqueItem(rel, x, a), op);
          break;
        case "delete":
          out.delete =
            typeof v === "boolean" ? v : each(v, (x, a) => this.uniqueItem(rel, x, a), op);
          break;
        case "update":
          out.update = each(v, (x, a) => this.updateItem(rel, x, a), op);
          break;
        case "upsert":
          out.upsert = each(v, (x, a) => this.upsertItem(rel, x, a, true), op);
          break;
        case "connectOrCreate":
          out.connectOrCreate = each(v, (x, a) => this.upsertItem(rel, x, a, false), op);
          break;
        default:
          throw badInput(`${at}: unknown relation operation "${op}".`);
      }
    }
    return out;
  }
}
