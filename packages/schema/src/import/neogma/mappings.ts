/**
 * The mapping from neogma property schemas to Cyphra fields, in one place.
 *
 * A property schema is a TypeBox schema (`Type.String({ minLength: 1 })`, neogma 2) or a
 * revalidator object (`{ type: 'string', required: true, minLength: 1 }`, neogma 1). Both are read
 * into one {@link Shape} (a base type and its JSON Schema keywords), and {@link shapeToField} turns
 * a shape into a Cyphra type and decorators. Supporting a new keyword means one entry here.
 *
 * @packageDocumentation
 */

import type { Decorator, DecoratorValue, ScalarTypeName, ScalarTypeRef } from "../../ast.js";
import type { ImportSeverity, IssueDraft } from "../print.js";
import type { NeogmaAnnotation, NeogmaValue } from "./parse.js";

export function issue(severity: ImportSeverity, feature: string, message: string): IssueDraft {
  return { severity, feature, message };
}

/** JSON Schema keywords of a schema, by name. */
export type Keywords = ReadonlyMap<string, NeogmaValue>;

/** A property schema, read from TypeBox or revalidator. */
export type Shape =
  | {
      readonly kind: "scalar";
      readonly type: "String" | "Float" | "Int" | "Boolean" | "BigInt";
      readonly keywords: Keywords;
    }
  | { readonly kind: "enum"; readonly values: readonly NeogmaValue[]; readonly keywords: Keywords }
  | { readonly kind: "list"; readonly item: Shape; readonly keywords: Keywords }
  /** Objects, records and tuples: kept as one JSON value. */
  | { readonly kind: "json"; readonly what: string }
  /** No type information (`Type.Any()`, a bare `@Property()`, revalidator without `type`). */
  | { readonly kind: "any" }
  | { readonly kind: "unsupported"; readonly feature: string; readonly message: string };

/** A shape with its optionality and the issues found while reading it. */
export type Described = {
  readonly shape: Shape;
  readonly optional: boolean;
  readonly issues: readonly IssueDraft[];
};

const NO_KEYWORDS: Keywords = new Map();

const CUSTOM_VALIDATOR = (feature: string) =>
  issue(
    "unsupported",
    feature,
    "custom validator: not converted; check the value in a query hook (db.$extends({ query }))",
  );

function keywordsOf(v: NeogmaValue | undefined): Keywords {
  return v?.kind === "object" ? v.entries : NO_KEYWORDS;
}

function isEmpty(v: NeogmaValue): boolean {
  return v.kind === "call" && (v.callee === "Null" || v.callee === "Undefined");
}

/** Read a property schema (TypeBox call or revalidator object). Absent: no schema at all. */
export function describeSchema(v: NeogmaValue | undefined): Described {
  if (v === undefined) return { shape: { kind: "any" }, optional: false, issues: [] };
  if (v.kind === "object") return describeRevalidator(v.entries);
  if (v.kind === "call") return describeTypeBox(v);
  if (v.kind === "ref") {
    return {
      shape: {
        kind: "unsupported",
        feature: "schema",
        message: `the schema ${v.name} could not be read statically (not a constant of the imported files): not converted`,
      },
      optional: false,
      issues: [],
    };
  }
  return {
    shape: {
      kind: "unsupported",
      feature: "schema",
      message: "the schema could not be read statically: not converted",
    },
    optional: false,
    issues: [],
  };
}

const TYPEBOX_SCALARS: Readonly<Record<string, "String" | "Float" | "Int" | "Boolean" | "BigInt">> =
  {
    String: "String",
    Number: "Float",
    Integer: "Int",
    Boolean: "Boolean",
    BigInt: "BigInt",
  };

const TYPEBOX_JSON = new Set(["Object", "Record", "Tuple", "Partial", "Required", "Intersect"]);

