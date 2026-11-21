/**
 * The mapping from `@neo4j/graphql` v7 type definitions to Cyphra, in one place.
 *
 * Each GraphQL scalar, type-level directive and field-level directive has one entry here. When
 * Cyphra gains a feature, supporting it in the importer means changing that entry: the converter
 * in `convert.ts` only walks the SDL and applies these rules.
 *
 * Semantics follow `@neo4j/graphql` 7.x (checked against 7.6.8):
 * - only object types with `@node` are nodes; `@node(labels)` sets the Neo4j labels;
 * - `@id` takes no arguments, is only valid on `ID` fields, autogenerates a UUID and does not
 *   create a uniqueness constraint;
 * - `@unique` no longer exists (removed in v7);
 * - `@timestamp(operations)` defaults to `[CREATE, UPDATE]`;
 * - `@relationship(type, direction)` requires both; `properties` names a `@relationshipProperties`
 *   object type.
 *
 * @packageDocumentation
 */

import type { ConstDirectiveNode, ConstValueNode } from "graphql";
import { Kind, valueFromASTUntyped } from "graphql";
import {
  isValidTemporalText,
  type Decorator,
  type ImportIssue,
  type ImportSeverity,
  type ScalarTypeName,
} from "@cyphra/schema";

/** How serious a report entry is, and one line of the import report (shared by the importers). */
export type { ImportIssue, ImportSeverity };

/** An issue before its location is attached. */
export type IssueDraft = Omit<ImportIssue, "at">;

// ---------------------------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------------------------

/** What a GraphQL scalar (or enum) becomes. */
export type ScalarMapping =
  | {
      readonly type: ScalarTypeName;
      /** Name of the Cyphra `enum` (when `type` is `"Enum"`). */
      readonly enum?: string;
      readonly note?: string;
    }
  | { readonly unsupported: string };

/** Built-in GraphQL scalars and the scalars and types `@neo4j/graphql` v7 adds. */
export const SCALARS: Readonly<Record<string, ScalarMapping>> = {
  ID: { type: "String" },
  String: { type: "String" },
  Int: { type: "Int" },
  Float: { type: "Float" },
  Boolean: { type: "Boolean" },
  DateTime: { type: "DateTime" },
  Date: { type: "Date" },
  BigInt: { type: "BigInt" },
  // Same Neo4j types: `Time` keeps its offset, `Point` is WGS-84, `CartesianPoint` Cartesian.
  Time: { type: "Time" },
  LocalTime: { type: "LocalTime" },
  LocalDateTime: { type: "LocalDateTime" },
  Duration: { type: "Duration" },
  Point: { type: "Point" },
  CartesianPoint: { type: "CartesianPoint" },
};

/**
 * Fields typed with a GraphQL enum become fields of a Cyphra `enum` of the same name and values
 * (stored as strings, like `@neo4j/graphql` does).
 */
export function enumField(name: string): ScalarMapping {
  return { type: "Enum", enum: name };
}

/**
 * A GraphQL enum whose name a Cyphra enum cannot take (a built-in type name, or the name of a
 * converted node): its fields are mapped to `String`.
 */
export const ENUM_AS_STRING: ScalarMapping = {
  type: "String",
  note: "this enum name cannot be a Cyphra enum (it clashes with a type or node name): mapped to String, allowed values are not enforced",
};

/** Fields typed with a user-declared `scalar X`. */
export const CUSTOM_SCALAR_FIELD: ScalarMapping = {
  unsupported: "custom scalars are not supported by Cyphra",
};

// ---------------------------------------------------------------------------------------------
// Decorator helpers
// ---------------------------------------------------------------------------------------------

export const ID: Decorator = { name: "id", args: [] };
export const UNIQUE: Decorator = { name: "unique", args: [] };

export function defaultFn(fn: "uuid" | "now" | "cuid"): Decorator {
  return { name: "default", args: [{ key: "fn", value: { kind: "identifier", value: fn } }] };
}

/** `@default(VALUE)` for an enum field. */
export function defaultEnum(value: string): Decorator {
  return { name: "default", args: [{ key: "value", value: { kind: "identifier", value } }] };
}

/** `@default(n)` for a BigInt field: integers beyond 2^53 keep their digits in `raw`. */
export function defaultBigInt(digits: string): Decorator {
  const value = Number(digits);
  const v = Number.isSafeInteger(value)
    ? ({ kind: "number", value } as const)
    : ({ kind: "number", value, raw: digits } as const);
  return { name: "default", args: [{ key: "value", value: v }] };
}

export function defaultLiteral(value: string | number | boolean): Decorator {
  const v =
    typeof value === "string"
      ? ({ kind: "string", value } as const)
      : typeof value === "number"
        ? ({ kind: "number", value } as const)
        : ({ kind: "boolean", value } as const);
  return { name: "default", args: [{ key: "value", value: v }] };
}

