/**
 * Auth of the native API, per request: `authenticated`, the rules of `defineGraphQL` evaluated
 * against the request's context into engine rules (`withEngineRules`, compiled into every
 * statement), and the context-only field rules the translator enforces (a denied field is `null`
 * with a `FORBIDDEN` error, and cannot be filtered or sorted on).
 *
 * @packageDocumentation
 */

import { GraphQLError } from "graphql";
import type { EngineRules, ModelRules, RuleValue } from "@cyphra/runtime";
import type { ResolvedNodeModel, SchemaModel } from "@cyphra/schema";
import type { ApiModel } from "./api.js";
import { isWrite, NativeSchemaError, type ConfiguredRules, type RootOperation } from "./config.js";

type AnyRecord = Record<string, unknown>;
type AnyFn = (args: never) => unknown;

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

const RELATION_FILTERS = ["some", "none", "every", "is", "isNot"];

/**
 * Check a `where` a rule returned against the schema (field and relation names, `AND` / `OR` /
 * `NOT`, `$on`), the part TypeScript cannot check for rules built dynamically or written in
 * JavaScript. Returns the first problem, or `undefined`.
 */
export function whereProblem(
  schema: SchemaModel,
  model: ResolvedNodeModel,
  where: unknown,
  at: string,
): string | undefined {
  if (!isPlainObject(where)) return `${at} must be a where object, true or false.`;
  const node = (name: string) => schema.nodes.find((n) => n.name === name);
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (k === "AND" || k === "OR" || k === "NOT") {
      for (const [i, w] of (Array.isArray(v) ? v : [v]).entries()) {
        const p = whereProblem(schema, model, w, `${at}.${k}${Array.isArray(v) ? `[${i}]` : ""}`);
        if (p) return p;
      }
      continue;
    }
    if (k === "__typename" || k === "$labels") continue;
    if (k === "_count") {
      if (!isPlainObject(v)) return `${at}._count must be an object of to-many relations.`;
      for (const [rel, filter] of Object.entries(v)) {
        const f = model.fields.find((x) => x.name === rel);
        if (f?.kind !== "relation" || !f.many) {
          return `${at}._count: "${rel}" is not a to-many relation of ${model.name}.`;
        }
        if (isPlainObject(filter) && filter.where !== undefined) {
          const p = whereProblem(
            schema,
            node(f.target)!,
            filter.where,
            `${at}._count.${rel}.where`,
          );
          if (p) return p;
        }
      }
      continue;
    }
    if (k === "$on") {
      if (!isPlainObject(v)) return `${at}.$on must be an object.`;
      for (const [impl, w] of Object.entries(v)) {
        const m = node(impl);
        if (!m) return `${at}.$on: unknown model "${impl}".`;
        const p = whereProblem(schema, m, w ?? {}, `${at}.$on.${impl}`);
        if (p) return p;
      }
      continue;
    }
    const f = model.fields.find((x) => x.name === k);
    if (!f) {
      return `${at}: unknown field "${model.name}.${k}" (fields: ${model.fields.map((x) => x.name).join(", ") || "none"}).`;
    }
    if (f.kind === "scalar" || v === null) continue;
    if (!isPlainObject(v))
      return `${at}.${k}: a relation filter takes { some, none, every, is, isNot }.`;
    const target = node(f.target)!;
    for (const [op, w] of Object.entries(v)) {
      if (w === undefined || w === null) continue;
      if (!RELATION_FILTERS.includes(op)) {
        return `${at}.${k}: unknown relation filter "${op}" (use ${RELATION_FILTERS.join(", ")}).`;
      }
      const p = whereProblem(schema, target, w, `${at}.${k}.${op}`);
      if (p) return p;
    }
  }
  return undefined;
}

