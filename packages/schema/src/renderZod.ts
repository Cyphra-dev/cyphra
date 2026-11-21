/**
 * The zod generator: a `cyphra.zod.ts` module with a zod schema per model (its full properties,
 * its create input and its update input), per relationship model (edge properties) and per enum.
 *
 * The schemas check what the runtime checks on a write: the field types (temporal ISO text, points,
 * vector dimensions, the 64-bit range of `BigInt`, …) and the validation rules (`@length`, `@min`,
 * `@email`, …), with the same semantics (see {@link checkRules}). The generated code only uses the
 * API common to zod 3 and zod 4.
 *
 * @packageDocumentation
 */

import type { SchemaDocument } from "./ast.js";
import { resolveSchema, type ResolvedScalarField, type SchemaModel } from "./model.js";
import { EMAIL_RE, listRequiresElements, type ValidationRule } from "./rules.js";
import {
  DURATION_RE,
  LOCAL_DATE_TIME_RE,
  LOCAL_TIME_RE,
  TEMPORAL_EXAMPLES,
  TIME_RE,
} from "./temporal.js";

/** Options for {@link renderZodSource}. */
export type RenderZodOptions = {
  /** Module the generated file imports `z` from (default `"zod"`; `"zod/v4"` with zod 3.25). */
  readonly zodImport?: string;
  /**
   * Accept API-style input text for the types JSON has no value for: ISO 8601 strings for
   * `DateTime` / `Date` (turned into a `Date`, as the runtime does) and decimal strings or safe
   * integers for `BigInt` (turned into a `bigint`). Default `false`: only `Date` and `bigint` values.
   */
  readonly coerce?: boolean;
};

/** Helpers a generated module may need, emitted once and only when used. */
type Helper =
  | "codePoints"
  | "email"
  | "httpUrl"
  | "localDateTime"
  | "localTime"
  | "time"
  | "duration"
  | "clock"
  | "json"
  | "point"
  | "cartesianPoint"
  | "toDate"
  | "toBigInt";

const BIGINT_MIN = "-9223372036854775808";
const BIGINT_MAX = "9223372036854775807";

function re(r: RegExp): string {
  return `new RegExp(${JSON.stringify(r.source)}${r.flags ? `, ${JSON.stringify(r.flags)}` : ""})`;
}