/** A directive argument, if present. */
export function arg(d: ConstDirectiveNode, name: string): ConstValueNode | undefined {
  return d.arguments?.find((a) => a.name.value === name)?.value;
}

/** A string argument, or `undefined` when absent or not a string. */
export function stringArg(d: ConstDirectiveNode, name: string): string | undefined {
  const v = arg(d, name);
  return v?.kind === Kind.STRING ? v.value : undefined;
}

/** A list-of-enums (or single enum) argument as strings. */
export function enumListArg(d: ConstDirectiveNode, name: string): string[] | undefined {
  const v = arg(d, name);
  if (!v) return undefined;
  const items = v.kind === Kind.LIST ? v.values : [v];
  return items.flatMap((i) => (i.kind === Kind.ENUM || i.kind === Kind.STRING ? [i.value] : []));
}

// ---------------------------------------------------------------------------------------------
// Field directives
// ---------------------------------------------------------------------------------------------

/** What the converter knows about a scalar field when it applies a field directive. */
export type FieldContext = {
  /** Whether the field belongs to a node or to a `@relationshipProperties` type. */
  readonly owner: "node" | "relationship";
  /** GraphQL name of the field's named type (`ID`, `String`, an enum name, …). */
  readonly graphqlType: string;
  /** Cyphra scalar the field maps to. */
  readonly type: ScalarTypeName;
  readonly list: boolean;
  /** `true` when the field is typed with a GraphQL enum (a Cyphra enum, or `String`). */
  readonly isEnum: boolean;
  /** `true` once another field of the same node took `@id`. */
  readonly nodeHasId: boolean;
};

/** What a field directive does to the Cyphra field. */
export type FieldEffect = {
  readonly decorators?: readonly Decorator[];
  /** Rename the Cyphra field (e.g. `@alias`: the Neo4j property name). */
  readonly rename?: string;
  /** Force the field required (`true`) or optional (`false`). */
  readonly required?: boolean;
  /** This field took the node's `@id`. */
  readonly takesId?: boolean;
  readonly issues?: readonly IssueDraft[];
};

/** Field directive handler; `drop` handlers remove the whole field (computed fields). */
export type FieldDirectiveRule =
  | {
      readonly kind: "scalar";
      readonly apply: (d: ConstDirectiveNode, ctx: FieldContext) => FieldEffect;
    }
  /** Removes the field: it is computed, not stored. */
  | { readonly kind: "drop"; readonly message: string }
  /** Kept as is, reported once per use. */
  | { readonly kind: "report"; readonly severity: ImportSeverity; readonly message: string };

const API_ONLY = "API setting of @neo4j/graphql, no effect on the data model";
const AUTH =
  "authorization rules are not part of a Cyphra schema: compat.v7 still applies them; enforce them yourself around the typed client";

function issue(severity: ImportSeverity, feature: string, message: string): IssueDraft {
  return { severity, feature, message };
}

/** Convert a GraphQL `@default(value:)` to a Cyphra default for the field's type. */
function defaultFromValue(
  v: ConstValueNode,
  ctx: FieldContext,
): Decorator | string | number | boolean | { error: string } {
  if (ctx.list) return { error: "Cyphra has no defaults for list fields" };
  switch (ctx.type) {
    case "Enum":
      if (v.kind === Kind.ENUM) return defaultEnum(v.value);
      break;
    case "BigInt":
      if ((v.kind === Kind.INT || v.kind === Kind.STRING) && /^-?[0-9]+$/.test(v.value)) {
        return defaultBigInt(v.value);
      }
      break;
    case "String":
      if (v.kind === Kind.STRING) return v.value;
      if (ctx.isEnum && v.kind === Kind.ENUM) return v.value;
      break;
    case "Int":
      if (v.kind === Kind.INT) return Number(v.value);
      break;
    case "Float":
      if (v.kind === Kind.INT || v.kind === Kind.FLOAT) return Number(v.value);
      break;
    case "Boolean":
      if (v.kind === Kind.BOOLEAN) return v.value;
      break;
    case "DateTime":
    case "Date":
      return { error: `Cyphra only supports @default(now()) on ${ctx.type} fields` };
    case "Time":
    case "LocalTime":
    case "LocalDateTime":
      if (v.kind === Kind.STRING && isValidTemporalText(ctx.type, v.value)) return v.value;
      break;
  }
  return { error: `the default does not match type ${ctx.graphqlType}` };
}

/**
 * Field-level directives of `@neo4j/graphql` v7 (plus `@unique` and `@private` from older
 * versions, which teams often still have). `@relationship` is handled by the converter.
 */
