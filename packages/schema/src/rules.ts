/**
 * Validation rules declared on scalar fields (`@length`, `@size`, `@min`, `@max`, `@email`, `@url`,
 * `@regex`, `@nonEmpty`): their schema-time checks, their resolved form (carried in
 * {@link ResolvedScalarField.rules} for the runtime and code generators) and the value checker the
 * runtime runs on every write.
 *
 * @packageDocumentation
 */

import type { Decorator, DecoratorValue, ScalarNodeField, ScalarTypeName } from "./ast.js";
import { SchemaValidationError } from "./errors.js";
import { quoteSchemaString } from "./printSchema.js";

/**
 * A validation rule of a scalar field, in a JSON-friendly form:
 *
 * - `length`: number of characters (Unicode code points) of a `String`, from `min` to `max`.
 * - `size`: number of elements of a list, from `min` to `max`.
 * - `min` / `max`: smallest / largest value, inclusive. A number for `Int` / `Float`, decimal
 *   digits for `BigInt`, ISO 8601 text for `DateTime` (`"2020-01-01T00:00:00.000Z"`) and `Date`
 *   (`"2020-01-01"`).
 * - `email`: an email address (`local@domain.tld`).
 * - `url`: an absolute `http:` or `https:` URL.
 * - `regex`: the string matches the JavaScript regular expression (anywhere: anchor it with
 *   `^…$` to match the whole string).
 * - `nonEmpty`: a `String` that is not blank (something other than whitespace), or a list with
 *   at least one element.
 */
export type ValidationRule =
  | { readonly rule: "length"; readonly min?: number; readonly max?: number }
  | { readonly rule: "size"; readonly min?: number; readonly max?: number }
  | { readonly rule: "min"; readonly value: number | string }
  | { readonly rule: "max"; readonly value: number | string }
  | { readonly rule: "email" }
  | { readonly rule: "url" }
  | { readonly rule: "regex"; readonly pattern: string; readonly flags?: string }
  | { readonly rule: "nonEmpty" };

/** Name of a validation rule (`length`, `min`, …), also the name of its decorator. */
export type ValidationRuleName = ValidationRule["rule"];

/** Validation-rule decorators, in the order the docs list them. */
export const VALIDATION_RULES = [
  "length",
  "size",
  "min",
  "max",
  "email",
  "url",
  "regex",
  "nonEmpty",
] as const satisfies readonly ValidationRuleName[];

/**
 * Keys of the positional arguments of each rule decorator (`@length(3, 20)` is
 * `@length(min: 3, max: 20)`). Kept in sync with the grammar.
 */
export const RULE_POSITIONAL_ARGS: Readonly<Record<string, readonly string[]>> = {
  length: ["min", "max"],
  size: ["min", "max"],
  min: ["value"],
  max: ["value"],
  regex: ["pattern", "flags"],
  email: [],
  url: [],
  nonEmpty: [],
};

/** Flags accepted by `@regex(pattern, flags)` (stateless JavaScript flags only). */
export const REGEX_FLAGS = "imsu";

/** Types that take `@min` / `@max`. */
const ORDERED_TYPES: readonly ScalarTypeName[] = ["Int", "Float", "BigInt", "DateTime", "Date"];

const BIGINT_MIN = -(2n ** 63n);
const BIGINT_MAX = 2n ** 63n - 1n;

/**
 * Practical email check (the one zod uses): `local@domain.tld`, no leading or double dots. Also
 * emitted by the zod generator.
 */
export const EMAIL_RE =
  /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function typeLabel(f: ScalarNodeField): string {
  const t = f.type.name === "Enum" ? (f.type.enum ?? "Enum") : f.type.name;
  return f.type.list ? `${t}[]` : t;
}

function show(v: DecoratorValue): string {
  return v.kind === "string"
    ? JSON.stringify(v.value)
    : String(v.kind === "number" ? (v.raw ?? v.value) : v.value);
}

/** Whether `name` is a validation-rule decorator. */
export function isRuleDecorator(name: string): name is ValidationRuleName {
  return (VALIDATION_RULES as readonly string[]).includes(name);
}

function nonNegativeInt(
  where: string,
  at: string,
  v: DecoratorValue | undefined,
): number | undefined {
  if (v === undefined) return undefined;
  if (v.kind !== "number" || !Number.isSafeInteger(v.value) || v.value < 0) {
    throw new SchemaValidationError(
      `${where}: ${at} must be a non-negative integer (got ${show(v)}).`,
    );
  }
  return v.value;
}