function describeTypeBox(v: Extract<NeogmaValue, { kind: "call" }>): Described {
  const issues: IssueDraft[] = [];
  let optional = false;
  const read = (c: NeogmaValue | undefined): Shape => {
    if (c?.kind !== "call") {
      const d = describeSchema(c);
      issues.push(...d.issues);
      if (d.optional) optional = true;
      return d.shape;
    }
    const a = c.args;
    switch (c.callee) {
      case "Optional":
        optional = true;
        return read(a[0]);
      case "Refine":
        issues.push(CUSTOM_VALIDATOR("Type.Refine"));
        return read(a[0]);
      case "Union": {
        const members = a[0]?.kind === "array" ? a[0].items : [];
        const rest = members.filter((m) => {
          if (isEmpty(m)) optional = true;
          return !isEmpty(m);
        });
        if (rest.length === 1) return read(rest[0]);
        if (rest.length > 0 && rest.every((m) => m.kind === "call" && m.callee === "Literal")) {
          return {
            kind: "enum",
            values: rest.map((m) => (m as Extract<NeogmaValue, { kind: "call" }>).args[0]!),
            keywords: keywordsOf(a[1]),
          };
        }
        return {
          kind: "unsupported",
          feature: "Type.Union",
          message:
            "a union of different types is not converted (Cyphra fields have one type); pick one, or use Json",
        };
      }
      case "Literal":
        return { kind: "enum", values: a[0] ? [a[0]] : [], keywords: keywordsOf(a[1]) };
      case "Enum":
        if (a[0]?.kind === "array") {
          return { kind: "enum", values: a[0].items, keywords: keywordsOf(a[1]) };
        }
        return {
          kind: "unsupported",
          feature: "Type.Enum",
          message:
            "an enum given as a TypeScript enum is not converted: list its values in a Cyphra enum",
        };
      case "Array": {
        const item = describeTypeBox(
          a[0]?.kind === "call" ? a[0] : { kind: "call", callee: "Any", args: [] },
        );
        issues.push(...item.issues);
        return { kind: "list", item: item.shape, keywords: keywordsOf(a[1]) };
      }
      case "Any":
      case "Unknown":
        return { kind: "any" };
    }
    const scalar = TYPEBOX_SCALARS[c.callee];
    if (scalar) return { kind: "scalar", type: scalar, keywords: keywordsOf(a[0]) };
    if (TYPEBOX_JSON.has(c.callee)) return { kind: "json", what: `Type.${c.callee}` };
    return {
      kind: "unsupported",
      feature: c.object ? `${c.object}.${c.callee}` : `${c.callee}()`,
      message: "this schema type is not converted",
    };
  };
  const shape = read(v);
  return { shape, optional, issues };
}

const REVALIDATOR_SCALARS: Readonly<
  Record<string, "String" | "Float" | "Int" | "Boolean" | "BigInt">
> = {
  string: "String",
  number: "Float",
  integer: "Int",
  boolean: "Boolean",
};

/** Keywords of a revalidator schema that are not validation keywords of the value itself. */
const REVALIDATOR_STRUCTURE = new Set(["type", "required", "enum", "items", "conform"]);

function describeRevalidator(entries: Keywords): Described {
  const issues: IssueDraft[] = [];
  const required = entries.get("required");
  // revalidator properties are optional unless `required: true`.
  let optional = !(required?.kind === "boolean" && required.value);
  const keywords = new Map([...entries].filter(([k]) => !REVALIDATOR_STRUCTURE.has(k)));
  if (entries.has("conform")) issues.push(CUSTOM_VALIDATOR("conform"));
  const typeValue = entries.get("type");
  let types: string[] = [];
  if (typeValue?.kind === "string") types = [typeValue.value];
  else if (typeValue?.kind === "array") {
    types = typeValue.items.flatMap((t) => (t.kind === "string" ? [t.value] : []));
  }
  if (types.includes("null")) {
    optional = true;
    types = types.filter((t) => t !== "null");
  }
  const enumValue = entries.get("enum");
  if (enumValue?.kind === "array") {
    return { shape: { kind: "enum", values: enumValue.items, keywords }, optional, issues };
  }
  if (types.length > 1) {
    return {
      shape: {
        kind: "unsupported",
        feature: "type",
        message: `a value of several types (${types.join(", ")}) is not converted (Cyphra fields have one type)`,
      },
      optional,
      issues,
    };
  }
  const t = types[0];
  if (t === undefined || t === "any") return { shape: { kind: "any" }, optional, issues };
  const scalar = REVALIDATOR_SCALARS[t];
  if (scalar) return { shape: { kind: "scalar", type: scalar, keywords }, optional, issues };
  if (t === "array") {
    const items = entries.get("items");
    const item =
      items?.kind === "object"
        ? describeRevalidator(new Map([...items.entries, ["required", TRUE]]))
        : { shape: { kind: "any" } as Shape, optional: false, issues: [] };
    issues.push(...item.issues);
    return { shape: { kind: "list", item: item.shape, keywords }, optional, issues };
  }
  if (t === "object") return { shape: { kind: "json", what: "type: 'object'" }, optional, issues };
  return {
    shape: { kind: "unsupported", feature: "type", message: `type '${t}' is not converted` },
    optional,
    issues,
  };
}