export const FIELD_DIRECTIVES: Readonly<Record<string, FieldDirectiveRule>> = {
  id: {
    kind: "scalar",
    apply: (_d, ctx) => {
      if (ctx.graphqlType !== "ID" || ctx.list) {
        return {
          issues: [
            issue("unsupported", "@id", "@id is only valid on ID fields in v7; not converted"),
          ],
        };
      }
      if (ctx.owner === "relationship") {
        return {
          decorators: [defaultFn("uuid")],
          required: true,
          issues: [
            issue(
              "changed",
              "@id",
              "Cyphra has no @id on relationship properties: kept as @default(uuid())",
            ),
          ],
        };
      }
      if (ctx.nodeHasId) {
        return {
          decorators: [UNIQUE, defaultFn("uuid")],
          required: true,
          issues: [
            issue(
              "changed",
              "@id",
              "a Cyphra node has one @id: this one became @unique @default(uuid())",
            ),
          ],
        };
      }
      return {
        decorators: [ID, defaultFn("uuid")],
        required: true,
        takesId: true,
        issues: [
          issue(
            "changed",
            "@id",
            "became @id @default(uuid()); Cyphra also adds a uniqueness constraint, which v7 @id does not",
          ),
        ],
      };
    },
  },
  timestamp: {
    kind: "scalar",
    apply: (d, ctx) => {
      const ops = enumListArg(d, "operations") ?? ["CREATE", "UPDATE"];
      if ((ctx.type !== "DateTime" && ctx.type !== "Time") || ctx.list) {
        return {
          issues: [
            issue("unsupported", "@timestamp", "@timestamp is only converted on DateTime and Time"),
          ],
        };
      }
      if (!ops.includes("CREATE")) {
        return {
          required: false,
          issues: [
            issue(
              "unsupported",
              "@timestamp",
              "update timestamps are not set automatically by Cyphra: field made optional, set it when you update",
            ),
          ],
        };
      }
      const issues = ops.includes("UPDATE")
        ? [
            issue(
              "changed",
              "@timestamp",
              "became @default(now()) (set on create); Cyphra does not refresh it on update, set it when you update",
            ),
          ]
        : [];
      return { decorators: [defaultFn("now")], issues };
    },
  },
  default: {
    kind: "scalar",
    apply: (d, ctx) => {
      const v = arg(d, "value");
      const value = v ? defaultFromValue(v, ctx) : { error: "missing value" };
      if (typeof value === "object" && "error" in value) {
        return { issues: [issue("unsupported", "@default", `${value.error}; not converted`)] };
      }
      return { decorators: [typeof value === "object" ? value : defaultLiteral(value)] };
    },
  },
  unique: {
    kind: "scalar",
    apply: () => ({
      decorators: [UNIQUE],
      issues: [
        issue(
          "changed",
          "@unique",
          "@unique was removed in @neo4j/graphql v7; Cyphra keeps it and creates the uniqueness constraint",
        ),
      ],
    }),
  },
  relayId: {
    kind: "scalar",
    apply: () => ({
      decorators: [UNIQUE],
      issues: [
        issue(
          "changed",
          "@relayId",
          "became @unique; Cyphra has no Relay global IDs (the field keeps its plain value)",
        ),
      ],
    }),
  },
  alias: {
    kind: "scalar",
    apply: (d) => {
      const property = stringArg(d, "property");
      if (!property || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(property)) {
        return {
          issues: [
            issue("unsupported", "@alias", "the property name is not an identifier; not renamed"),
          ],
        };
      }
      return {
        rename: property,
        issues: [
          issue(
            "changed",
            "@alias",
            `Cyphra field names are the Neo4j property names: renamed to "${property}"`,
          ),
        ],
      };
    },
  },
  cypher: {
    kind: "drop",
    message:
      "@cypher fields are computed by a Cypher query: not converted (compat.v7 still serves it); with the typed client, write it as a query",
  },
  customResolver: {
    kind: "drop",
    message: "@customResolver fields are computed in code: not converted",
  },
  populatedBy: {
    kind: "report",
    severity: "unsupported",
    message: "@populatedBy callbacks are not supported: set the value in your code",
  },
  coalesce: {
    kind: "report",
    severity: "unsupported",
    message: "@coalesce read fallbacks are not supported",
  },
  authentication: { kind: "report", severity: "unsupported", message: AUTH },
  authorization: { kind: "report", severity: "unsupported", message: AUTH },
  subscriptionsAuthorization: { kind: "report", severity: "unsupported", message: AUTH },
  selectable: { kind: "report", severity: "ignored", message: API_ONLY },
  settable: { kind: "report", severity: "ignored", message: API_ONLY },
  filterable: { kind: "report", severity: "ignored", message: API_ONLY },
  sortable: { kind: "report", severity: "ignored", message: API_ONLY },
  private: { kind: "report", severity: "ignored", message: API_ONLY },
  jwtClaim: { kind: "report", severity: "ignored", message: API_ONLY },
  deprecated: { kind: "report", severity: "ignored", message: "GraphQL deprecation, no effect" },
};

