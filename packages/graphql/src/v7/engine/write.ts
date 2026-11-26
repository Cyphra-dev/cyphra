/**
 * Translates v7 root mutations into engine batch operations, when the engine writes exactly what
 * the compat compiler writes and the response can be shaped the same way:
 *
 * - `createMovies(input)` with attribute inputs only → `createMany` (`@id` values are random UUIDs,
 *   like v7's `randomUUID()`); `info.nodesCreated` is the number of inputs;
 * - `updateMovies(where, update)` with `set` operators only → `updateMany`; the `info` counters
 *   are all 0 (only properties change);
 * - `deleteMovies(where)` without nested `delete` → `deleteMany` (with the number of
 *   relationships the delete removed, for `relationshipsDeleted`).
 *
 * The response (`movies { … }`) is projected in the same statement, with the read translator.
 *
 * What stays on the compat compiler ({@link Fallback}): nested writes (`create`, `connect` — a v7
 * `CREATE`, the engine's is a `MERGE` —, `update`, `delete`, `disconnect`, `connectOrCreate`),
 * arithmetic and list operators (v7 fails on `null` operands and 32-bit overflow), deprecated
 * `field_SET` keys (v7 reports conflicting modifications), `@timestamp` fields (v7 writes the
 * database clock), `@limit` types (v7 limits the returned nodes), DateTime values, and every type
 * with rules.
 *
 * @packageDocumentation
 */

import type { FieldNode } from "graphql";
import { CyphraError } from "@cyphra/runtime";
import { collectFields, subSelections, type SelectionInfo } from "../cypher/select.js";
import type { Attribute, NodeType, V7Model } from "../model.js";
import { ReadTranslator, delegate } from "./read.js";
import type { EngineSchema } from "./schema.js";
import { Fallback, WhereTranslator, engineValue, isPlainObject, rootWhere } from "./where.js";

type AnyRecord = Record<string, unknown>;

/** A translated root mutation, run on the request's engine client. */
export type WritePlan = (client: object) => Promise<unknown>;

/** Key v7 adds to input types without fields. */
const EMPTY_INPUT = "_emptyInput";

const COUNTERS = ["nodesCreated", "nodesDeleted", "relationshipsCreated", "relationshipsDeleted"];