const TRUE: NeogmaValue = { kind: "boolean", value: true };

// ---------------------------------------------------------------------------------------------
// Shape to Cyphra field
// ---------------------------------------------------------------------------------------------

/** Keywords without an effect on the data: dropped silently. */
const SILENT = new Set([
  "title",
  "description",
  "$id",
  "$comment",
  "examples",
  "readOnly",
  "writeOnly",
  "deprecated",
]);

/** Keywords for custom error messages: listed as ignored. */
const MESSAGES = new Set(["messages", "errorMessage"]);

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** Neo4j date-time strings and what they become. */
const DATE_FORMATS: Readonly<Record<string, { type: ScalarTypeName; fn: string; what: string }>> = {
  "date-time": { type: "DateTime", fn: "datetime", what: "DATETIME" },
  date: { type: "Date", fn: "date", what: "DATE" },
};

/** Valid Cyphra identifier (node, field and enum value names). */
export const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What a property becomes. */
export type FieldMapping =
  | {
      readonly type: ScalarTypeRef;
      readonly decorators: readonly Decorator[];
      readonly issues: readonly IssueDraft[];
      /** Values of a new enum to declare (the caller names it and sets `type.enum`). */
      readonly enumValues?: readonly string[];
    }
  | { readonly unsupported: IssueDraft; readonly issues: readonly IssueDraft[] };

function num(n: number): DecoratorValue {
  return { kind: "number", value: n };
}

function rangeDecorator(name: string, min: number | undefined, max: number | undefined) {
  const args = [];
  if (min !== undefined) args.push({ key: "min", value: num(min) });
  if (max !== undefined) args.push({ key: "max", value: num(max) });
  return { name, args };
}

function numberKeyword(k: Keywords, key: string): number | undefined {
  const v = k.get(key);
  return v?.kind === "number" ? v.value : undefined;
}

function show(v: NeogmaValue): string {
  switch (v.kind) {
    case "string":
      return JSON.stringify(v.value);
    case "number":
    case "boolean":
      return String(v.value);
    case "null":
      return "null";
    case "regex":
      return `/${v.pattern}/${v.flags}`;
    case "ref":
      return v.name;
    case "other":
      return v.text;
    default:
      return v.kind;
  }
}

/** The TypeScript annotation as a shape, when there is no schema. */
function annotationShape(a: NeogmaAnnotation | undefined): Shape | undefined {
  if (!a) return undefined;
  const base: Record<string, "String" | "Float" | "Boolean" | "BigInt"> = {
    string: "String",
    number: "Float",
    boolean: "Boolean",
    bigint: "BigInt",
  };
  const t = base[a.type];
  if (!t) return undefined;
  const scalar: Shape = { kind: "scalar", type: t, keywords: NO_KEYWORDS };
  return a.list ? { kind: "list", item: scalar, keywords: NO_KEYWORDS } : scalar;
}

/**
 * Turn a described property schema into a Cyphra type and decorators (rules and default).
 *
 * @param annotation - The field's TypeScript annotation, used when the schema says nothing.
 */
