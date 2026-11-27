/**
 * `migrate-rules`: a draft of the native `rules` / `authenticated` config from the v7
 * `@authorization` / `@authentication` directives, as TypeScript to review. A v7 rule the native
 * API cannot express (or only in a way that could grant more access) is written as a
 * `TODO(cyphra)` comment with the v7 rule, never as code.
 *
 * @packageDocumentation
 */

import { print } from "graphql";
import type { ResolvedRelationField } from "@cyphra/schema";
import { parseJwtWhereKey, GENERIC_OPERATORS } from "../v7/auth/context.js";
import type {
  AuthOperation,
  AuthenticationAnnotation,
  AuthorizationRule,
  AuthorizationValidateRule,
  NodeType,
} from "../v7/model.js";
import type { MigrationContext } from "./context.js";
import { fromJs, hasRef, isObj, toAst, type Value } from "./value.js";
import { Issues, WhereTranslator } from "./where.js";

/** How one v7 rule (or `@authentication`) came out. */
export type RuleDraftStatus =
  /** Every operation it names has a drafted native rule (with notes on how it differs). */
  | "drafted"
  /** Some of its operations are drafted, the others are `TODO(cyphra)` comments. */
  | "partial"
  /** Nothing drafted: a `TODO(cyphra)` comment. */
  | "todo";

/** One v7 rule and what became of it. */
export type RuleDraftEntry = {
  /** `Post` or `Post.email` (field-level rules). */
  readonly target: string;
  /** `filter`, `validate` or `authentication`. */
  readonly kind: "filter" | "validate" | "authentication";
  /** The v7 rule, printed. */
  readonly rule: string;
  readonly status: RuleDraftStatus;
  /** Why parts are TODO, or how the draft differs. */
  readonly notes: readonly string[];
};

/** The result of {@link draftRules}. */
export type RulesDraft = {
  /** The TypeScript module (a `defineGraphQL` config to merge into the API's). */
  readonly code: string;
  readonly entries: readonly RuleDraftEntry[];
  readonly drafted: number;
  readonly partial: number;
  readonly todo: number;
};

/** Options of {@link draftRules}. */
export type DraftRulesOptions = {
  /**
   * Module exporting the generated `CyphraTypeMap` (e.g. `"./cyphra.gen.js"`): the draft is then
   * typed against the client. Default: the loose `TypeMap` of `cyphra`.
   */
  readonly typeMapModule?: string;
};

const FILTER_OPS: readonly AuthOperation[] = [
  "READ",
  "AGGREGATE",
  "UPDATE",
  "DELETE",
  "CREATE_RELATIONSHIP",
  "DELETE_RELATIONSHIP",
];
const VALIDATE_OPS: readonly AuthOperation[] = [
  ...FILTER_OPS.slice(0, 2),
  "CREATE",
  ...FILTER_OPS.slice(2),
];

/** The native rule keys a draft fills. */
type RuleKey = "read" | "create" | "update" | "delete" | "after.create" | "after.update";

/** One drafted part of a rule: an expression (`Rule` valued) with the comment above it. */
/**
 * One drafted part of a rule: an expression (`Rule` valued) with the comment above it. Parts of
 * one `group` (the filter rules of one type, or its validate rules) are combined with OR, like
 * v7 combines the rules of one annotation; groups are combined with AND.
 */
type Part = { readonly expr: string; readonly comment: string; readonly group: string };

/** `anyOf` within each group, `allOf` across groups (identical parts once). */
function combine(parts: readonly Part[]): string {
  const groups = new Map<string, string[]>();
  for (const p of parts) {
    const g = groups.get(p.group) ?? [];
    if (!g.includes(p.expr)) g.push(p.expr);
    groups.set(p.group, g);
  }
  const each = [...groups.values()].map((g) => (g.length === 1 ? g[0]! : `anyOf(${g.join(", ")})`));
  return each.length === 1 ? each[0]! : `allOf(${each.join(", ")})`;
}

/** An object literal is parenthesized as an arrow function's body. */
function arrowBody(expr: string): string {
  return expr.startsWith("{") ? `(${expr})` : expr;
}

