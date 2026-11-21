/**
 * The mapping from a Prisma schema to Cyphra, in one place.
 *
 * Each Prisma scalar type, field attribute, block attribute, default function and referential
 * action has one entry here. When Cyphra gains a feature, supporting it in the importer means
 * changing that entry: the converter in `convert.ts` only walks the schema, links relations and
 * applies these rules.
 *
 * Relations follow these rules (see `/guides/migrate-from-prisma`):
 * - a foreign-key relation (`author User @relation(fields: [authorId], references: [id])`) becomes
 *   one edge from the referenced model to the model holding the key, `(User)-[:TYPE]->(Post)`, and
 *   the key scalar (`authorId`) is dropped: the edge is the link;
 * - an implicit many-to-many (`tags Tag[]` / `posts Post[]`, no key) becomes one edge, from the
 *   model whose name sorts first (Prisma's `A` side) to the other;
 * - an explicit join model (two required key relations, a `@@id` or `@@unique` over the keys, any
 *   other scalars) becomes a `relationship` model whose properties are its other scalars;
 * - the edge type is the relation name in upper snake case (`@relation("PostAuthor")` →
 *   `POST_AUTHOR`), the join model's name for a join model (`OrderItem` → `ORDER_ITEM`), else
 *   `HAS_` and the field on the edge's start model (`User.posts` → `HAS_POSTS`);
 * - `onDelete` moves to the referenced model's field: in Prisma it says what deleting the parent
 *   does to the rows holding the key, which is what a Cyphra rule on the parent's field says.
 *
 * @packageDocumentation
 */

import type { Decorator, ScalarTypeName } from "../../ast.js";
import type { ImportSeverity, IssueDraft } from "../print.js";
import type { PrismaArg, PrismaValue } from "./parse.js";

export function issue(severity: ImportSeverity, feature: string, message: string): IssueDraft {
  return { severity, feature, message };
}

// ---------------------------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------------------------

/** What a Prisma scalar type becomes. */
export type ScalarMapping =
  { readonly type: ScalarTypeName; readonly issue?: IssueDraft } | { readonly unsupported: string };

export const SCALARS: Readonly<Record<string, ScalarMapping>> = {
  String: { type: "String" },
  Boolean: { type: "Boolean" },
  Int: { type: "Int" },
  BigInt: { type: "BigInt" },
  Float: { type: "Float" },
  DateTime: { type: "DateTime" },
  Json: { type: "Json" },
  Decimal: {
    type: "Float",
    issue: issue(
      "changed",
      "Decimal",
      "became Float: a 64-bit float keeps about 15 significant digits, so exact decimals (money) can round; use a String or an Int of cents to keep them exact",
    ),
  },
  Bytes: {
    unsupported:
      "Neo4j has no byte arrays in Cyphra: not converted; store the bytes elsewhere (object storage) or as base64 text in a String",
  },
};

/** Fields typed with a composite `type` (MongoDB): kept as one Json value. */
export const COMPOSITE_TYPE: IssueDraft = issue(
  "changed",
  "type",
  "composite types become a Json field (one JSON value): their fields are not typed or validated by Cyphra",
);

/** `Unsupported("…")` fields. */
export const UNSUPPORTED_TYPE =
  "Unsupported(…) database types are not converted (Prisma cannot read them either)";

/** Cyphra type names an enum cannot take. */
export const CYPHRA_TYPE_NAMES: ReadonlySet<string> = new Set([
  "String",
  "Int",
  "Float",
  "Boolean",
  "DateTime",
  "Date",
  "BigInt",
  "Json",
  "LocalDateTime",
  "LocalTime",
  "Time",
  "Duration",
  "Point",
  "CartesianPoint",
  "Vector",
]);

// ---------------------------------------------------------------------------------------------
// Native types (`@db.*`)
// ---------------------------------------------------------------------------------------------

/** What a native type attribute does to the Cyphra field. */
export type NativeEffect = {
  /** Replace the Cyphra type (`@db.Date` on a DateTime is a `Date`). */
  readonly type?: ScalarTypeName;
  readonly decorators?: readonly Decorator[];
  readonly issue?: IssueDraft;
};

function lengthMax(n: number): Decorator {
  return { name: "length", args: [{ key: "max", value: { kind: "number", value: n } }] };
}