/** Every where-returning rule of the config, with the model its `where` is on and its path. */
function* whereRules(
  api: ApiModel,
): Generator<{ fn: AnyFn; model: ResolvedNodeModel; at: string }> {
  for (const [name, rules] of api.config.rules) {
    const node = api.node(name);
    const at = `config.models.${name}.rules`;
    for (const k of ["read", "update", "delete"] as const) {
      if (rules[k]) yield { fn: rules[k], model: node, at: `${at}.${k}` };
    }
    for (const k of ["create", "update"] as const) {
      const fn = rules.after?.[k];
      if (fn) yield { fn, model: node, at: `${at}.after.${k}` };
    }
    for (const k of ["connect", "disconnect"] as const) {
      for (const [rel, fn] of Object.entries(rules[k] ?? {})) {
        if (!fn) continue;
        const f = node.fields.find((x) => x.name === rel)!;
        if (f.kind !== "relation") continue;
        yield { fn, model: api.node(f.target), at: `${at}.${k}.${rel}` };
      }
    }
  }
  for (const [key, rule] of api.config.fieldRules) {
    if (rule.kind !== "where") continue;
    const [model, field] = key.split(".") as [string, string];
    yield {
      fn: rule.fn,
      model: api.node(model),
      at: `config.models.${model}.fields.${field}.read.where`,
    };
  }
}

/**
 * The startup check of the rules: each where-returning rule is called with an empty context
 * (`{ ctx: {} }`), and the `where` it returns is checked against the schema. A rule that throws
 * without a context (`ctx.user.id`) is checked on its first request instead.
 *
 * @throws {NativeSchemaError} On a `where` naming an unknown field or relation.
 */
export function checkRuleWheres(api: ApiModel): void {
  for (const { fn, model, at } of whereRules(api)) {
    let value: unknown;
    try {
      value = (fn as (a: { ctx: unknown }) => unknown)({ ctx: {} });
    } catch {
      continue;
    }
    if (typeof value === "boolean") continue;
    const problem = whereProblem(api.schema, model, value, at);
    if (problem) throw new NativeSchemaError(problem);
  }
}

/** `FORBIDDEN`, with `extensions.model` and `operation` (or `field`). */
export function forbidden(message: string, extensions: AnyRecord): GraphQLError {
  return new GraphQLError(message, { extensions: { code: "FORBIDDEN", ...extensions } });
}

/** `UNAUTHENTICATED`, before anything runs. */
export function unauthenticated(model: string, op: RootOperation): GraphQLError {
  return new GraphQLError(`${model}.${op} needs an authenticated request.`, {
    extensions: { code: "UNAUTHENTICATED", model, operation: op },
  });
}

/** The rule group a root operation belongs to (`upsert`: both create and update). */
function groupsOf(op: RootOperation): ("read" | "create" | "update" | "delete")[] {
  if (!isWrite(op)) return ["read"];
  if (op === "upsert") return ["create", "update"];
  if (op === "create" || op === "createMany") return ["create"];
  if (op === "update" || op === "updateMany") return ["update"];
  return ["delete"];
}

/** The auth of one request: evaluated once, shared by its root fields. */
export class RequestAuth {
  /** The engine rules of this request (empty: none). */
  readonly rules: EngineRules;
  readonly authenticated: boolean;
  /** `Model.field` keys of the fields a context-only rule denies to this request. */
  private readonly denied = new Set<string>();