function comments(parts: readonly Part[]): string[] {
  return [...new Set(parts.map((p) => p.comment))];
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function key(k: string): string {
  return IDENT.test(k) ? k : JSON.stringify(k);
}

/** `$jwt.a.b` → `ctx.jwt?.a?.b`; `$context.user.id` → `ctx.user?.id`. */
function refExpr(path: string, claims: ReadonlyMap<string, string>): string {
  const [root, ...rest] = path.slice(1).split(".");
  let segments = rest;
  if (root === "jwt" && rest.length) {
    const mapped = claims.get(rest[0]!);
    if (mapped) segments = [...mapped.split("."), ...rest.slice(1)];
  }
  const access = (s: string) => (IDENT.test(s) ? `?.${s}` : `?.[${JSON.stringify(s)}]`);
  if (root === "jwt") return `ctx.jwt${segments.map(access).join("")}`;
  const [first, ...more] = segments;
  return `ctx${IDENT.test(first!) ? `.${first}` : `[${JSON.stringify(first)}]`}${more.map(access).join("")}`;
}

function literal(v: Value, refs: (path: string) => string): string {
  switch (v.k) {
    case "null":
      return "null";
    case "string":
      return JSON.stringify(v.v);
    case "enum":
      return JSON.stringify(v.v);
    case "number":
      return v.raw;
    case "boolean":
      return String(v.v);
    case "ref":
      return refs(v.path);
    case "var":
      return `undefined /* $${v.name} */`;
    case "list":
      return `[${v.items.map((x) => literal(x, refs)).join(", ")}]`;
    case "obj":
      return v.fields.length
        ? `{ ${v.fields.map((f) => `${key(f.key)}: ${literal(f.value, refs)}`).join(", ")} }`
        : "{}";
  }
}

const RELATION_KEYS = new Set(["some", "every", "none", "is", "isNot"]);

/**
 * A native `where` (with `$jwt` / `$context` references) as a TypeScript expression of the
 * client's `where`. A comparison with a reference becomes `given(ref, (v) => ({ … }))`: like v7,
 * it matches nothing when the value is missing.
 */
function whereCode(w: Value, claims: ReadonlyMap<string, string>): string {
  const refs = (p: string) => refExpr(p, claims);
  if (!isObj(w)) return literal(w, refs);
  const entries: string[] = [];
  const guarded: string[] = [];
  for (const f of w.fields) {
    const k = f.key === "_on" ? "$on" : f.key === "_typename" ? "__typename" : f.key;
    if (!hasRef(f.value)) {
      entries.push(`${key(k)}: ${literal(f.value, refs)}`);
      continue;
    }
    if (f.key === "AND" || f.key === "OR") {
      const items = f.value.k === "list" ? f.value.items : [f.value];
      entries.push(`${key(k)}: [${items.map((x) => whereCode(x, claims)).join(", ")}]`);
    } else if (f.key === "NOT") {
      entries.push(`NOT: ${whereCode(f.value, claims)}`);
    } else if (f.key === "_on" && isObj(f.value)) {
      entries.push(
        `$on: { ${f.value.fields.map((m) => `${key(m.key)}: ${whereCode(m.value, claims)}`).join(", ")} }`,
      );
    } else if (isObj(f.value) && f.value.fields.every((x) => RELATION_KEYS.has(x.key))) {
      entries.push(
        `${key(k)}: { ${f.value.fields.map((q) => `${q.key}: ${whereCode(q.value, claims)}`).join(", ")} }`,
      );
    } else {
      // A comparison: one `given` per reference, innermost last.
      const found: string[] = [];
      const collect = (v: Value): Value => {
        if (v.k === "ref") {
          found.push(v.path);
          return { k: "ref", path: `#${found.length - 1}` };
        }
        if (v.k === "list") return { ...v, items: v.items.map(collect) };
        if (v.k === "obj")
          return { ...v, fields: v.fields.map((x) => ({ ...x, value: collect(x.value) })) };
        return v;
      };
      const body = literal(collect(f.value), (p) => `v${p.slice(1)}`);
      let code = `({ ${key(k)}: ${body} })`;
      for (let i = found.length - 1; i >= 0; i--) {
        code = `given(${refs(found[i]!)}, (v${i}) => ${code})`;
      }
      guarded.push(code);
    }
  }
  if (guarded.length) {
    const and = entries.findIndex((e) => e.startsWith("AND: ["));
    if (and >= 0) entries[and] = entries[and]!.replace(/\]$/, `, ${guarded.join(", ")}]`);
    else entries.push(`AND: [${guarded.join(", ")}]`);
  }
  return entries.length ? `{ ${entries.join(", ")} }` : "{}";
}