/**
 * `@db.X(args)` on a field of Cyphra type `type`. Native types that only pick a column type
 * (`@db.Uuid`, `@db.Text`, `@db.Timestamptz(6)`) have no effect in Neo4j.
 */
export function nativeType(
  name: string,
  args: readonly PrismaArg[],
  type: ScalarTypeName,
): NativeEffect {
  const native = name.slice(name.indexOf(".") + 1);
  const first = args[0]?.value;
  if (type === "DateTime" && native === "Date") {
    return {
      type: "Date",
      issue: issue("changed", `@${name}`, "a date column became a Date field (a Neo4j DATE)"),
    };
  }
  if (type === "DateTime" && native === "Time") {
    return {
      type: "LocalTime",
      issue: issue(
        "changed",
        `@${name}`,
        "a time column became a LocalTime field: ISO text (`10:30:00`) in JS instead of a Date",
      ),
    };
  }
  if (type === "DateTime" && native === "Timetz") {
    return {
      type: "Time",
      issue: issue(
        "changed",
        `@${name}`,
        "a time with time zone became a Time field: ISO text with offset (`10:30:00+02:00`) in JS",
      ),
    };
  }
  if (
    type === "String" &&
    ["VarChar", "Char", "NVarChar", "NChar"].includes(native) &&
    first?.kind === "number" &&
    /^[0-9]+$/.test(first.value)
  ) {
    const n = Number(first.value);
    return {
      decorators: [lengthMax(n)],
      issue: issue(
        "changed",
        `@${name}`,
        `the column length became @length(max: ${n}), checked by the Cyphra client on every write (Neo4j strings have no length limit)`,
      ),
    };
  }
  if (type === "String" && native === "Citext") {
    return {
      issue: issue(
        "changed",
        `@${name}`,
        'case-insensitive text: Neo4j compares strings case-sensitively, so @unique no longer ignores case; filter with mode: "insensitive"',
      ),
    };
  }
  return {
    issue: issue("ignored", `@${name}`, "native database type, no effect in Neo4j"),
  };
}

// ---------------------------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------------------------

export function defaultFn(fn: "uuid" | "now" | "cuid"): Decorator {
  return { name: "default", args: [{ key: "fn", value: { kind: "identifier", value: fn } }] };
}

function defaultValue(
  v:
    | { kind: "string"; value: string }
    | { kind: "number"; value: number; raw?: string }
    | {
        kind: "boolean";
        value: boolean;
      }
    | { kind: "identifier"; value: string },
): Decorator {
  return { name: "default", args: [{ key: "value", value: v }] };
}

/** What `@default(…)` becomes: a decorator, nothing (with an issue), or an issue alone. */
export type DefaultEffect = {
  readonly decorator?: Decorator;
  readonly issue?: IssueDraft;
};

/** What the converter knows about the field when it maps a default. */
export type DefaultContext = {
  readonly type: ScalarTypeName;
  readonly list: boolean;
  readonly id: boolean;
  /** Values of the enum, for an enum field. */
  readonly enumValues?: readonly string[];
};

const AUTOINCREMENT =
  "Neo4j has no sequences: not converted; keep the existing ids when you migrate the data, and set new ones yourself (or switch to String @id @default(cuid()))";

/** Prisma default functions. */
const DEFAULT_FUNCTIONS: Readonly<
  Record<string, (args: readonly PrismaArg[], ctx: DefaultContext) => DefaultEffect>