function helperSource(h: Helper): string[] {
  switch (h) {
    case "codePoints":
      return [
        "/** Number of characters (Unicode code points) of `s`, as `@length` counts them. */",
        "const cyphraCodePoints = (s: string): number => Array.from(s).length;",
      ];
    case "email":
      return [
        "/** `@email`: `local@domain.tld`, no leading or double dots. */",
        `const cyphraEmail = ${re(EMAIL_RE)};`,
      ];
    case "httpUrl":
      return [
        "/** `@url`: an absolute `http:` / `https:` URL with a host. */",
        "function cyphraHttpUrl(s: string): boolean {",
        "  let u: URL;",
        "  try {",
        "    u = new URL(s);",
        "  } catch {",
        "    return false;",
        "  }",
        '  return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";',
        "}",
      ];
    case "clock":
      return [
        "/** Whether the hour, minute and second groups of `m` from `at` are in range. */",
        "function cyphraClock(m: RegExpExecArray, at: number): boolean {",
        "  const second = m[at + 2];",
        "  return Number(m[at]) <= 23 && Number(m[at + 1]) <= 59 && (second === undefined || Number(second) <= 59);",
        "}",
      ];
    case "localTime":
      return [
        `const cyphraLocalTimeRe = ${re(LOCAL_TIME_RE)};`,
        "/** `LocalTime` ISO 8601 text (`10:30:00`). */",
        "export type CyphraLocalTime = `${number}:${number}${string}`;",
        "function cyphraIsLocalTime(s: unknown): s is CyphraLocalTime {",
        '  const m = typeof s === "string" ? cyphraLocalTimeRe.exec(s) : null;',
        "  return m !== null && cyphraClock(m, 1);",
        "}",
      ];
    case "time":
      return [
        `const cyphraTimeRe = ${re(TIME_RE)};`,
        "/** `Time` ISO 8601 text with its UTC offset (`10:30:00+02:00`, `10:30:00Z`). */",
        "export type CyphraTime = `${number}:${number}${string}`;",
        "function cyphraIsTime(s: unknown): s is CyphraTime {",
        '  const m = typeof s === "string" ? cyphraTimeRe.exec(s) : null;',
        "  if (m === null || !cyphraClock(m, 1)) return false;",
        '  const off = m[5] ?? "";',
        '  if (off === "Z" || off === "z") return true;',
        '  const digits = off.slice(1).replace(/:/g, "");',
        '  const min = Number(digits.slice(2, 4) || "0");',
        '  const sec = Number(digits.slice(4, 6) || "0");',
        "  return min <= 59 && sec <= 59 && Number(digits.slice(0, 2)) * 3600 + min * 60 + sec <= 18 * 3600;",
        "}",
      ];
    case "localDateTime":
      return [
        `const cyphraLocalDateTimeRe = ${re(LOCAL_DATE_TIME_RE)};`,
        "/** `LocalDateTime` ISO 8601 text (`2024-05-01T10:30:00`), an existing calendar day. */",
        "export type CyphraLocalDateTime = `${number}-${number}-${number}T${number}:${number}${string}`;",
        "function cyphraIsLocalDateTime(s: unknown): s is CyphraLocalDateTime {",
        '  const m = typeof s === "string" ? cyphraLocalDateTimeRe.exec(s) : null;',
        "  if (m === null) return false;",
        "  const year = Number(m[1]);",
        "  const month = Number(m[2]);",
        "  const day = Number(m[3]);",
        "  if (month < 1 || month > 12 || day < 1) return false;",
        "  // Date.UTC reads years 0-99 as 1900-1999: count the days of the month in a shifted year.",
        "  const probe = year >= 0 && year < 100 ? year + 400 : year;",
        "  return day <= (new Date(Date.UTC(probe, month, 0)).getUTCDate() || 31) && cyphraClock(m, 4);",
        "}",
      ];
    case "duration":
      return [
        `const cyphraDurationRe = ${re(DURATION_RE)};`,
        "/** `Duration` ISO 8601 text (`P1DT2H30M`). */",
        "export type CyphraDuration = `P${string}` | `-P${string}`;",
        "function cyphraIsDuration(s: unknown): s is CyphraDuration {",
        '  const m = typeof s === "string" ? cyphraDurationRe.exec(s) : null;',
        '  return m !== null && m.slice(2, 9).some((x) => x !== undefined) && !m[0].endsWith("T");',
        "}",
      ];
    case "json":
      return [
        "/** A JSON value (a `Json` field). */",
        "export type CyphraJsonValue =",
        "  | string",
        "  | number",
        "  | boolean",
        "  | null",
        "  | CyphraJsonValue[]",
        "  | { [key: string]: CyphraJsonValue };",
        "/** Schema of a JSON value. */",
        "export const CyphraJsonValueSchema: z.ZodType<CyphraJsonValue> = z.lazy(() =>",
        "  z.union([z.null(), CyphraJsonFieldSchema]),",
        ");",
        "/** Schema of the value of a `Json` field: a JSON value other than `null` (no value). */",
        "export const CyphraJsonFieldSchema = z.union([",
        "  z.string(),",
        "  z.number(),",
        "  z.boolean(),",
        "  z.array(CyphraJsonValueSchema),",
        "  z.record(z.string(), CyphraJsonValueSchema),",
        "]);",
      ];
    case "point":
      return [
        "/** A WGS-84 `Point`: `{ longitude, latitude, height? }` (degrees, metres). */",
        "export const CyphraPointSchema = z",
        "  .object({",
        "    longitude: z.number().finite().min(-180).max(180),",
        "    latitude: z.number().finite().min(-90).max(90),",
        "    height: z.number().finite().optional(),",
        "  })",
        "  .strict();",
      ];
    case "cartesianPoint":
      return [
        "/** A `CartesianPoint`: `{ x, y, z? }`. */",
        "export const CyphraCartesianPointSchema = z",
        "  .object({",
        "    x: z.number().finite(),",
        "    y: z.number().finite(),",
        "    z: z.number().finite().optional(),",
        "  })",
        "  .strict();",
      ];
    case "toDate":
      return [
        "/** ISO 8601 text as a `Date` (as the runtime reads it); other values as they are. */",
        'const cyphraToDate = (v: unknown): unknown => (typeof v === "string" ? new Date(v) : v);',
      ];
    case "toBigInt":
      return [
        "/** Decimal digits or a safe integer as a `bigint`; other values as they are. */",
        "const cyphraToBigInt = (v: unknown): unknown =>",
        '  (typeof v === "string" && /^-?[0-9]+$/.test(v)) ||',
        '  (typeof v === "number" && Number.isSafeInteger(v))',
        "    ? BigInt(v)",
        "    : v;",
      ];
  }
}