/** A v7 `where.jwt` filter as a boolean expression. */
function jwtCode(
  w: Value,
  claims: ReadonlyMap<string, string>,
  notes: string[],
): string | undefined {
  if (!isObj(w)) return undefined;
  const refs = (p: string) => refExpr(p, claims);
  const parts: string[] = [];
  for (const f of w.fields) {
    if (f.key === "AND" || f.key === "OR") {
      const items = f.value.k === "list" ? f.value.items : [f.value];
      const sub = items.map((x) => jwtCode(x, claims, notes));
      if (sub.some((x) => x === undefined)) return undefined;
      parts.push(
        `(${sub.join(f.key === "AND" ? " && " : " || ") || (f.key === "AND" ? "true" : "false")})`,
      );
      continue;
    }
    if (f.key === "NOT") {
      const sub = jwtCode(f.value, claims, notes);
      if (sub === undefined) return undefined;
      notes.push("NOT over a missing claim is true here (v7: no match)");
      parts.push(`!(${sub})`);
      continue;
    }
    let field: string;
    let operator: string | undefined;
    try {
      ({ field, operator } = parseJwtWhereKey(f.key));
    } catch {
      return undefined;
    }
    const claim = refExpr(`$jwt.${field}`, claims);
    if (operator) {
      parts.push(`claim(${claim}, ${JSON.stringify(operator)}, ${literal(f.value, refs)})`);
      continue;
    }
    if (!isObj(f.value)) return undefined;
    for (const o of f.value.fields) {
      const op = GENERIC_OPERATORS[o.key];
      if (!op) return undefined;
      parts.push(`claim(${claim}, ${JSON.stringify(op)}, ${literal(o.value, refs)})`);
    }
  }
  return parts.length ? parts.join(" && ") : "true";
}

/** The v7 rule printed as GraphQL (for comments). */
function printRule(v: unknown): string {
  return print(toAst(fromJs(v))).replace(/\s+/g, " ");
}

function opsOf(rule: AuthorizationRule, all: readonly AuthOperation[]): readonly AuthOperation[] {
  return rule.operations.length ? rule.operations : all;
}

/** The helpers a draft may use, each printed only when the draft uses it. */
const HELPERS: readonly { readonly name: string; readonly code: readonly string[] }[] = [
  {
    name: "authenticated",
    code: [
      "/** Whether the request is authenticated (v7 requireAuthentication: a verified JWT). */",
      "const authenticated = (ctx: Ctx): boolean => ctx.jwt !== undefined && ctx.jwt !== null;",
    ],
  },
  {
    name: "anyOf",
    code: [
      "/** v7 filter rules: one of them holds (OR). */",
      "function anyOf(...rules: Rule[]): Rule {",
      "  if (rules.includes(true)) return true;",
      '  const wheres = rules.filter((r): r is Where => typeof r === "object");',
      "  return wheres.length === 0 ? false : wheres.length === 1 ? wheres[0]! : { OR: wheres };",
      "}",
    ],
  },
  {
    name: "allOf",
    code: [
      "/** Every rule holds (AND). */",
      "function allOf(...rules: Rule[]): Rule {",
      "  if (rules.includes(false)) return false;",
      '  const wheres = rules.filter((r): r is Where => typeof r === "object");',
      "  return wheres.length === 0 ? true : wheres.length === 1 ? wheres[0]! : { AND: wheres };",
      "}",
    ],
  },
  {
    name: "not",
    code: [
      "function not(rule: Rule): Rule {",
      '  return typeof rule === "boolean" ? !rule : { NOT: rule };',
      "}",
    ],
  },
  {
    name: "given",
    code: [
      "/** `make(value)`, or a filter matching nothing when the value is missing (as in v7). */",
      "// eslint-disable-next-line @typescript-eslint/no-explicit-any",
      "function given(value: unknown, make: (value: any) => Where): Where {",
      "  return value === undefined || value === null ? { OR: [] } : make(value);",
      "}",
    ],
  },
  {
    name: "claim",
    code: [
      "/** A v7 JWT comparison (where.jwt); false when the claim is missing. */",
      "function claim(received: unknown, operator: string, expected: unknown): boolean {",
      "  if (received === undefined || received === null) return false;",
      "  const r = received as never;",
      "  switch (operator) {",
      '    case "EQ":',
      "      return received === expected;",
      '    case "IN":',
      "      return Array.isArray(expected) && expected.includes(received);",
      '    case "INCLUDES":',
      "      return Array.isArray(received) && received.includes(expected);",
      '    case "CONTAINS":',
      '      return typeof received === "string" && received.includes(String(expected));',
      '    case "STARTS_WITH":',
      '      return typeof received === "string" && received.startsWith(String(expected));',
      '    case "ENDS_WITH":',
      '      return typeof received === "string" && received.endsWith(String(expected));',
      '    case "MATCHES":',
      '      return typeof received === "string" && new RegExp(`^(?:${String(expected)})$`).test(received);',
      '    case "LT":',
      "      return r < (expected as never);",
      '    case "LTE":',
      "      return r <= (expected as never);",
      '    case "GT":',
      "      return r > (expected as never);",
      '    case "GTE":',
      "      return r >= (expected as never);",
      "  }",
      "  return false;",
      "}",
    ],
  },
];

