/**
 * `compat.v7` on the shared engine: v7 requests the engine can serve exactly like the compat
 * compiler are translated into ORM operations on an engine client (see `schema.ts`, `where.ts`,
 * `read.ts`, `write.ts`, `cypher.ts`, with the request's `@authorization` rules from `rules.ts`);
 * the others run on the compat compiler, which stays for what only v7 does (interfaces and unions,
 * nested writes, arithmetic operators, custom-resolver fields, `context.cypherParams`, validations
 * that depend on the node), and for a few cases the engine does not evaluate like v7 yet (READ
 * validations that fail for the request, a READ filter on the nodes an update returns, to-one
 * connection filters in rules, `@cypher` statements a mutation's response cannot project).
 *
 * @packageDocumentation
 */

import type { FieldNode } from "graphql";
import type { AuthContext } from "../auth/context.js";
import type { ExecutorOptions } from "../execute.js";
import type { SelectionInfo } from "../cypher/select.js";
import type { CypherRootField, FulltextIndex, NodeType, V7Model } from "../model.js";
import { EngineClients } from "./client.js";
import { statementVariables } from "./cypher.js";
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
    this.clients = new EngineClients(this.schema.schema, opts, statementVariables(model));
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
    auth: AuthContext,
  ): ReadPlan | undefined {
    return this.plan(fieldNodes[0]?.name.value ?? "", ctx, () => {
      const t = new ReadTranslator(this.model, this.schema, info, auth);
      const plan =
        kind === "list"
          ? t.rootList(node, args, fieldNodes)
          : t.rootConnection(node, args, fieldNodes);
      // `@authentication` fails like the compiler, which checks it while compiling.
      t.authenticated();
      return plan;
    });
  }

  /** The plan of a `@fulltext` query, or `undefined` when the compat compiler must run it. */
  fulltext(
    node: NodeType,
    index: FulltextIndex,
    args: AnyRecord,
    info: SelectionInfo,
    fieldNodes: readonly FieldNode[],
    ctx: unknown,
    auth: AuthContext,
  ): ReadPlan | undefined {
    return this.plan(fieldNodes[0]?.name.value ?? "", ctx, () => {
      const t = new ReadTranslator(this.model, this.schema, info, auth);
      const plan = t.rootFulltext(node, index, args, fieldNodes);
      t.authenticated();
      return plan;
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
    auth: AuthContext,
  ): WritePlan | undefined {
    return this.plan(fieldNodes[0]?.name.value ?? "", ctx, () => {
      const t = new WriteTranslator(this.model, this.schema, info, auth);
      const plan = t[kind](node, args, fieldNodes);
      t.authenticated();
      return plan;
    });
  }

  /**
   * The plan of a `Query` / `Mutation` `@cypher` field, or `undefined` when the compat compiler
   * must run it.
   */
  cypher(
    type: "Query" | "Mutation",
    field: CypherRootField,
    args: AnyRecord,
    info: SelectionInfo,
    fieldNodes: readonly FieldNode[],
    ctx: unknown,
    auth: AuthContext,
  ): ReadPlan | undefined {
    return this.plan(fieldNodes[0]?.name.value ?? "", ctx, () => {
      const t = new ReadTranslator(this.model, this.schema, info, auth);
      const plan = t.rootCypher(field, args, fieldNodes, type === "Mutation");
      t.authenticated();
      return plan;
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
      // The engine's answer: the error the compiler would raise (`@authentication`).
      this.probe?.onRootField(field, undefined);
      throw e;
    }
  }

  /** Reports a root field that ran on the engine, or on the compiler for want of a client. */
  ran(field: string, onEngine: boolean): void {
    this.probe?.onRootField(field, onEngine ? undefined : "no engine client");
  }
}