export function shapeToField(d: Described, annotation?: NeogmaAnnotation): FieldMapping {
  const issues: IssueDraft[] = [...d.issues];
  let shape = d.shape;
  let optional = d.optional;
  if (shape.kind === "any") {
    const fromAnnotation = annotationShape(annotation);
    if (!fromAnnotation) {
      return {
        unsupported: issue(
          "unsupported",
          "type",
          annotation
            ? `no schema, and the type ${annotation.type} has no Cyphra equivalent: not converted`
            : "no schema and no type annotation: not converted; add the field with its type",
        ),
        issues,
      };
    }
    shape = fromAnnotation;
    optional = optional || !!annotation?.optional;
  }
  if (shape.kind === "unsupported") {
    return { unsupported: issue("unsupported", shape.feature, shape.message), issues };
  }
  if (shape.kind === "json") {
    issues.push(
      issue(
        "changed",
        shape.what,
        "an object became a Json field (one JSON text property): its keys are not typed or validated by Cyphra",
      ),
    );
    return { type: { name: "Json", optional }, decorators: [], issues };
  }
  if (shape.kind === "list") {
    if (shape.item.kind === "list" || shape.item.kind === "json") {
      issues.push(
        issue(
          "changed",
          "Type.Array",
          "a list of lists or objects became a Json field (Neo4j lists hold scalars only)",
        ),
      );
      return { type: { name: "Json", optional }, decorators: [], issues };
    }
    const item = shapeToField(
      { shape: shape.item, optional: false, issues: [] },
      annotation && { ...annotation, list: false },
    );
    if ("unsupported" in item) return { unsupported: item.unsupported, issues: [...issues] };
    if (item.decorators.some((x) => x.name !== "default")) {
      issues.push(
        issue(
          "unsupported",
          "items",
          `rules on the list elements (${item.decorators.map((x) => `@${x.name}`).join(", ")}) are not converted: Cyphra rules check a list's size, not its elements`,
        ),
      );
    }
    issues.push(...item.issues);
    if (optional) {
      issues.push(
        issue(
          "changed",
          "Optional",
          "an optional list became a list: Cyphra lists are never optional, an absent list reads as []",
        ),
      );
    }
    const decorators: Decorator[] = [];
    const min = numberKeyword(shape.keywords, "minItems");
    const max = numberKeyword(shape.keywords, "maxItems");
    if (min !== undefined || max !== undefined) decorators.push(rangeDecorator("size", min, max));
    for (const [k, v] of shape.keywords) {
      if (k === "minItems" || k === "maxItems") continue;
      other(k, v, issues);
    }
    return {
      type: { ...item.type, optional: false, list: true },
      decorators,
      issues,
      ...(item.enumValues ? { enumValues: item.enumValues } : {}),
    };
  }
  if (shape.kind === "enum") return enumField(shape, optional, issues);
  if (shape.kind === "any") throw new Error("unreachable: resolved from the annotation above");
  return scalarField(shape, optional, issues);
}

/** A keyword no mapping uses. */
function other(k: string, v: NeogmaValue, issues: IssueDraft[]): void {
  if (SILENT.has(k)) return;
  if (MESSAGES.has(k)) {
    issues.push(
      issue("ignored", k, "custom error messages: Cyphra's validation errors have their own"),
    );
    return;
  }
  if (k === "default") {
    issues.push(issue("unsupported", "default", `default ${show(v)} is not converted`));
    return;
  }
  issues.push(issue("unsupported", k, `${show(v)} is not converted`));
}

function defaultIssue(v: NeogmaValue): IssueDraft {
  return issue(
    "changed",
    "default",
    `neogma only validates (it does not fill defaults): Cyphra now sets ${show(v)} on create when the value is missing`,
  );
}