  constructor(
    private readonly api: ApiModel,
    readonly ctx: unknown,
  ) {
    const config = api.config;
    this.authenticated = config.isAuthenticated(ctx);
    const rules: Record<string, ModelRules> = {};
    const call = (fn: AnyFn, at: string, args: AnyRecord = {}): unknown => {
      try {
        return (fn as (a: AnyRecord) => unknown)({ ctx, ...args });
      } catch (e) {
        throw new Error(`${at} threw: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
    };
    const whereRule = (fn: AnyFn, model: ResolvedNodeModel, at: string): RuleValue => {
      const v = call(fn, at);
      if (typeof v === "boolean") return v;
      const problem = whereProblem(api.schema, model, v, at);
      if (problem) throw new Error(problem);
      return v as RuleValue;
    };
    for (const node of api.schema.nodes) {
      const out: {
        -readonly [K in keyof ModelRules]: ModelRules[K];
      } = {};
      const configured: ConfiguredRules | undefined = config.rules.get(node.name);
      const at = `config.models.${node.name}.rules`;
      if (configured) {
        for (const k of ["read", "update", "delete"] as const) {
          const fn = configured[k];
          if (fn) out[k] = whereRule(fn, node, `${at}.${k}`);
        }
        const create = configured.create;
        if (create) {
          out.create = (data) => call(create, `${at}.create`, { data }) === true;
        }
        for (const k of ["connect", "disconnect"] as const) {
          const per = configured[k];
          if (!per) continue;
          const evaluated: Record<string, RuleValue> = {};
          for (const [rel, fn] of Object.entries(per)) {
            if (!fn) continue;
            const f = node.fields.find((x) => x.name === rel)!;
            if (f.kind !== "relation") continue;
            evaluated[rel] = whereRule(fn, api.node(f.target), `${at}.${k}.${rel}`);
          }
          out[k] = evaluated;
        }
        if (configured.after) {
          const after: { create?: RuleValue; update?: RuleValue } = {};
          for (const k of ["create", "update"] as const) {
            const fn = configured.after[k];
            if (fn) after[k] = whereRule(fn, node, `${at}.after.${k}`);
          }
          out.after = after;
        }
      }
      // `authenticated` on a whole group: for an anonymous request, the model's nodes are not
      // there (read) or cannot be written, wherever the model is reached.
      if (!this.authenticated) {
        const groups = config.authenticatedGroups(node.name);
        if (groups.has("read")) out.read = false;
        if (groups.has("create")) out.create = false;
        if (groups.has("update")) out.update = false;
        if (groups.has("delete")) out.delete = false;
      }
      // Field rules: context-only ones are enforced by the translator (FORBIDDEN) and read as
      // null by the engine; row-dependent ones are compiled into the statement.
      const fields: Record<string, RuleValue> = {};
      for (const f of node.fields) {
        const rule = config.fieldRules.get(`${node.name}.${f.name}`);
        if (!rule) continue;
        const where = `config.models.${node.name}.fields.${f.name}.read`;
        if (rule.kind === "context") {
          if (call(rule.fn, where) !== true) {
            this.denied.add(`${node.name}.${f.name}`);
            if (f.kind === "scalar") fields[f.name] = false;
          }
        } else {
          const v = whereRule(rule.fn, node, `${where}.where`);
          if (v !== true) fields[f.name] = v;
        }
      }
      if (Object.keys(fields).length) out.fields = fields;
      if (Object.keys(out).length) rules[node.name] = out;
    }
    this.rules = rules;
  }

  /** Whether this request has any engine rule. */
  get hasRules(): boolean {
    return Object.keys(this.rules).length > 0;
  }

  /**
   * Whether a context-only rule denies `model.field` to this request (on the model or on an
   * interface declaring the field).
   */
  fieldDenied(model: ResolvedNodeModel, field: string): boolean {
    if (this.denied.size === 0) return false;
    if (this.denied.has(`${model.name}.${field}`)) return true;
    return (model.interfaces ?? []).some((i) => this.denied.has(`${i}.${field}`));
  }

  /** The `FORBIDDEN` error of a denied field used in `where` / `orderBy` / `_count`. */
  fieldForbidden(model: ResolvedNodeModel, field: string, use: string): GraphQLError {
    return forbidden(`${model.name}.${field} cannot be ${use} by this request.`, {
      model: model.name,
      field,
    });
  }

  /**
   * Fail the root field before anything runs: `UNAUTHENTICATED` when `op` needs an authenticated
   * request, `FORBIDDEN` when a rule denies the whole operation (`false`).
   */
  checkRoot(model: ResolvedNodeModel, op: RootOperation): void {
    if (!this.authenticated && this.api.config.authenticated(model.name, op)) {
      throw unauthenticated(model.name, op);
    }
    const own = [model.name, ...(model.interfaces ?? [])].map((n) => this.rules[n]);
    for (const g of groupsOf(op)) {
      if (own.some((r) => r?.[g] === false)) {
        throw forbidden(`The rules do not allow ${model.name}.${op} for this request.`, {
          model: model.name,
          operation: op,
        });
      }
    }
  }
}