function asList(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * The database error behind an engine error: the engine maps uniqueness violations to its own
 * error class, the compat compiler reports Neo4j's.
 */
function databaseError(err: unknown): unknown {
  if (err instanceof CyphraError && err.cause !== undefined) return err.cause;
  return err;
}

/** A value to write to an attribute (`null` removes the property). */
function writeValue(attr: Attribute, value: unknown): unknown {
  if (value === null) {
    if (attr.type.list) throw new Fallback("null list");
    return null;
  }
  if (attr.type.list && !Array.isArray(value)) throw new Fallback("list value");
  return engineValue(attr, value);
}

/** Translates one root mutation; one per resolver call. */
export class WriteTranslator {
  private readonly where: WhereTranslator;
  private readonly read: ReadTranslator;

  constructor(
    model: V7Model,
    schema: EngineSchema,
    private readonly info: SelectionInfo,
  ) {
    this.where = new WhereTranslator(model, schema);
    this.read = new ReadTranslator(model, schema, info);
  }

  /** The type's checks shared by every write: in the engine, no rules, no `@limit`. */
  private writable(node: NodeType): void {
    this.where.engineNode(node);
    if (node.limit) throw new Fallback("@limit on the returned nodes");
  }

  /** The engine field of an attribute input, or {@link Fallback}. */
  private field(node: NodeType, attr: Attribute): string {
    const field = attr.cypher ? undefined : this.where.engineNode(node).fields.get(attr.name);
    if (!field) throw new Fallback(`write ${node.name}.${attr.name}`);
    // Two attributes stored in one property: the compiler writes them one after the other.
    if (node.attributes.some((a) => a !== attr && a.property === attr.property)) {
      throw new Fallback("shared property");
    }
    return field;
  }

  /**
   * The `{ info, <plural> }` response: the engine `select` of the returned nodes (merged over the
   * response keys selecting them, `undefined` when none does) and the shaper of the response.
   */
  private response(
    node: NodeType,
    fieldNodes: readonly FieldNode[],
  ): {
    select: AnyRecord | undefined;
    shape: (counts: Record<string, number>, rows: readonly AnyRecord[]) => AnyRecord;
  } {
    const shapers: [
      string,
      (counts: Record<string, number>, rows: readonly AnyRecord[]) => unknown,
    ][] = [];
    let select: AnyRecord | undefined;
    for (const [key, nodes] of collectFields(this.info, subSelections(fieldNodes))) {
      const name = nodes[0]!.name.value;
      if (name === "info") {
        const fields = [...collectFields(this.info, subSelections(nodes))]
          .map(([k, n]) => [k, n[0]!.name.value] as const)
          .filter(([, f]) => COUNTERS.includes(f));
        shapers.push([
          key,
          (counts) => Object.fromEntries(fields.map(([k, f]) => [k, counts[f] ?? 0])),
        ]);
      } else if (name === node.plural) {
        const p = this.read.node(node, nodes);
        select = { ...select, ...p.select };
        shapers.push([key, (_counts, rows) => rows.map(p.shape)]);
      }
    }
    return {
      select,
      shape: (counts, rows) => Object.fromEntries(shapers.map(([k, s]) => [k, s(counts, rows)])),
    };
  }

  /** `createMovies(input: [...])`. */
  create(node: NodeType, args: AnyRecord, fieldNodes: readonly FieldNode[]): WritePlan {
    this.writable(node);
    if (node.attributes.some((a) => a.timestamp?.length)) throw new Fallback("@timestamp");
    const ids = node.attributes.filter((a) => a.id && !a.cypher);
    const rows = asList(args.input).map((input) => {
      if (!isPlainObject(input)) throw new Fallback("create input");
      const row: AnyRecord = {};
      for (const [key, value] of Object.entries(input)) {
        if (value === undefined || key === EMPTY_INPUT) continue;
        const attr = node.attributes.find((a) => a.name === key);
        if (!attr || attr.id) throw new Fallback(`create input ${key}`);
        row[this.field(node, attr)] = writeValue(attr, value);
      }
      return row;
    });
    const idFields = ids.map((a) => this.field(node, a));
    const { select, shape } = this.response(node, fieldNodes);
    return async (client) => {
      // v7 generates `@id` values in the statement (`randomUUID()`): same kind of value.
      const data = rows.map((row) => {
        const out = { ...row };
        for (const f of idFields) out[f] = globalThis.crypto.randomUUID();
        return out;
      });
      try {
        const res = (await delegate(client, node.name).createMany!({
          data,
          ...(select ? { select } : {}),
        })) as { count: number; nodes?: AnyRecord[] };
        return shape({ nodesCreated: data.length }, res.nodes ?? []);
      } catch (e) {
        throw databaseError(e);
      }
    };
  }

  /** `updateMovies(where, update)` with `set` operators only. */
  update(node: NodeType, args: AnyRecord, fieldNodes: readonly FieldNode[]): WritePlan {
    this.writable(node);
    if (node.attributes.some((a) => a.timestamp?.includes("UPDATE") && !a.cypher)) {
      throw new Fallback("@timestamp");
    }
    for (const key of ["connect", "disconnect", "create", "delete", "connectOrCreate"]) {
      if (args[key] !== undefined && args[key] !== null) throw new Fallback(`update ${key}`);
    }
    const data: AnyRecord = {};
    if (isPlainObject(args.update)) {
      for (const [key, value] of Object.entries(args.update)) {
        if (value === undefined || key === EMPTY_INPUT) continue;
        const attr = node.attributes.find((a) => a.name === key);
        if (!attr) throw new Fallback(`update input ${key}`);
        // Not an object: the compiler writes nothing for it.
        if (!isPlainObject(value)) continue;
        const ops = Object.entries(value).filter(([, v]) => v !== undefined);
        if (ops.length === 0) continue;
        if (ops.length > 1 || ops[0]![0] !== "set") throw new Fallback(`update operator`);
        data[this.field(node, attr)] = writeValue(attr, ops[0]![1]);
      }
    } else if (args.update !== undefined && args.update !== null) {
      throw new Fallback("update input");
    }
    const where = rootWhere(this.where.node(node, args.where));
    const { select, shape } = this.response(node, fieldNodes);
    const updateArgs: AnyRecord = {
      ...(where !== undefined ? { where } : {}),
      data,
      ...(select ? { select } : {}),
    };
    return async (client) => {
      try {
        const res = (await delegate(client, node.name).updateMany!(updateArgs)) as {
          count: number;
          nodes?: AnyRecord[];
        };
        return shape({}, res.nodes ?? []);
      } catch (e) {
        throw databaseError(e);
      }
    };
  }

  /** `deleteMovies(where)` without nested `delete`. */
  delete(node: NodeType, args: AnyRecord, fieldNodes: readonly FieldNode[]): WritePlan {
    this.where.engineNode(node);
    if (isPlainObject(args.delete)) {
      if (Object.values(args.delete).some((v) => v !== undefined))
        throw new Fallback("nested delete");
    } else if (args.delete !== undefined && args.delete !== null) {
      throw new Fallback("delete input");
    }
    const where = rootWhere(this.where.node(node, args.where));
    const fields = [...collectFields(this.info, subSelections(fieldNodes))]
      .map(([k, n]) => [k, n[0]!.name.value] as const)
      .filter(([, f]) => COUNTERS.includes(f));
    const relationships = fields.some(([, f]) => f === "relationshipsDeleted");
    const deleteArgs: AnyRecord = {
      ...(where !== undefined ? { where } : {}),
      ...(relationships ? { $relationships: true } : {}),
    };
    return async (client) => {
      try {
        const res = (await delegate(client, node.name).deleteMany!(deleteArgs)) as {
          count: number;
          relationships?: number;
        };
        const counts: Record<string, number> = {
          nodesDeleted: res.count,
          relationshipsDeleted: res.relationships ?? 0,
        };
        return Object.fromEntries(fields.map(([k, f]) => [k, counts[f] ?? 0]));
      } catch (e) {
        throw databaseError(e);
      }
    };
  }
}