/** A `@min` / `@max` bound of a field of `type`, in its resolved form. */
function bound(
  where: string,
  at: string,
  type: ScalarTypeName,
  v: DecoratorValue | undefined,
): number | string {
  if (v === undefined) {
    throw new SchemaValidationError(`${where}: ${at} needs a value, e.g. ${at}(0).`);
  }
  if (type === "Int" || type === "Float") {
    if (
      v.kind !== "number" ||
      (type === "Int" && !Number.isInteger(v.value)) ||
      v.raw !== undefined
    ) {
      throw new SchemaValidationError(
        `${where}: ${at} value must be ${type === "Int" ? "a safe integer" : "a number"} (got ${show(v)}).`,
      );
    }
    return v.value;
  }
  if (type === "BigInt") {
    const digits = v.kind === "number" ? (v.raw ?? String(v.value)) : "";
    if (!/^-?[0-9]+$/.test(digits) || BigInt(digits) < BIGINT_MIN || BigInt(digits) > BIGINT_MAX) {
      throw new SchemaValidationError(
        `${where}: ${at} value must be a 64-bit integer (got ${show(v)}).`,
      );
    }
    return BigInt(digits).toString();
  }
  // DateTime / Date: ISO 8601 text.
  if (type === "Date") {
    if (
      v.kind !== "string" ||
      !ISO_DATE.test(v.value) ||
      Number.isNaN(Date.parse(`${v.value}T00:00:00Z`)) ||
      new Date(`${v.value}T00:00:00Z`).toISOString().slice(0, 10) !== v.value
    ) {
      throw new SchemaValidationError(
        `${where}: ${at} value must be an ISO 8601 date string, e.g. ${at}("2020-01-01") (got ${show(v)}).`,
      );
    }
    return v.value;
  }
  if (
    v.kind !== "string" ||
    !(ISO_DATE.test(v.value) || ISO_DATE_TIME.test(v.value)) ||
    Number.isNaN(Date.parse(v.value))
  ) {
    throw new SchemaValidationError(
      `${where}: ${at} value must be an ISO 8601 date-time string, e.g. ${at}("2020-01-01T00:00:00Z") (got ${show(v)}).`,
    );
  }
  return new Date(ISO_DATE.test(v.value) ? `${v.value}T00:00:00Z` : v.value).toISOString();
}