/** Order in which helpers are emitted (dependencies first). */
const HELPER_ORDER: readonly Helper[] = [
  "codePoints",
  "email",
  "httpUrl",
  "clock",
  "localTime",
  "time",
  "localDateTime",
  "duration",
  "json",
  "point",
  "cartesianPoint",
  "toDate",
  "toBigInt",
];

function msg(text: string): string {
  return `{ message: ${JSON.stringify(text)} }`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

class ZodWriter {
  readonly helpers = new Set<Helper>();

  constructor(private readonly coerce: boolean) {}

  private use(h: Helper): void {
    this.helpers.add(h);
    if (h === "localTime" || h === "time" || h === "localDateTime") this.helpers.add("clock");
  }

  /** The schema of one value of `f` (an element, for a list), its rules included. */
  private element(f: ResolvedScalarField): string {
    const rules = f.list ? [] : (f.rules ?? []);
    // zod 3: `.regex()`, `.min()`, … are only on the base schema, so they come before `.refine()`.
    const checks: string[] = [];
    const refines: string[] = [];
    const ruleOf = <K extends ValidationRule["rule"]>(k: K) =>
      rules.find((r): r is Extract<ValidationRule, { rule: K }> => r.rule === k);
    switch (f.type) {
      case "String": {
        for (const r of rules) {
          switch (r.rule) {
            case "length":
              this.use("codePoints");
              if (r.min !== undefined) {
                refines.push(
                  `.refine((s) => cyphraCodePoints(s) >= ${r.min}, ${msg(`must be at least ${plural(r.min, "character")} long.`)})`,
                );
              }
              if (r.max !== undefined) {
                refines.push(
                  `.refine((s) => cyphraCodePoints(s) <= ${r.max}, ${msg(`must be at most ${plural(r.max, "character")} long.`)})`,
                );
              }
              break;
            case "email":
              this.use("email");
              checks.push(`.regex(cyphraEmail, ${msg("must be an email address.")})`);
              break;
            case "url":
              this.use("httpUrl");
              refines.push(`.refine(cyphraHttpUrl, ${msg("must be an absolute http(s) URL.")})`);
              break;
            case "regex":
              checks.push(
                `.regex(new RegExp(${JSON.stringify(r.pattern)}${r.flags ? `, ${JSON.stringify(r.flags)}` : ""}), ${msg(`must match /${r.pattern}/${r.flags ?? ""}.`)})`,
              );
              break;
            case "nonEmpty":
              refines.push(
                `.refine((s) => s.trim() !== "", ${msg("must not be empty or blank.")})`,
              );
              break;
            default:
              break;
          }
        }
        return `z.string()${checks.join("")}${refines.join("")}`;
      }
      case "Enum":
        return `${f.enum}Schema`;
      case "Boolean":
        return "z.boolean()";
      case "Int":
      case "Float": {
        for (const k of ["min", "max"] as const) {
          const r = ruleOf(k);
          if (r) {
            checks.push(
              `.${k}(${String(r.value)}, ${msg(`must be ${k === "min" ? "at least" : "at most"} ${String(r.value)}.`)})`,
            );
          }
        }
        return `z.number()${f.type === "Int" ? ".int()" : ""}${checks.join("")}`;
      }
      case "BigInt": {
        for (const k of ["min", "max"] as const) {
          const r = ruleOf(k);
          const value = r ? String(r.value) : k === "min" ? BIGINT_MIN : BIGINT_MAX;
          const text = r
            ? `must be ${k === "min" ? "at least" : "at most"} ${value}.`
            : "must be a 64-bit integer (-2^63 to 2^63-1).";
          checks.push(`.${k}(BigInt(${JSON.stringify(value)}), ${msg(text)})`);
        }
        const base = `z.bigint()${checks.join("")}`;
        if (!this.coerce) return base;
        this.use("toBigInt");
        return `z.preprocess(cyphraToBigInt, ${base})`;
      }
      case "DateTime":
      case "Date": {
        for (const k of ["min", "max"] as const) {
          const r = ruleOf(k);
          if (!r) continue;
          const text = msg(`must be ${k === "min" ? "at least" : "at most"} ${String(r.value)}.`);
          if (f.type === "DateTime") {
            checks.push(`.${k}(new Date(${JSON.stringify(r.value)}), ${text})`);
          } else {
            // A Date is stored as its UTC calendar day: compare days, not instants.
            refines.push(
              `.refine((d) => d.toISOString().slice(0, 10) ${k === "min" ? ">=" : "<="} ${JSON.stringify(r.value)}, ${text})`,
            );
          }
        }
        const base = `z.date()${checks.join("")}${refines.join("")}`;
        if (!this.coerce) return base;
        this.use("toDate");
        return `z.preprocess(cyphraToDate, ${base})`;
      }
      case "Json":
        this.use("json");
        return "CyphraJsonFieldSchema";
      case "LocalDateTime":
      case "LocalTime":
      case "Time":
      case "Duration": {
        const h = (
          {
            LocalDateTime: "localDateTime",
            LocalTime: "localTime",
            Time: "time",
            Duration: "duration",
          } as const
        )[f.type];
        this.use(h);
        return `z.custom<Cyphra${f.type}>(cyphraIs${f.type}, ${msg(`must be a ${f.type} as ISO 8601 text (e.g. "${TEMPORAL_EXAMPLES[f.type]}").`)})`;
      }
      case "Point":
        this.use("point");
        return "CyphraPointSchema";
      case "CartesianPoint":
        this.use("cartesianPoint");
        return "CyphraCartesianPointSchema";
      case "Vector":
        return `z.array(z.number().finite()).length(${f.dimensions ?? 0}, ${msg(`must have ${plural(f.dimensions ?? 0, "dimension")}.`)})`;
    }
  }

  /** The schema of a value of `f`, without `null` / absence: a list wraps its element. */
  field(f: ResolvedScalarField): string {
    const el = this.element(f);
    if (!f.list || f.type === "Vector") return el;
    const checks: string[] = [];
    for (const r of f.rules ?? []) {
      if (r.rule === "size") {
        if (r.min !== undefined) {
          checks.push(`.min(${r.min}, ${msg(`must have at least ${plural(r.min, "element")}.`)})`);
        }
        if (r.max !== undefined) {
          checks.push(`.max(${r.max}, ${msg(`must have at most ${plural(r.max, "element")}.`)})`);
        }
      } else if (r.rule === "nonEmpty") {
        checks.push(`.min(1, ${msg("must not be empty.")})`);
      }
    }
    return `z.array(${el})${checks.join("")}`;
  }
}

type Mode = "output" | "create" | "update";

/**
 * How a field reads in a schema: as stored and returned (`output`: an optional field may be `null`,
 * a list is always an array), as `create` data (a field with a default, an optional field or a list
 * may be left out) or as `update` data (every field may be left out).
 */
function presence(f: ResolvedScalarField, mode: Mode): string {
  // An absent list reads as `[]`: it may be left out of a create unless its rules need elements.
  // (The runtime also takes `null` for "no elements"; the client's types do not.)
  if (f.list) {
    if (mode === "output") return "";
    return mode === "create" && listRequiresElements(f) ? "" : ".optional()";
  }
  if (f.optional) return mode === "output" ? ".nullable()" : ".nullish()";
  if (mode === "update" || (mode === "create" && f.default)) return ".optional()";
  return "";
}

function key(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function renderObject(
  name: string,
  fields: readonly ResolvedScalarField[],
  base: string,
  mode: Mode,
  doc: string,
): string[] {
  const lines = [`/** ${doc} */`];
  if (fields.length === 0) {
    lines.push(`export const ${name} = z.object({});`, "");
    return lines;
  }
  lines.push(`export const ${name} = z.object({`);
  for (const f of fields) {
    const access = key(f.name) === f.name ? `.${f.name}` : `[${JSON.stringify(f.name)}]`;
    lines.push(`  ${key(f.name)}: ${base}${access}${presence(f, mode)},`);
  }
  lines.push("});", "");
  return lines;
}

function renderModel(
  w: ZodWriter,
  name: string,
  fields: readonly ResolvedScalarField[],
  what: string,
): string[] {
  const base = `${name}Fields`;
  const lines: string[] = [];
  if (fields.length > 0) {
    lines.push(`const ${base} = {`);
    for (const f of fields) lines.push(`  ${key(f.name)}: ${w.field(f)},`);
    lines.push("};", "");
  }
  lines.push(
    ...renderObject(
      `${name}Schema`,
      fields,
      base,
      "output",
      `${what}, as the client returns them.`,
    ),
    ...renderObject(
      `${name}CreateInputSchema`,
      fields,
      base,
      "create",
      `${what} accepted by a create (fields with a default, optional fields and lists may be left out).`,
    ),
    ...renderObject(
      `${name}UpdateInputSchema`,
      fields,
      base,
      "update",
      `${what} accepted by an update (every field may be left out).`,
    ),
  );
  return lines;
}

/**
 * Render a `cyphra.zod.ts` module from a resolved schema model: for each node model `User`,
 * `UserSchema`, `UserCreateInputSchema` and `UserUpdateInputSchema` (scalar fields only: relation
 * fields are left out), the same three for each relationship model (its edge properties), and
 * `RoleSchema` (`z.enum([...])`) for each enum.
 */
export function renderZodFromModel(model: SchemaModel, options: RenderZodOptions = {}): string {
  const w = new ZodWriter(options.coerce ?? false);
  const body: string[] = [];
  for (const e of model.enums ?? []) {
    body.push(`/** \`${e.name}\` enum values. */`);
    body.push(
      `export const ${e.name}Schema = z.enum([${e.values.map((v) => JSON.stringify(v)).join(", ")}]);`,
      "",
    );
  }
  for (const n of model.nodes) {
    const scalars = n.fields.filter((f): f is ResolvedScalarField => f.kind === "scalar");
    body.push(...renderModel(w, n.name, scalars, `\`${n.name}\` node properties`));
  }
  for (const r of model.relationships) {
    body.push(
      ...renderModel(w, r.name, r.properties, `\`${r.name}\` (\`:${r.relType}\`) edge properties`),
    );
  }

  const lines = [
    "/**",
    " * Generated by `cyphra generate` — do not edit by hand.",
    " *",
    " * Zod schemas of the schema's models: `<Model>Schema` (the properties the client returns),",
    " * `<Model>CreateInputSchema` and `<Model>UpdateInputSchema` (scalar data of a write), with the",
    " * schema's validation rules.",
    ...(options.coerce
      ? [" * Coercing: ISO 8601 strings are read as `Date`s and decimal strings as `bigint`s."]
      : []),
    " */",
    "",
    `import { z } from ${JSON.stringify(options.zodImport ?? "zod")};`,
    "",
  ];
  for (const h of HELPER_ORDER) {
    if (w.helpers.has(h)) lines.push(...helperSource(h), "");
  }
  lines.push(...body);
  return lines.join("\n");
}

/**
 * Render a `cyphra.zod.ts` module (zod schemas of the models, see {@link renderZodFromModel}).
 *
 * @param doc - Parsed and validated schema.
 */
export function renderZodSource(doc: SchemaDocument, options: RenderZodOptions = {}): string {
  return renderZodFromModel(resolveSchema(doc), options);
}