/** Drafts the rules of every type. */
class RulesDrafter {
  readonly entries: RuleDraftEntry[] = [];
  /** Native model → rule key → parts (see {@link combine}). */
  private readonly rules = new Map<string, Map<string, Part[]>>();
  /** Native model → relation → connect / disconnect parts. */
  private readonly relationRules = new Map<string, Map<string, Map<string, Part[]>>>();
  private readonly authenticated = new Map<string, { groups: Set<string>; comment: string[] }>();
  private readonly todos = new Map<string, string[]>();
  /** TODOs that belong to no model (custom root fields). */
  readonly globalTodos: string[] = [];
  private readonly claims: ReadonlyMap<string, string>;

  constructor(readonly ctx: MigrationContext) {
    this.claims = ctx.v7.jwtClaims;
  }

  private nativeName(n: NodeType): string {
    return this.ctx.nativeModel(n.name)?.name ?? n.name;
  }

  private todo(model: string, lines: string[]): void {
    this.todos.set(model, [...(this.todos.get(model) ?? []), ...lines]);
  }

  private slot(model: string, k: RuleKey): Part[] {
    if (!this.rules.has(model)) this.rules.set(model, new Map());
    const m = this.rules.get(model)!;
    if (!m.has(k)) m.set(k, []);
    return m.get(k)!;
  }

  private relationSlot(model: string, k: "connect" | "disconnect", rel: string): Part[] {
    if (!this.relationRules.has(model)) this.relationRules.set(model, new Map());
    const m = this.relationRules.get(model)!;
    if (!m.has(k)) m.set(k, new Map());
    const r = m.get(k)!;
    if (!r.has(rel)) r.set(rel, []);
    return r.get(rel)!;
  }

  /**
   * The rule's condition as an expression of type `Rule` (`boolean | where`): `requireAuthentication`,
   * then `where` (`node`, `jwt`, `AND`, `OR`, `NOT`). `undefined` when part of it has no native
   * equivalent (`why` says what).
   */
  private ruleExpr(
    n: NodeType,
    rule: AuthorizationRule,
    why: string[],
  ): { expr: string; node: boolean } | undefined {
    const issues = new Issues();
    const where = new WhereTranslator(this.ctx, issues);
    let usesNode = false;
    const notes: string[] = [];
    const expr = (w: Value): string | undefined => {
      if (!isObj(w)) return undefined;
      const terms: string[] = [];
      for (const f of w.fields) {
        if (f.key === "node") {
          usesNode = true;
          const translated = where.where(n.name, f.value, `${n.name}.where.node`);
          terms.push(whereCode(translated, this.claims));
        } else if (f.key === "jwt") {
          const j = jwtCode(f.value, this.claims, notes);
          if (j === undefined) {
            why.push(`where.jwt: ${printRule(toJsLoose(f.value))} cannot be drafted`);
            return undefined;
          }
          terms.push(j);
        } else if (f.key === "AND" || f.key === "OR") {
          const items = f.value.k === "list" ? f.value.items : [f.value];
          const sub = items.map(expr);
          if (sub.some((x) => x === undefined)) return undefined;
          terms.push(`${f.key === "AND" ? "allOf" : "anyOf"}(${sub.join(", ")})`);
        } else if (f.key === "NOT") {
          const sub = expr(f.value);
          if (sub === undefined) return undefined;
          terms.push(`not(${sub})`);
        } else {
          why.push(`where.${f.key} is not a v7 rule key`);
          return undefined;
        }
      }
      return terms.length === 0
        ? "true"
        : terms.length === 1
          ? terms[0]
          : `allOf(${terms.join(", ")})`;
    };
    const body = expr(fromJs(rule.where));
    if (issues.blocked) {
      why.push(...issues.list.filter((i) => i.kind === "blocking").map((i) => i.message));
      return undefined;
    }
    if (body === undefined) return undefined;
    why.push(...notes);
    const e = rule.requireAuthentication
      ? body === "true"
        ? "authenticated(ctx)"
        : `allOf(authenticated(ctx), ${body})`
      : body;
    return { expr: e, node: usesNode };
  }