// ---------------------------------------------------------------------------------------------
// Type directives
// ---------------------------------------------------------------------------------------------

/**
 * A full-text index read from `@fulltext`, with the GraphQL field names. The converter maps them
 * to Cyphra field names (after `@alias`) and writes `@@fulltext([fields], name: "…")`.
 */
export type FulltextDraft = { readonly name: string; readonly fields: readonly string[] };

/** What a type-level directive does to the Cyphra node. */
export type TypeEffect = {
  /** Rename the Cyphra node (its name is its Neo4j label). */
  readonly rename?: string;
  /** `@@fulltext` indexes to add to the node. */
  readonly fulltext?: readonly FulltextDraft[];
  readonly issues?: readonly IssueDraft[];
};

export type TypeDirectiveRule = (d: ConstDirectiveNode, typeName: string) => TypeEffect;

function reportType(severity: ImportSeverity, message: string): TypeDirectiveRule {
  return (d) => ({ issues: [issue(severity, `@${d.name.value}`, message)] });
}

/** Type-level directives on `@node` types. */
export const TYPE_DIRECTIVES: Readonly<Record<string, TypeDirectiveRule>> = {
  node: (d, typeName) => {
    const labels = enumListArg(d, "labels");
    if (!labels || labels.length === 0) return {};
    const [first, ...rest] = labels as [string, ...string[]];
    const issues: IssueDraft[] = [];
    let rename: string | undefined;
    if (first !== typeName) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(first)) {
        rename = first;
        issues.push(
          issue(
            "changed",
            "@node(labels)",
            `a Cyphra node's name is its label: renamed to "${first}"`,
          ),
        );
      } else {
        issues.push(
          issue(
            "unsupported",
            "@node(labels)",
            `label "${first}" is not an identifier (dynamic labels are not supported); kept "${typeName}"`,
          ),
        );
      }
    }
    if (rest.length > 0) {
      issues.push(
        issue(
          "unsupported",
          "@node(labels)",
          `extra labels ${rest.map((l) => `"${l}"`).join(", ")} are not supported: Cyphra nodes have one label`,
        ),
      );
    }
    return rename ? { rename, issues } : { issues };
  },
  fulltext: (d) => {
    const raw = arg(d, "indexes");
    const indexes = raw ? (valueFromASTUntyped(raw) as unknown) : undefined;
    const list = Array.isArray(indexes) ? indexes : indexes === undefined ? [] : [indexes];
    const fulltext: FulltextDraft[] = [];
    const issues: IssueDraft[] = [];
    for (const ix of list) {
      const { indexName, queryName, fields } = (ix ?? {}) as Record<string, unknown>;
      if (
        typeof indexName !== "string" ||
        !Array.isArray(fields) ||
        fields.length === 0 ||
        !fields.every((f) => typeof f === "string")
      ) {
        issues.push(
          issue("unsupported", "@fulltext", "an index needs indexName and fields: not converted"),
        );
        continue;
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(indexName)) {
        issues.push(
          issue(
            "unsupported",
            "@fulltext",
            `index name "${indexName}" is not letters, digits and underscores: not converted`,
          ),
        );
        continue;
      }
      fulltext.push({ name: indexName, fields: fields as string[] });
      if (typeof queryName === "string") {
        issues.push(
          issue(
            "ignored",
            "@fulltext(queryName)",
            `query field "${queryName}" is part of the GraphQL API (compat.v7 still serves it)`,
          ),
        );
      }
    }
    return { fulltext, issues };
  },
  vector: reportType(
    "unsupported",
    "vector indexes are not converted: the type definitions carry neither the dimensions nor the similarity; declare the embedding as a Vector(N) field with @vectorIndex(name: ...)",
  ),
  authentication: reportType("unsupported", AUTH),
  authorization: reportType("unsupported", AUTH),
  subscriptionsAuthorization: reportType("unsupported", AUTH),
  plural: reportType("ignored", API_ONLY),
  query: reportType("ignored", API_ONLY),
  mutation: reportType("ignored", API_ONLY),
  subscription: reportType("ignored", API_ONLY),
  limit: reportType("ignored", API_ONLY),
  groupBy: reportType("ignored", API_ONLY),
  deprecated: reportType("ignored", "GraphQL deprecation, no effect"),
};

/** `@relationship` arguments that only shape the GraphQL API. */
export const RELATIONSHIP_API_ARGS: readonly string[] = ["nestedOperations", "aggregate"];