function compareBounds(type: ScalarTypeName, a: number | string, b: number | string): number {
  if (type === "BigInt") {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (type === "DateTime") return Date.parse(String(a)) - Date.parse(String(b));
  if (type === "Date") return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  return Number(a) - Number(b);
}

function onlyArgs(where: string, d: Decorator, keys: readonly string[]): void {
  const seen = new Set<string>();
  for (const a of d.args) {
    if (a.key === "") {
      throw new SchemaValidationError(
        `${where}: @${d.name} takes ${keys.length ? `at most ${keys.length} positional argument${keys.length === 1 ? "" : "s"} (${keys.join(", ")})` : "no arguments"}.`,
      );
    }
    if (!keys.includes(a.key)) {
      throw new SchemaValidationError(
        `${where}: unknown @${d.name} argument "${a.key}" (${keys.length ? `expected ${keys.join(", ")}` : "it takes none"}).`,
      );
    }
    if (seen.has(a.key))
      throw new SchemaValidationError(`${where}: @${d.name} ${a.key} given twice.`);
    seen.add(a.key);
  }
}

function arg(d: Decorator, key: string): DecoratorValue | undefined {
  return d.args.find((a) => a.key === key)?.value;
}

function notApplicable(where: string, d: Decorator, f: ScalarNodeField, expected: string): never {
  throw new SchemaValidationError(
    `${where}: @${d.name} is not valid on a ${typeLabel(f)} field (only on ${expected}).`,
  );
}

/**
 * Check the rule decorators of a scalar field (applicable to its type, known arguments of the
 * right type, `min` ≤ `max`, a regex that compiles, each rule once) and resolve them.
 *
 * @param owner - `Node "User"` / `Relationship "Follows"`, for messages.
 * @returns The rules in declaration order (empty when the field has none).
 * @throws {SchemaValidationError} When a rule decorator is invalid.
 */
export function resolveFieldRules(owner: string, f: ScalarNodeField): ValidationRule[] {
  const where = `${owner} field "${f.name}"`;
  const type = f.type.name;
  const list = Boolean(f.type.list);
  const isString = type === "String" && !list;
  const rules: ValidationRule[] = [];
  const seen = new Set<string>();
  for (const d of f.decorators) {
    if (!isRuleDecorator(d.name)) continue;
    if (seen.has(d.name)) {
      throw new SchemaValidationError(`${where}: at most one @${d.name} allowed.`);
    }
    seen.add(d.name);
    onlyArgs(where, d, RULE_POSITIONAL_ARGS[d.name] ?? []);
    switch (d.name) {
      case "length":
      case "size": {
        if (d.name === "length" && !isString) {
          notApplicable(
            where,
            d,
            f,
            list && type === "String"
              ? "String fields; use @size for the number of elements of a list"
              : "String fields",
          );
        }
        if (d.name === "size" && !list) notApplicable(where, d, f, "list fields");
        const min = nonNegativeInt(where, `@${d.name} min`, arg(d, "min"));
        const max = nonNegativeInt(where, `@${d.name} max`, arg(d, "max"));
        if (min === undefined && max === undefined) {
          throw new SchemaValidationError(
            `${where}: @${d.name} needs a min and/or a max, e.g. @${d.name}(1, 100) or @${d.name}(max: 100).`,
          );
        }
        if (min !== undefined && max !== undefined && min > max) {
          throw new SchemaValidationError(
            `${where}: @${d.name} min (${min}) is above max (${max}).`,
          );
        }
        rules.push({
          rule: d.name,
          ...(min !== undefined ? { min } : {}),
          ...(max !== undefined ? { max } : {}),
        });
        break;
      }
      case "min":
      case "max": {
        if (list || !ORDERED_TYPES.includes(type)) {
          notApplicable(where, d, f, `${ORDERED_TYPES.join(", ")} fields`);
        }
        rules.push({ rule: d.name, value: bound(where, `@${d.name}`, type, arg(d, "value")) });
        break;
      }
      case "email":
      case "url":
        if (!isString) notApplicable(where, d, f, "String fields");
        rules.push({ rule: d.name });
        break;
      case "regex": {
        if (!isString) notApplicable(where, d, f, "String fields");
        const pattern = arg(d, "pattern");
        const flags = arg(d, "flags");
        if (pattern?.kind !== "string") {
          throw new SchemaValidationError(
            `${where}: @regex needs a pattern string, e.g. @regex("^[a-z]+$").`,
          );
        }
        if (flags !== undefined) {
          if (
            flags.kind !== "string" ||
            [...flags.value].some(
              (c, i) => !REGEX_FLAGS.includes(c) || flags.value.indexOf(c) !== i,
            )
          ) {
            throw new SchemaValidationError(
              `${where}: @regex flags must be a string of distinct flags among "${REGEX_FLAGS}" (got ${show(flags)}).`,
            );
          }
        }
        try {
          new RegExp(pattern.value, flags?.kind === "string" ? flags.value : undefined);
        } catch (e) {
          throw new SchemaValidationError(
            `${where}: @regex pattern does not compile (${e instanceof Error ? e.message : String(e)}).`,
          );
        }
        rules.push({
          rule: "regex",
          pattern: pattern.value,
          ...(flags?.kind === "string" && flags.value ? { flags: flags.value } : {}),
        });
        break;
      }
      case "nonEmpty":
        if (!isString && !list) notApplicable(where, d, f, "String and list fields");
        rules.push({ rule: "nonEmpty" });
        break;
    }
  }
  const min = rules.find((r) => r.rule === "min");
  const max = rules.find((r) => r.rule === "max");
  if (min?.rule === "min" && max?.rule === "max" && compareBounds(type, min.value, max.value) > 0) {
    throw new SchemaValidationError(
      `${where}: @min (${String(min.value)}) is above @max (${String(max.value)}).`,
    );
  }
  return rules;
}

/** A rule a value breaks: the rule's name and a short message (`must be at least 3 characters`). */
export type RuleViolation = { readonly rule: ValidationRuleName; readonly message: string };

/** The field facts {@link checkRules} needs (a {@link ResolvedScalarField} has them). */
export type RuleField = {
  readonly type: ScalarTypeName;
  readonly list: boolean;
  readonly rules?: readonly ValidationRule[];
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** `value` as something comparable with a bound of `type`, or `undefined` when it has another type. */
function ordered(type: ScalarTypeName, value: unknown): number | bigint | string | undefined {
  switch (type) {
    case "Int":
    case "Float":
      if (typeof value === "number") return value;
      if (typeof value === "bigint" && type === "Int") return value;
      return undefined;
    case "BigInt":
      if (typeof value === "bigint") return value;
      if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
      return undefined;
    case "DateTime":
    case "Date": {
      const d = typeof value === "string" ? new Date(value) : value;
      if (!(d instanceof Date) || Number.isNaN(d.getTime())) return undefined;
      // A Date is stored as its UTC calendar date.
      return type === "Date" ? d.toISOString().slice(0, 10) : d.getTime();
    }
    default:
      return undefined;
  }
}

function boundOf(type: ScalarTypeName, b: number | string): number | bigint | string {
  if (type === "BigInt") return BigInt(b);
  if (type === "Int" && typeof b === "number") return b;
  if (type === "DateTime") return Date.parse(String(b));
  return b;
}

function below(a: number | bigint | string, b: number | bigint | string): boolean {
  if (typeof a === "bigint" || typeof b === "bigint") {
    return BigInt(a as number | bigint) < BigInt(b as number | bigint);
  }
  return a < b;
}

/**
 * The rules of `field` that `value` breaks (every one, in declaration order). `value` is the
 * value given to a write (a `string`, `number`, `bigint`, `Date`, array, …). A value of the wrong
 * type breaks no rule (the type check reports it), and `null` / `undefined` break none, except on
 * a list: an absent list reads as `[]`, so pass `[]` for it.
 */
export function checkRules(field: RuleField, value: unknown): RuleViolation[] {
  const out: RuleViolation[] = [];
  if (value === null || value === undefined) return out;
  for (const r of field.rules ?? []) {
    switch (r.rule) {
      case "length": {
        if (typeof value !== "string") break;
        const n = [...value].length;
        if (r.min !== undefined && n < r.min) {
          out.push({
            rule: "length",
            message: `must be at least ${plural(r.min, "character")} long (got ${n}).`,
          });
        } else if (r.max !== undefined && n > r.max) {
          out.push({
            rule: "length",
            message: `must be at most ${plural(r.max, "character")} long (got ${n}).`,
          });
        }
        break;
      }
      case "size": {
        if (!Array.isArray(value)) break;
        const n = value.length;
        if (r.min !== undefined && n < r.min) {
          out.push({
            rule: "size",
            message: `must have at least ${plural(r.min, "element")} (got ${n}).`,
          });
        } else if (r.max !== undefined && n > r.max) {
          out.push({
            rule: "size",
            message: `must have at most ${plural(r.max, "element")} (got ${n}).`,
          });
        }
        break;
      }
      case "min":
      case "max": {
        const v = ordered(field.type, value);
        if (v === undefined) break;
        const b = boundOf(field.type, r.value);
        const bad = r.rule === "min" ? below(v, b) : below(b, v);
        if (bad) {
          out.push({
            rule: r.rule,
            message: `must be ${r.rule === "min" ? "at least" : "at most"} ${String(r.value)}.`,
          });
        }
        break;
      }
      case "email":
        if (typeof value === "string" && !EMAIL_RE.test(value)) {
          out.push({ rule: "email", message: "must be an email address." });
        }
        break;
      case "url":
        if (typeof value === "string" && !isHttpUrl(value)) {
          out.push({ rule: "url", message: "must be an absolute http(s) URL." });
        }
        break;
      case "regex":
        if (typeof value === "string" && !new RegExp(r.pattern, r.flags).test(value)) {
          out.push({ rule: "regex", message: `must match /${r.pattern}/${r.flags ?? ""}.` });
        }
        break;
      case "nonEmpty":
        if (
          typeof value === "string"
            ? value.trim() === ""
            : Array.isArray(value) && value.length === 0
        ) {
          out.push({
            rule: "nonEmpty",
            message:
              typeof value === "string" ? "must not be empty or blank." : "must not be empty.",
          });
        }
        break;
    }
  }
  return out;
}

function isHttpUrl(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
}

/** Whether an absent (or `null`) value of a list field breaks its rules (it reads as `[]`). */
export function listRequiresElements(field: RuleField): boolean {
  return (
    field.list &&
    (field.rules ?? []).some(
      (r) => r.rule === "nonEmpty" || (r.rule === "size" && (r.min ?? 0) > 0),
    )
  );
}

/** A rule as `.cyphra` decorator text (`@length(3, 20)`, `@regex("^a", "i")`), for listings and docs. */
export function formatRule(r: ValidationRule): string {
  switch (r.rule) {
    case "length":
    case "size":
      return r.min !== undefined
        ? `@${r.rule}(${r.min}${r.max !== undefined ? `, ${r.max}` : ""})`
        : `@${r.rule}(max: ${r.max})`;
    case "min":
    case "max":
      return `@${r.rule}(${typeof r.value === "string" && !/^-?\d+$/.test(r.value) ? JSON.stringify(r.value) : r.value})`;
    case "regex":
      return `@regex(${quoteSchemaString(r.pattern)}${r.flags ? `, ${quoteSchemaString(r.flags)}` : ""})`;
    default:
      return `@${r.rule}`;
  }
}

/**
 * Reject a positional argument the grammar could not name (`@relationship("X")`, `@length(1, 2, 3)`
 * is caught by {@link resolveFieldRules}): only rule decorators take positional arguments.
 */
export function assertNamedArgs(where: string, decorators: readonly Decorator[]): void {
  for (const d of decorators) {
    if (isRuleDecorator(d.name) || d.name === "default") continue;
    if (d.args.some((a) => a.key === "")) {
      throw new SchemaValidationError(
        d.name === "out" || d.name === "in"
          ? `${where}: @${d.name} takes the type, then named arguments only: @${d.name}(TYPE, onDelete: Cascade).`
          : `${where}: @${d.name} takes named arguments only (key: value).`,
      );
    }
  }
}
