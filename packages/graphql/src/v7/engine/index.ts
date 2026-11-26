/**
 * `compat.v7` on the shared engine: v7 requests the engine can serve exactly like the compat
 * compiler are translated into ORM operations on an engine client (see `schema.ts`, `where.ts`,
 * `read.ts`); the others run on the compat compiler, which stays for the v7 features whose engine
 * pieces come later (aggregations, fulltext, `@cypher`, `@authorization`, subscriptions,
 * interfaces, unions) and for what the engine cannot express yet (edge filters and sorts,
 * `single`, …).
 *
 * @packageDocumentation
 */

import type { FieldNode } from "graphql";
import type { ExecutorOptions } from "../execute.js";
import type { SelectionInfo } from "../cypher/select.js";
import type { NodeType, V7Model } from "../model.js";
import { EngineClients } from "./client.js";
import { ReadTranslator, type ReadPlan } from "./read.js";
import { WriteTranslator, type WritePlan } from "./write.js";
import { engineSchema, type EngineSchema } from "./schema.js";
import { Fallback } from "./where.js";

export type { ReadPlan } from "./read.js";
export type { WritePlan } from "./write.js";

type AnyRecord = Record<string, unknown>;

/** Whether the request's context sets something only the compat compiler handles. */
function compilerOnlyContext(ctx: unknown): boolean {
  if (!ctx || typeof ctx !== "object") return false;
  // `cypherParams` are parameters of every statement the compiler builds (and clash-checked).
  const params = (ctx as AnyRecord).cypherParams;
  return params !== undefined && params !== null;
}

/** The engine side of one `compat.v7` schema. */
export class V7Engine {
  readonly schema: EngineSchema;
  readonly clients: EngineClients;

  constructor(
    private readonly model: V7Model,
    opts: ExecutorOptions,
  ) {
    this.schema = engineSchema(model);
    this.clients = new EngineClients(this.schema.schema, opts);
  }

  /**
   * The plan of a root list (`movies`) or connection (`moviesConnection`) query, or `undefined`
   * when the compat compiler must run it.
   */
  read(
    kind: "list" | "connection",
    node: NodeType,
    args: AnyRecord,
    info: SelectionInfo,
    fieldNodes: readonly FieldNode[],
    ctx: unknown,
  ): ReadPlan | undefined {
    if (compilerOnlyContext(ctx)) return undefined;
    try {
      const t = new ReadTranslator(this.model, this.schema, info);
      return kind === "list"
        ? t.rootList(node, args, fieldNodes)
        : t.rootConnection(node, args, fieldNodes);
    } catch (e) {
      if (e instanceof Fallback) return undefined;
      throw e;
    }
  }

  /**
   * The plan of a root `create` / `update` / `delete` mutation, or `undefined` when the compat
   * compiler must run it.
   */
  write(
    kind: "create" | "update" | "delete",
    node: NodeType,
    args: AnyRecord,
    info: SelectionInfo,
    fieldNodes: readonly FieldNode[],
    ctx: unknown,
  ): WritePlan | undefined {
    if (compilerOnlyContext(ctx)) return undefined;
    try {
      const t = new WriteTranslator(this.model, this.schema, info);
      return t[kind](node, args, fieldNodes);
    } catch (e) {
      if (e instanceof Fallback) return undefined;
      throw e;
    }
  }
}