  draftType(n: NodeType, schemaAuthentication?: AuthenticationAnnotation): void {
    const model = this.nativeName(n);
    const authz = n.auth.authorization;
    for (const [i, rule] of (authz?.filter ?? []).entries()) {
      this.filterRule(n, model, rule, i);
    }
    for (const [i, rule] of (authz?.validate ?? []).entries()) {
      this.validateRule(n, model, rule, i);
    }
    const filters = authz?.filter ?? [];
    const readRules = filters.filter((r) => opsOf(r, FILTER_OPS).includes("READ"));
    const aggRules = filters.filter((r) => opsOf(r, FILTER_OPS).includes("AGGREGATE"));
    if (readRules.length !== aggRules.length || readRules.some((r) => !aggRules.includes(r))) {
      this.todo(model, [
        "v7 has different READ and AGGREGATE filter rules for this type; native aggregates, counts and groupBy use the read rule.",
      ]);
    }
    if (n.auth.authentication) this.authentication(n, model, n.auth.authentication, "type");
    if (schemaAuthentication) this.authentication(n, model, schemaAuthentication, "schema");
    for (const a of n.attributes) {
      if (!a.auth?.authorization && !a.auth?.authentication) continue;
      this.fieldRules(n, model, a.name, a.auth);
    }
  }

  private filterRule(n: NodeType, model: string, rule: AuthorizationRule, index: number): void {
    const ops = opsOf(rule, FILTER_OPS);
    const printed = printRule(rule.where);
    const why: string[] = [];
    const expr = this.ruleExpr(n, rule, why);
    const label = `v7 filter #${index + 1} (${rule.operations.length ? ops.join(", ") : "all operations"}${rule.requireAuthentication ? "" : ", requireAuthentication: false"}): ${printed}`;
    const notes: string[] = [...why];
    let drafted = 0;
    let todo = 0;
    if (!expr) {
      this.todo(model, [`${label}`, `  not drafted: ${why.join("; ") || "no native equivalent"}`]);
      this.entries.push({ target: n.name, kind: "filter", rule: printed, status: "todo", notes });
      return;
    }
    const part = (comment: string): Part => ({
      expr: expr.expr,
      comment,
      group: `${n.name} filter`,
    });
    for (const op of ops) {
      if (op === "READ") {
        this.slot(model, "read").push(part(label));
        drafted++;
      } else if (op === "AGGREGATE") {
        // Covered by `read` (checked above when READ and AGGREGATE rules differ).
      } else if (op === "UPDATE") {
        this.slot(model, "update").push(part(label));
        drafted++;
      } else if (op === "DELETE") {
        this.slot(model, "delete").push(part(label));
        drafted++;
      } else if (op === "CREATE_RELATIONSHIP" || op === "DELETE_RELATIONSHIP") {
        if (this.relationshipRule(n, model, op, expr, label, `${n.name} filter`)) drafted++;
        else {
          todo++;
          notes.push(
            `${op}: a node-dependent rule on the type's own relationships has no native equivalent`,
          );
        }
      }
    }
    if (ops.includes("READ")) {
      notes.push(
        "native read rules also apply to relation filters, _count and the targets of nested writes",
      );
    }
    this.entries.push({
      target: n.name,
      kind: "filter",
      rule: printed,
      status: todo === 0 ? "drafted" : drafted ? "partial" : "todo",
      notes,
    });
  }

  /**
   * `CREATE_RELATIONSHIP` / `DELETE_RELATIONSHIP` → `connect` / `disconnect` rules: on every
   * relation leading to the type (the rule then filters the nodes that may be linked), and, for a
   * context-only rule, on the type's own relations. A node-dependent rule on the type's own
   * relations is a TODO.
   */
  private relationshipRule(
    n: NodeType,
    model: string,
    op: AuthOperation,
    expr: { expr: string; node: boolean },
    label: string,
    group: string,
  ): boolean {
    const k = op === "CREATE_RELATIONSHIP" ? "connect" : "disconnect";
    for (const m of this.ctx.model.nodes) {
      for (const f of m.fields) {
        if (f.kind !== "relation" || (f as ResolvedRelationField).target !== model) continue;
        this.relationSlot(m.name, k, f.name).push({
          expr: expr.expr,
          comment: `${n.name}: ${label}`,
          group,
        });
      }
    }
    if (expr.node) {
      this.todo(model, [
        `${label}`,
        `  ${k}: drafted on the relations leading to ${model} only; from ${model}'s side, the nodes of ${model} a nested write starts from are guarded by its update rule, not by a ${k} rule.`,
      ]);
      return false;
    }
    const own = this.ctx.nativeModel(n.name)?.fields.filter((f) => f.kind === "relation") ?? [];
    for (const f of own)
      this.relationSlot(model, k, f.name).push({
        expr: expr.expr,
        comment: `${n.name}: ${label}`,
        group,
      });
    return true;
  }