> = {
  now: (_a, ctx) =>
    ["DateTime", "Date", "LocalDateTime", "LocalTime", "Time"].includes(ctx.type)
      ? { decorator: defaultFn("now") }
      : {
          issue: issue(
            "unsupported",
            "@default(now())",
            "now() on a non-date field: not converted",
          ),
        },
  cuid: (args) =>
    args.length > 0
      ? {
          decorator: defaultFn("cuid"),
          issue: issue(
            "changed",
            "@default(cuid(2))",
            "became cuid(): new ids use Cyphra's cuid format (existing ids are kept as they are)",
          ),
        }
      : { decorator: defaultFn("cuid") },
  uuid: (args) => {
    const version = args[0]?.value;
    if (version?.kind === "number" && version.value === "7") {
      return {
        decorator: defaultFn("uuid"),
        issue: issue(
          "changed",
          "@default(uuid(7))",
          "became uuid(): Cyphra generates version 4 UUIDs, which are not time-ordered",
        ),
      };
    }
    return { decorator: defaultFn("uuid") };
  },
  ulid: () => ({
    decorator: defaultFn("cuid"),
    issue: issue(
      "changed",
      "@default(ulid())",
      "became cuid(): Cyphra has no ULIDs (new ids are not time-ordered)",
    ),
  }),
  nanoid: () => ({
    decorator: defaultFn("cuid"),
    issue: issue("changed", "@default(nanoid())", "became cuid(): Cyphra has no nanoid"),
  }),
  auto: () => ({
    decorator: defaultFn("cuid"),
    issue: issue(
      "changed",
      "@default(auto())",
      "MongoDB ObjectIds became cuid(): keep the existing ids as strings when you migrate the data",
    ),
  }),
  autoincrement: () => ({
    issue: issue("unsupported", "@default(autoincrement())", AUTOINCREMENT),
  }),
  sequence: () => ({ issue: issue("unsupported", "@default(sequence())", AUTOINCREMENT) }),
  dbgenerated: (args) => {
    const sql = args[0]?.value.kind === "string" ? args[0].value.value.trim() : "";
    if (/^(gen_random_uuid|uuid_generate_v4)\(\)$/i.test(sql)) {
      return {
        decorator: defaultFn("uuid"),
        issue: issue(
          "changed",
          "@default(dbgenerated())",
          `${sql} became uuid() (set by the client)`,
        ),
      };
    }
    if (/^(now\(\)|current_timestamp(\(\))?)$/i.test(sql)) {
      return {
        decorator: defaultFn("now"),
        issue: issue(
          "changed",
          "@default(dbgenerated())",
          `${sql} became now() (set by the client)`,
        ),
      };
    }
    return {
      issue: issue(
        "unsupported",
        "@default(dbgenerated())",
        `database-generated default ${JSON.stringify(sql)}: not converted; set the value in your code`,
      ),
    };
  },
};

/** Convert `@default(value)` to a Cyphra default for the field's type. */
export function convertDefault(v: PrismaValue, ctx: DefaultContext): DefaultEffect {
  if (v.kind === "ident" && v.args) {
    const fn = DEFAULT_FUNCTIONS[v.name];
    if (!fn) {
      return {
        issue: issue(
          "unsupported",
          `@default(${v.name}())`,
          `unknown default function: not converted`,
        ),
      };
    }
    return fn(v.args, ctx);
  }
  if (ctx.list) {
    if (v.kind === "array" && v.items.length === 0) {
      return {
        issue: issue("ignored", "@default([])", "not needed: an absent list reads as [] in Cyphra"),
      };
    }
    return {
      issue: issue(
        "unsupported",
        "@default",
        "Cyphra has no defaults for list fields: not converted; an absent list reads as []",
      ),
    };
  }
  const bad: DefaultEffect = {
    issue: issue(
      "unsupported",
      "@default",
      `the default does not fit a ${ctx.type} field: not converted`,
    ),
  };
  switch (ctx.type) {
    case "String":
      return v.kind === "string" ? { decorator: defaultValue(v) } : bad;
    case "Json":
      if (v.kind !== "string") return bad;
      try {
        JSON.parse(v.value);
      } catch {
        return bad;
      }
      return { decorator: defaultValue(v) };
    case "Boolean":
      return v.kind === "boolean" ? { decorator: defaultValue(v) } : bad;
    case "Int":
      return v.kind === "number" && /^-?[0-9]+$/.test(v.value)
        ? { decorator: defaultValue({ kind: "number", value: Number(v.value) }) }
        : bad;
    case "Float":
      return v.kind === "number"
        ? { decorator: defaultValue({ kind: "number", value: Number(v.value) }) }
        : bad;
    case "BigInt": {
      const digits = v.kind === "number" || v.kind === "string" ? v.value : "";
      if (!/^-?[0-9]+$/.test(digits)) return bad;
      const n = Number(digits);
      return {
        decorator: defaultValue(
          Number.isSafeInteger(n)
            ? { kind: "number", value: n }
            : { kind: "number", value: n, raw: digits },
        ),
      };
    }
    case "Enum": {
      const name = v.kind === "ident" ? v.name : v.kind === "string" ? v.value : undefined;
      return name !== undefined && (ctx.enumValues ?? []).includes(name)
        ? { decorator: defaultValue({ kind: "identifier", value: name }) }
        : bad;
    }
    case "DateTime":
    case "Date":
      return {
        issue: issue(
          "unsupported",
          "@default",
          `Cyphra only supports @default(now()) on ${ctx.type} fields: the fixed date is not converted`,
        ),
      };
    default:
      return bad;
  }
}