function enumField(
  shape: Extract<Shape, { kind: "enum" }>,
  optional: boolean,
  issues: IssueDraft[],
): FieldMapping {
  const values = shape.values;
  if (!values.every((v) => v.kind === "string")) {
    return {
      unsupported: issue(
        "unsupported",
        "enum",
        `an enum of non-string values (${values.map(show).join(", ")}) is not converted`,
      ),
      issues,
    };
  }
  const strings = values.map((v) => (v as { value: string }).value);
  const decorators: Decorator[] = [];
  const def = shape.keywords.get("default");
  if (!strings.every((s) => IDENT.test(s))) {
    // Values Cyphra enums cannot hold (`in-progress`): a String with a regex over the values.
    issues.push(
      issue(
        "changed",
        "enum",
        `values that are not identifiers (${strings.map((s) => JSON.stringify(s)).join(", ")}) became a String checked by @regex`,
      ),
    );
    if (def?.kind === "string") {
      decorators.push({ name: "default", args: [{ key: "value", value: def }] });
      issues.push(defaultIssue(def));
    }
    const pattern = `^(?:${strings.map(escapeRegex).join("|")})$`;
    decorators.push({
      name: "regex",
      args: [{ key: "pattern", value: { kind: "string", value: pattern } }],
    });
    for (const [k, v] of shape.keywords) if (k !== "default") other(k, v, issues);
    return { type: { name: "String", optional }, decorators, issues };
  }
  if (def?.kind === "string" && strings.includes(def.value)) {
    decorators.push({
      name: "default",
      args: [{ key: "value", value: { kind: "identifier", value: def.value } }],
    });
    issues.push(defaultIssue(def));
  } else if (def) other("default", def, issues);
  for (const [k, v] of shape.keywords) if (k !== "default") other(k, v, issues);
  return {
    type: { name: "Enum", optional },
    decorators,
    issues,
    enumValues: [...new Set(strings)],
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function scalarField(
  shape: Extract<Shape, { kind: "scalar" }>,
  optional: boolean,
  issues: IssueDraft[],
): FieldMapping {
  const k = shape.keywords;
  let type: ScalarTypeName = shape.type;
  const decorators: Decorator[] = [];
  const used = new Set<string>();
  const use = (key: string) => {
    used.add(key);
    return k.get(key);
  };

  if (type === "Int") {
    issues.push(
      issue(
        "changed",
        "Integer",
        "became Int (a Neo4j INTEGER), but the driver stored neogma's JS numbers as FLOAT: convert them with toInteger() when you move the data",
      ),
    );
  }

  if (type === "String") {
    const format = use("format");
    const f = format?.kind === "string" ? format.value : undefined;
    const date = f ? DATE_FORMATS[f] : undefined;
    if (date) {
      type = date.type;
      issues.push(
        issue(
          "changed",
          `format: "${f}"`,
          `a ${f} string became a ${date.type} (a Neo4j ${date.what}): convert the stored strings with ${date.fn}() when you move the data`,
        ),
      );
    } else if (f === "email") {
      decorators.push({ name: "email", args: [] });
    } else if (f === "url" || f === "uri") {
      decorators.push({ name: "url", args: [] });
      if (f === "uri") {
        issues.push(
          issue(
            "changed",
            'format: "uri"',
            "became @url, which accepts absolute http and https URLs only",
          ),
        );
      }
    } else if (f === "uuid") {
      decorators.push({
        name: "regex",
        args: [{ key: "pattern", value: { kind: "string", value: UUID_PATTERN } }],
      });
    } else if (format) {
      issues.push(
        issue(
          "unsupported",
          "format",
          `format ${show(format)} is not checked by Cyphra: not converted; add a @regex if you need it`,
        ),
      );
    }
  }

  if (type === "String") {
    let min = numberKeyword(k, "minLength");
    const max = numberKeyword(k, "maxLength");
    used.add("minLength").add("maxLength");
    const allowEmpty = use("allowEmpty");
    if (allowEmpty?.kind === "boolean" && !allowEmpty.value && (min === undefined || min < 1)) {
      min = 1;
    }
    if (min !== undefined || max !== undefined) decorators.push(rangeDecorator("length", min, max));
    const pattern = use("pattern");
    if (pattern?.kind === "string") {
      decorators.push({
        name: "regex",
        args: [{ key: "pattern", value: { kind: "string", value: pattern.value } }],
      });
    } else if (pattern?.kind === "regex") {
      // Stateless flags only: `g` and `y` change nothing for a single test.
      const flags = [...pattern.flags].filter((c) => "imsu".includes(c)).join("");
      decorators.push({
        name: "regex",
        args: [
          { key: "pattern", value: { kind: "string", value: pattern.pattern } },
          ...(flags ? [{ key: "flags", value: { kind: "string", value: flags } as const }] : []),
        ],
      });
    } else if (pattern) {
      other("pattern", pattern, issues);
    }
  }

  if (type === "Int" || type === "Float" || type === "BigInt") {
    for (const [key, rule, exclusive] of [
      ["minimum", "min", "exclusiveMinimum"],
      ["maximum", "max", "exclusiveMaximum"],
    ] as const) {
      const inclusive = numberKeyword(k, key);
      const strict = numberKeyword(k, exclusive);
      used.add(key).add(exclusive);
      if (inclusive !== undefined) {
        decorators.push({ name: rule, args: [{ key: "value", value: num(inclusive) }] });
      } else if (strict !== undefined && type !== "Float" && Number.isInteger(strict)) {
        // On integers, `> n` is `>= n + 1`.
        const bound = rule === "min" ? strict + 1 : strict - 1;
        decorators.push({ name: rule, args: [{ key: "value", value: num(bound) }] });
      } else if (strict !== undefined) {
        issues.push(
          issue(
            "unsupported",
            exclusive,
            `${rule === "min" ? ">" : "<"} ${strict} is not converted (Cyphra's @${rule} is inclusive): set @${rule} to the closest value you accept`,
          ),
        );
      }
    }
  }

  const def = use("default");
  if (def) {
    const ok =
      (type === "String" && def.kind === "string") ||
      (type === "Float" && def.kind === "number") ||
      ((type === "Int" || type === "BigInt") &&
        def.kind === "number" &&
        Number.isInteger(def.value)) ||
      (type === "Boolean" && def.kind === "boolean");
    if (ok) {
      decorators.unshift({
        name: "default",
        args: [{ key: "value", value: def as DecoratorValue }],
      });
      issues.push(defaultIssue(def));
    } else {
      other("default", def, issues);
    }
  }

  for (const [key, v] of k) {
    if (used.has(key)) continue;
    other(key, v, issues);
  }
  return { type: { name: type, optional }, decorators, issues };
}