  private validateRule(
    n: NodeType,
    model: string,
    rule: AuthorizationValidateRule,
    index: number,
  ): void {
    const ops = opsOf(rule, VALIDATE_OPS);
    const printed = printRule(rule.where);
    const why: string[] = [];
    const expr = this.ruleExpr(n, rule, why);
    const when = rule.when.length ? rule.when : ["BEFORE", "AFTER"];
    const label = `v7 validate #${index + 1} (${rule.operations.length ? ops.join(", ") : "all operations"}, when ${when.join(", ")}${rule.requireAuthentication ? "" : ", requireAuthentication: false"}): ${printed}`;
    const notes: string[] = [...why];
    if (!expr) {
      this.todo(model, [label, `  not drafted: ${why.join("; ") || "no native equivalent"}`]);
      this.entries.push({ target: n.name, kind: "validate", rule: printed, status: "todo", notes });
      return;
    }
    let drafted = 0;
    let todo = 0;
    const filterNote =
      "v7 failed the whole request with Forbidden; the native rule leaves the node out (NOT_FOUND for writes)";
    for (const op of ops) {
      if (op === "CREATE") {
        if (expr.node)
          this.slot(model, "after.create").push({
            expr: expr.expr,
            comment: label,
            group: `${n.name} validate`,
          });
        else
          this.slot(model, "create").push({
            expr: expr.expr,
            comment: label,
            group: `${n.name} validate`,
          });
        drafted++;
      } else if (op === "UPDATE") {
        if (when.includes("BEFORE")) {
          this.slot(model, "update").push({
            expr: expr.expr,
            comment: `${label} (${filterNote})`,
            group: `${n.name} validate`,
          });
        }
        if (when.includes("AFTER") && expr.node) {
          this.slot(model, "after.update").push({
            expr: expr.expr,
            comment: label,
            group: `${n.name} validate`,
          });
        }
        drafted++;
      } else if (op === "DELETE") {
        this.slot(model, "delete").push({
          expr: expr.expr,
          comment: `${label} (${filterNote})`,
          group: `${n.name} validate`,
        });
        drafted++;
      } else if (op === "READ") {
        this.slot(model, "read").push({
          expr: expr.expr,
          comment: `${label} (${filterNote})`,
          group: `${n.name} validate`,
        });
        drafted++;
      } else if (op === "AGGREGATE") {
        // Covered by `read`.
      } else if (op === "CREATE_RELATIONSHIP" || op === "DELETE_RELATIONSHIP") {
        if (this.relationshipRule(n, model, op, expr, label, `${n.name} validate`)) drafted++;
        else todo++;
      }
    }
    if (ops.some((o) => o === "UPDATE" || o === "DELETE" || o === "READ")) notes.push(filterNote);
    this.entries.push({
      target: n.name,
      kind: "validate",
      rule: printed,
      status: todo === 0 ? "drafted" : drafted ? "partial" : "todo",
      notes,
    });
  }

  private authentication(
    n: NodeType,
    model: string,
    a: AuthenticationAnnotation,
    level: "type" | "schema",
  ): void {
    const ops = [...a.operations];
    const printed = `@authentication(operations: [${ops.join(", ")}]${a.jwt ? `, jwt: ${printRule(a.jwt)}` : ""})${level === "schema" ? " (extend schema)" : ""}`;
    if (a.jwt) {
      this.todo(model, [
        printed,
        "  not drafted: authenticated has no JWT filter; check the claims in isAuthenticated, or write a rule (it hides nodes instead of failing with UNAUTHENTICATED).",
      ]);
      this.entries.push({
        target: n.name,
        kind: "authentication",
        rule: printed,
        status: "todo",
        notes: [],
      });
      return;
    }
    if (!this.authenticated.has(model))
      this.authenticated.set(model, { groups: new Set(), comment: [] });
    const entry = this.authenticated.get(model)!;
    entry.comment.push(printed);
    const notes: string[] = [];
    let todo = 0;
    for (const op of ops) {
      if (op === "READ") entry.groups.add("read");
      else if (op === "CREATE") entry.groups.add("create");
      else if (op === "UPDATE") entry.groups.add("update");
      else if (op === "DELETE") entry.groups.add("delete");
      else if (op === "AGGREGATE") {
        if (!ops.includes("READ")) {
          todo++;
          notes.push(
            'AGGREGATE without READ: native aggregates are read operations (authenticated: { read: ["aggregate", "groupBy"] } guards the root fields only)',
          );
        }
      } else if (op === "SUBSCRIBE") {
        notes.push("SUBSCRIBE: the native API has no subscriptions yet");
      } else {
        todo++;
        notes.push(
          `${op}: no native authenticated group for relationship writes (nested writes need update / create on the parent)`,
        );
      }
    }
    if (notes.length) this.todo(model, [printed, ...notes.map((x) => `  ${x}`)]);
    this.entries.push({
      target: n.name,
      kind: "authentication",
      rule: printed,
      status: todo === 0 ? "drafted" : entry.groups.size ? "partial" : "todo",
      notes,
    });
  }