// ---------------------------------------------------------------------------------------------
// Field attributes
// ---------------------------------------------------------------------------------------------

export const ID: Decorator = { name: "id", args: [] };
export const UNIQUE: Decorator = { name: "unique", args: [] };
export const INDEX: Decorator = { name: "index", args: [] };

/** Field attributes reported as they are (the field is converted without them). */
export const FIELD_REPORTS: Readonly<Record<string, IssueDraft>> = {
  updatedAt: issue(
    "changed",
    "@updatedAt",
    "became @default(now()): set on create, but Cyphra does not refresh it on update; set it in your updates",
  ),
  map: issue(
    "changed",
    "@map",
    "column names are not kept: the Neo4j property is the field name (Prisma Client returns field names, so export through it)",
  ),
  ignore: issue("ignored", "@ignore", "the field is not in the Prisma Client: not converted"),
};

/** Field attributes the converter handles itself. */
export const FIELD_ATTRIBUTES: ReadonlySet<string> = new Set([
  "id",
  "default",
  "unique",
  "updatedAt",
  "map",
  "ignore",
  "relation",
]);

// ---------------------------------------------------------------------------------------------
// Block attributes
// ---------------------------------------------------------------------------------------------

export const MODEL_REPORTS: Readonly<Record<string, IssueDraft>> = {
  map: issue("changed", "@@map", "table names are not kept: the node label is the model name"),
  schema: issue("ignored", "@@schema", "database schemas (namespaces) have no effect in Neo4j"),
  ignore: issue("ignored", "@@ignore", "the model is not in the Prisma Client: not converted"),
};

// ---------------------------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------------------------

/** What a Prisma `onDelete` becomes on the referenced model's relation field. */
export type OnDeleteMapping = {
  /** Cyphra rule; absent for the default (`SetNull`: deleting removes the edges). */
  readonly rule?: "Cascade" | "Restrict";
  readonly issue?: IssueDraft;
};

/**
 * Prisma `onDelete` (or its default: `Restrict` when the key is required, `SetNull` when it is
 * optional) for a foreign-key relation.
 *
 * @param joinModel - The key belongs to a join model that became edges: deleting the parent
 * deletes its join rows (`Cascade`), which removing the edges already does.
 */
export function mapOnDelete(
  action: string | undefined,
  required: boolean,
  joinModel: boolean,
): OnDeleteMapping {
  const a = action ?? (required ? "Restrict" : "SetNull");
  switch (a) {
    case "Cascade":
      return joinModel ? {} : { rule: "Cascade" };
    case "Restrict":
      return { rule: "Restrict" };
    case "NoAction":
      return {
        rule: "Restrict",
        issue: issue(
          "changed",
          "onDelete: NoAction",
          "became Restrict: the Cyphra client checks when the node is deleted (there are no deferred checks)",
        ),
      };
    case "SetNull":
      return {};
    case "SetDefault":
      return {
        issue: issue(
          "changed",
          "onDelete: SetDefault",
          "has no Cyphra equivalent: deleting the node removes the edges (SetNull); link the default node yourself",
        ),
      };
    default:
      return {
        issue: issue("unsupported", `onDelete: ${a}`, "unknown referential action: not converted"),
      };
  }
}

/** `UserPosts` / `user_posts` / `userPosts` → `USER_POSTS`. */
export function upperSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

/** Edge type of a relation without a name: `HAS_` and the start model's field. */
export function derivedRelType(startField: string): string {
  return `HAS_${upperSnake(startField)}`;
}

/** The foreign-key scalar of relation `field`, replaced by a `relType` edge. */
export function foreignKeyDropped(field: string, relType: string): string {
  return `dropped: the ${relType} edge of ${field} replaces the key (Neo4j links nodes with edges, not key columns)`;
}
