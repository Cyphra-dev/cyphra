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
 * The response (`movies { … }`) is projected in the same statement, with the read translator, and
 * limited by the type's `@limit` like v7. `@timestamp` fields get the database clock (`$now`:
 * `datetime()` / `date()` in the statement), `@authentication` is checked like the compiler.
 *
 * What stays on the compat compiler ({@link Fallback}): nested writes (`create`, `connect` — a v7
 * `CREATE`, the engine's is a `MERGE` —, `update`, `delete`, `disconnect`, `connectOrCreate`),
 * arithmetic and list operators (v7 fails on `null` operands and 32-bit overflow), deprecated
 * `field_SET` keys (v7 reports conflicting modifications), DateTime values, and `@authorization` rules the engine cannot apply like the compiler: a
 * `validate` rule that may fail, a READ filter on the nodes an update returns that depends on the
 * node.
 *
 * `@authorization` `filter` rules of UPDATE / DELETE are ANDed into the `where` of the nodes
 * written, like the compiler; nested selections of the response get their READ rules.
 *
 * @packageDocumentation
 */

import type { FieldNode } from "graphql";
import { CyphraError } from "@cyphra/runtime";
import { forbidden, type AuthContext } from "../auth/context.js";
import { collectFields, pageLimit, subSelections, type SelectionInfo } from "../cypher/select.js";
import type { Attribute, NodeType, V7Model } from "../model.js";
import { ReadTranslator, delegate } from "./read.js";
import type { EngineAuthRules } from "./rules.js";
import type { EngineSchema } from "./schema.js";
import {
  Fallback,
  TRUE,
  WhereTranslator,
  allOf,
  engineValue,
  isPlainObject,
  rootWhere,
} from "./where.js";

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

/**
 * Runs a root write. When its `validate` rules fail for the request (`holds` false), every node it
 * writes breaks them: like the compiler's statement, it runs in a transaction that fails with
 * `Forbidden` (rolled back) once it wrote a node; a write that matched nothing returns normally.
 */
async function checked<R extends { count: number }>(
  client: object,
  holds: boolean,
  run: (db: object) => Promise<R>,
): Promise<R> {
  if (holds) return run(client);
  const transaction = (client as { $transaction?: (fn: (tx: object) => Promise<R>) => Promise<R> })
    .$transaction;
  if (typeof transaction !== "function") {
    throw new Error("Internal error: the engine client has no $transaction.");
  }
  const denied = Symbol("forbidden");
  try {
    return await transaction.call(client, async (tx) => {
      const r = await run(tx);
      if (r.count > 0) throw denied;
      return r;
    });
  } catch (e) {
    if (e === denied) throw forbidden();
    throw e;
  }
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
  private readonly rules: EngineAuthRules;

  constructor(
    model: V7Model,
    schema: EngineSchema,
    private readonly info: SelectionInfo,
    auth: AuthContext,
  ) {
    this.where = new WhereTranslator(model, schema, false, auth.jwt ?? {});
    this.read = new ReadTranslator(model, schema, info, auth);
    this.rules = this.read.rules;
  }

  /** The attributes an input writes (the compiler's `writtenAttributes`: every defined key). */
  private written(node: NodeType, input: unknown): Attribute[] {
    if (!isPlainObject(input)) return [];
    const out = new Set<Attribute>();
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const attr = node.attributes.find((a) => a.name === key);
      // Deprecated `title_SET` keys stay on the compiler (see `update`).
      if (attr) out.add(attr);
    }
    return [...out];
  }

  /** The type's checks shared by every write: in the engine. */
  private writable(node: NodeType): void {
    this.where.engineNode(node);
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
    /** Apply the READ rules to the returned nodes (update; v7 does not for create). */
    readRules: boolean,
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
        if (readRules) {
          // The returned nodes are filtered in the compiler's statement, not in the engine's.
          const filter = this.rules.read(node, this.read.selectedAttributes(node, nodes));
          if (filter !== undefined && filter !== TRUE) {
            throw new Fallback("READ filter on the returned nodes");
          }
        }
        const p = this.read.node(node, nodes);
        select = { ...select, ...p.select };
        // v7 applies `@limit(default ?? max)` to the returned nodes as well (in their order).
        const limit = pageLimit(node, undefined);
        shapers.push([
          key,
          (_counts, rows) =>
            (typeof limit === "number" ? rows.slice(0, Math.max(0, limit)) : rows).map(p.shape),
        ]);
      }
    }
    return {
      select,
      shape: (counts, rows) => Object.fromEntries(shapers.map(([k, s]) => [k, s(counts, rows)])),
    };
  }

  /**
   * The `$now` of the `@timestamp` fields `operation` sets (v7: `datetime()` / `date()` of the
   * database, in the statement), `undefined` without any.
   */
  private timestamps(node: NodeType, operation: "CREATE" | "UPDATE"): AnyRecord | undefined {
    const attrs = node.attributes.filter(
      // The compiler's `onCreateGenerated` / `onUpdateGenerated` (an `@id` gets a UUID instead).
      (a) => !a.cypher && !a.id && a.timestamp?.includes(operation),
    );
    if (attrs.length === 0) return undefined;
    const now: AnyRecord = {};
    for (const a of attrs) {
      if ((a.type.name !== "DateTime" && a.type.name !== "Date") || a.type.list) {
        throw new Fallback(`@timestamp on ${a.type.name}`);
      }
      now[this.field(node, a)] = true;
    }
    return now;
  }

  /** Throws the first `@authentication` failure of the translated request, if any. */
  authenticated(): void {
    this.read.authenticated();
  }

  /** `createMovies(input: [...])`. */
  create(node: NodeType, args: AnyRecord, fieldNodes: readonly FieldNode[]): WritePlan {
    this.writable(node);
    const now = this.timestamps(node, "CREATE");
    const ids = node.attributes.filter((a) => a.id && !a.cypher);
    this.read.authenticate(node, "CREATE");
    let holds = true;
    const rows = asList(args.input).map((input) => {
      if (!isPlainObject(input)) throw new Fallback("create input");
      const written = this.written(node, input);
      this.read.authenticate(
        node,
        "CREATE",
        written.map((a) => a.name),
      );
      // CREATE validations are AFTER rules (v7), checked on every created node.
      if (!this.rules.holds(node, "CREATE", "AFTER", written)) holds = false;
      const row: AnyRecord = {};
      for (const [key, value] of Object.entries(input)) {
        if (value === undefined || key === EMPTY_INPUT) continue;
        const attr = node.attributes.find((a) => a.name === key);
        if (!attr || attr.id || attr.timestamp?.includes("CREATE")) {
          throw new Fallback(`create input ${key}`);
        }
        row[this.field(node, attr)] = writeValue(attr, value);
      }
      return row;
    });
    const idFields = ids.map((a) => this.field(node, a));
    const { select, shape } = this.response(node, fieldNodes, false);
    return async (client) => {
      // v7 generates `@id` values in the statement (`randomUUID()`): same kind of value.
      const data = rows.map((row) => {
        const out = { ...row };
        for (const f of idFields) out[f] = globalThis.crypto.randomUUID();
        return out;
      });
      try {
        const res = await checked(client, holds, async (db) => {
          const r = (await delegate(db, node.name).createMany!({
            data,
            ...(now ? { $now: now } : {}),
            ...(select ? { select } : {}),
          })) as { count: number; nodes?: AnyRecord[] };
          return { ...r, count: data.length };
        });
        return shape({ nodesCreated: data.length }, res.nodes ?? []);
      } catch (e) {
        throw databaseError(e);
      }
    };
  }

  /** `updateMovies(where, update)` with `set` operators only. */
  update(node: NodeType, args: AnyRecord, fieldNodes: readonly FieldNode[]): WritePlan {
    this.writable(node);
    // v7 refreshes UPDATE timestamps even without an `update` argument.
    const now = this.timestamps(node, "UPDATE");
    this.read.authenticate(
      node,
      "UPDATE",
      this.written(node, args.update).map((a) => a.name),
    );
    for (const key of ["connect", "disconnect", "create", "delete", "connectOrCreate"]) {
      if (args[key] !== undefined && args[key] !== null) throw new Fallback(`update ${key}`);
    }
    const data: AnyRecord = {};
    if (isPlainObject(args.update)) {
      for (const [key, value] of Object.entries(args.update)) {
        if (value === undefined || key === EMPTY_INPUT) continue;
        const attr = node.attributes.find((a) => a.name === key);
        if (!attr || (attr.timestamp?.includes("UPDATE") && !attr.id)) {
          throw new Fallback(`update input ${key}`);
        }
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
    // v7 applies the type's UPDATE rules to a top-level update only when attributes are written.
    const written = this.written(node, args.update);
    const typeRules = written.length > 0;
    const holds = (["BEFORE", "AFTER"] as const)
      .map((when) => this.rules.holds(node, "UPDATE", when, written, typeRules))
      .every(Boolean);
    const where = rootWhere(
      allOf([
        this.where.node(node, args.where),
        typeRules ? this.rules.filter(node, "UPDATE") : undefined,
      ]),
    );
    // When the validations fail, the response is either Forbidden or empty: its READ filter does
    // not matter.
    const { select, shape } = this.response(node, fieldNodes, holds);
    const updateArgs: AnyRecord = {
      ...(where !== undefined ? { where } : {}),
      data,
      ...(now ? { $now: now } : {}),
      ...(select ? { select } : {}),
    };
    return async (client) => {
      try {
        const res = await checked(
          client,
          holds,
          async (db) =>
            (await delegate(db, node.name).updateMany!(updateArgs)) as {
              count: number;
              nodes?: AnyRecord[];
            },
        );
        return shape({}, res.nodes ?? []);
      } catch (e) {
        throw databaseError(e);
      }
    };
  }

  /** `deleteMovies(where)` without nested `delete`. */
  delete(node: NodeType, args: AnyRecord, fieldNodes: readonly FieldNode[]): WritePlan {
    this.where.engineNode(node);
    this.read.authenticate(node, "DELETE");
    if (isPlainObject(args.delete)) {
      if (Object.values(args.delete).some((v) => v !== undefined))
        throw new Fallback("nested delete");
    } else if (args.delete !== undefined && args.delete !== null) {
      throw new Fallback("delete input");
    }
    const holds = this.rules.holds(node, "DELETE", "BEFORE");
    const where = rootWhere(
      allOf([this.where.node(node, args.where), this.rules.filter(node, "DELETE")]),
    );
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
        const res = await checked(
          client,
          holds,
          async (db) =>
            (await delegate(db, node.name).deleteMany!(deleteArgs)) as {
              count: number;
              relationships?: number;
            },
        );
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
