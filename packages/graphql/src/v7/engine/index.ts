/**
 * `compat.v7` on the shared engine: v7 requests the engine can serve exactly like the compat
 * compiler are translated into ORM operations on an engine client (see `schema.ts`, `where.ts`,
 * `read.ts`); the others run on the compat compiler, which stays for the v7 features whose engine
 * pieces come later (aggregations, fulltext, `@cypher`, `@authorization`, subscriptions,
 * interfaces, unions) and for what the engine cannot express yet (edge filters and sorts, …).
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

/**
 * Internal option of `compat.v7.makeSchema` (keyed by this symbol, so it is no part of the public
 * options): `false` runs every request on the compat compiler; a {@link EngineProbe} is told how
 * each root field ran. Used by the compatibility suite's engine-off/on differential run.
 *
 * @internal
 */
export const ENGINE_OPTION: unique symbol = Symbol.for("cyphra.compat.v7.engine") as never;

/**
 * Told, for each generated root field the engine could serve, whether it ran on the engine
 * (`reason` undefined) or on the compat compiler (`reason`: why).
 *
 * @internal
 */
export type EngineProbe = {
  onRootField(field: string, reason: string | undefined): void;
};

/** The {@link ENGINE_OPTION} of the options: `false`, a probe, or `undefined`. */
export function engineOption(options: object): false | EngineProbe | undefined {
  const v = (options as Record<symbol, unknown>)[ENGINE_OPTION];
  if (v === false) return false;
  if (v && typeof v === "object" && typeof (v as EngineProbe).onRootField === "function") {
    return v as EngineProbe;
  }
  return undefined;
}

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
    private readonly probe?: EngineProbe,
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
    return this.plan(fieldNodes[0]?.name.value ?? "", ctx, () => {
      const t = new ReadTranslator(this.model, this.schema, info);
      return kind === "list"
        ? t.rootList(node, args, fieldNodes)
        : t.rootConnection(node, args, fieldNodes);
    });
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
    return this.plan(fieldNodes[0]?.name.value ?? "", ctx, () => {
      const t = new WriteTranslator(this.model, this.schema, info);
      return t[kind](node, args, fieldNodes);
    });
  }

  /** The plan `translate` builds, or `undefined` when it falls back (reported to the probe). */
  private plan<P>(field: string, ctx: unknown, translate: () => P): P | undefined {
    if (compilerOnlyContext(ctx)) {
      this.probe?.onRootField(field, "context.cypherParams");
      return undefined;
    }
    try {
      return translate();
    } catch (e) {
      if (e instanceof Fallback) {
        this.probe?.onRootField(field, e.message);
        return undefined;
      }
      throw e;
    }
  }

  /** Reports a root field that ran on the engine, or on the compiler for want of a client. */
  ran(field: string, onEngine: boolean): void {
    this.probe?.onRootField(field, onEngine ? undefined : "no engine client");
  }
}