  private fieldRules(
    n: NodeType,
    model: string,
    field: string,
    auth: NonNullable<NodeType["attributes"][number]["auth"]>,
  ): void {
    const lines: string[] = [];
    for (const r of auth.authorization?.filter ?? []) {
      lines.push(
        `v7 field filter on ${n.name}.${field}: ${printRule(r.where)} (${opsOf(r, FILTER_OPS).join(", ")})`,
      );
      this.entries.push({
        target: `${n.name}.${field}`,
        kind: "filter",
        rule: printRule(r.where),
        status: "todo",
        notes: [],
      });
    }
    for (const r of auth.authorization?.validate ?? []) {
      lines.push(
        `v7 field validate on ${n.name}.${field}: ${printRule(r.where)} (${opsOf(r, VALIDATE_OPS).join(", ")})`,
      );
      this.entries.push({
        target: `${n.name}.${field}`,
        kind: "validate",
        rule: printRule(r.where),
        status: "todo",
        notes: [],
      });
    }
    if (auth.authentication) {
      lines.push(
        `v7 field @authentication on ${n.name}.${field} (${[...auth.authentication.operations].join(", ")})`,
      );
      this.entries.push({
        target: `${n.name}.${field}`,
        kind: "authentication",
        rule: "@authentication",
        status: "todo",
        notes: [],
      });
    }
    lines.push(
      `  not drafted: v7 field rules filter the node (or fail the request) when the field is selected or written; native field rules make the field null (fields: { ${field}: { read: … } }) and cannot guard writes of one field.`,
    );
    this.todo(model, lines);
  }

  /** The module. */
  code(options: DraftRulesOptions): string {
    const modelNames = new Set([
      ...this.rules.keys(),
      ...this.relationRules.keys(),
      ...this.authenticated.keys(),
      ...this.todos.keys(),
    ]);
    const typeMap = options.typeMapModule ? "CyphraTypeMap" : "TypeMap";
    const out: string[] = [
      "// Drafted by `cyphra graphql migrate-rules` from the @authorization and @authentication",
      "// directives of the v7 type definitions. This is a draft to review, not a translation: the",
      "// native API applies rules differently on purpose (https://www.cyphra.dev/graphql/native#rules):",
      "// - read rules also apply to relation filters, _count, aggregates and the targets of nested",
      "//   writes (v7: only where the type's nodes are returned);",
      "// - a node an update / delete rule leaves out is NOT_FOUND (v7 validate rules failed the",
      "//   request with Forbidden);",
      "// - a comparison with a missing $jwt / $context value matches nothing, as in v7 (given()).",
      "// Every TODO(cyphra) is a v7 rule the native API cannot express as is: decide how to write it.",
      `import { defineGraphQL } from "@cyphra/graphql";`,
      options.typeMapModule
        ? `import type { CyphraTypeMap } from ${JSON.stringify(options.typeMapModule)};`
        : `import type { TypeMap } from "cyphra";`,
      "",
      "/** What rules see: native.jwtContext sets `jwt` (the verified payload); other keys are $context values. */",
      "// eslint-disable-next-line @typescript-eslint/no-explicit-any",
      "type Ctx = { jwt?: Record<string, any>; [key: string]: any };",
      "",
    ];
    const models: string[] = [
      ...this.globalTodos.map((t) => `// TODO(cyphra): ${t}`),
      ...(this.globalTodos.length ? [""] : []),
      `export default defineGraphQL<${typeMap}, Ctx>({`,
      "  models: {",
    ];
    for (const model of [...modelNames].sort()) {
      models.push(`    ${key(model)}: {`);
      for (const line of this.todos.get(model) ?? []) models.push(`      // TODO(cyphra): ${line}`);
      const auth = this.authenticated.get(model);
      if (auth && auth.groups.size) {
        for (const c of auth.comment) models.push(`      // v7 ${c}`);
        const all = ["read", "create", "update", "delete"].every((g) => auth.groups.has(g));
        models.push(
          all
            ? "      authenticated: true,"
            : `      authenticated: { ${[...auth.groups].map((g) => `${g}: true`).join(", ")} },`,
        );
      }
      const slots = this.rules.get(model);
      const rel = this.relationRules.get(model);
      if (slots?.size || rel?.size) {
        models.push("      rules: {");
        const after: string[] = [];
        for (const k of [
          "read",
          "create",
          "update",
          "delete",
          "after.create",
          "after.update",
        ] as const) {
          const parts = slots?.get(k);
          if (!parts?.length) continue;
          const lines = comments(parts).map((c) => `// ${c}`);
          const body = combine(parts);
          const fn =
            k === "create" ? `({ ctx }) => ${body} === true` : `({ ctx }) => ${arrowBody(body)}`;
          if (k.startsWith("after.")) {
            after.push(...lines.map((l) => `  ${l}`), `  ${k.slice(6)}: ${fn},`);
          } else {
            models.push(...lines.map((l) => `        ${l}`), `        ${k}: ${fn},`);
          }
        }
        if (after.length) {
          models.push("        after: {", ...after.map((l) => `        ${l}`), "        },");
        }
        for (const k of ["connect", "disconnect"] as const) {
          const m = rel?.get(k);
          if (!m?.size) continue;
          models.push(`        ${k}: {`);
          for (const [r, parts] of m) {
            for (const c of comments(parts)) models.push(`          // ${c}`);
            models.push(`          ${key(r)}: ({ ctx }) => ${arrowBody(combine(parts))},`);
          }
          models.push("        },");
        }
        models.push("      },");
      }
      models.push("    },");
    }
    models.push("  },", "});", "");
    // `ctx` is unused in rules that only read the node: keep the code valid for noUnusedParameters.
    const body = models.join("\n").replace(/\(\{ ctx \}\) => ((?:(?!ctx)[^\n])*),$/gm, "() => $1,");
    const used = HELPERS.filter((h) => new RegExp(`\\b${h.name}\\(`).test(body));
    const names = new Set(used.map((h) => h.name));
    if (names.has("anyOf") || names.has("allOf") || names.has("not")) {
      out.push("type Where = Record<string, unknown>;", "type Rule = boolean | Where;", "");
    } else if (names.has("given")) {
      out.push("type Where = Record<string, unknown>;", "");
    }
    for (const h of used) out.push(...h.code, "");
    return `${out.join("\n")}${body}`;
  }
}

/** A value back to plain JS (for printing a rule that could not be drafted). */
function toJsLoose(v: Value): unknown {
  switch (v.k) {
    case "null":
      return null;
    case "string":
    case "enum":
    case "boolean":
      return v.v;
    case "number":
      return Number(v.raw);
    case "ref":
      return v.path;
    case "var":
      return `$${v.name}`;
    case "list":
      return v.items.map(toJsLoose);
    case "obj":
      return Object.fromEntries(v.fields.map((f) => [f.key, toJsLoose(f.value)]));
  }
}

/**
 * Draft the native rules of the v7 type definitions' `@authorization` / `@authentication`
 * directives: a `defineGraphQL` module to review (and merge into the API's config).
 *
 * @experimental
 */
export function draftRules(ctx: MigrationContext, options: DraftRulesOptions = {}): RulesDraft {
  const d = new RulesDrafter(ctx);
  for (const n of ctx.v7.nodes) d.draftType(n, ctx.v7.authentication);
  for (const [kind, root] of [
    ["Query", ctx.v7.query],
    ["Mutation", ctx.v7.mutation],
  ] as const) {
    const fields = [
      ...root.fields.filter((f) => f.authentication).map((f) => f.name),
      ...root.resolved.filter((f) => f.authentication).map((f) => f.name),
    ];
    if (root.authentication || fields.length) {
      d.globalTodos.push(
        `@authentication on ${kind}${fields.length ? ` fields ${fields.join(", ")}` : ""}: custom root fields are added with extend; check authentication in their resolvers.`,
      );
      d.entries.push({
        target: kind,
        kind: "authentication",
        rule: `@authentication on ${kind}${fields.length ? ` (${fields.join(", ")})` : ""}`,
        status: "todo",
        notes: ["custom root fields: check authentication in their resolvers (extend)"],
      });
    }
  }
  const entries = d.entries;
  return {
    code: d.code(options),
    entries,
    drafted: entries.filter((e) => e.status === "drafted").length,
    partial: entries.filter((e) => e.status === "partial").length,
    todo: entries.filter((e) => e.status === "todo").length,
  };
}
