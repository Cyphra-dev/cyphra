/**
 * Hover and completion documentation for the `.cyphra` language. Type names come from
 * `SCALAR_TYPE_NAMES` in `@cyphra/schema`, so a new scalar type is offered even before it has an
 * entry here (it then gets a generic description).
 */
import {
  FULLTEXT_ANALYZERS,
  ON_DELETE_RULES,
  SCALAR_TYPE_NAMES,
  VECTOR_SIMILARITIES,
} from "@cyphra/schema";

export const DOCS_URL = "https://www.cyphra.dev/schema";

const TYPE_DOCS: Record<string, { neo4j: string; ts: string; note?: string }> = {
  String: { neo4j: "STRING", ts: "string" },
  Int: { neo4j: "INTEGER", ts: "number", note: "Safe integers only (see `BigInt`)." },
  Float: { neo4j: "FLOAT", ts: "number" },
  Boolean: { neo4j: "BOOLEAN", ts: "boolean" },
  DateTime: { neo4j: "ZONED DATETIME", ts: "Date" },
  Date: { neo4j: "DATE", ts: "Date" },
  BigInt: {
    neo4j: "INTEGER",
    ts: "bigint",
    note: "64-bit integer from -2^63 to 2^63-1, no precision loss.",
  },
  Json: {
    neo4j: "STRING (JSON text)",
    ts: "JsonValue",
    note: "Any JSON value, stored as its JSON text. No `@id`, `@unique` or `@index`; no `Json[]`.",
  },
  LocalDateTime: {
    neo4j: "LOCAL DATETIME",
    ts: "LocalDateTime",
    note: 'Date and time without a time zone, as ISO 8601 text (`"2024-05-01T10:30:00"`).',
  },
  LocalTime: {
    neo4j: "LOCAL TIME",
    ts: "LocalTime",
    note: 'Time of day without a time zone, as ISO 8601 text (`"10:30:00"`).',
  },
  Time: {
    neo4j: "ZONED TIME",
    ts: "Time",
    note: 'Time of day with a UTC offset, as ISO 8601 text (`"10:30:00+02:00"`).',
  },
  Duration: {
    neo4j: "DURATION",
    ts: "Duration",
    note: 'ISO 8601 duration (`"PT1H30M"`). Compared for equality only (no order).',
  },
  Point: {
    neo4j: "POINT (WGS-84)",
    ts: "Point",
    note: "`{ longitude, latitude, height? }`. `@index` creates a point index; filter by `distance` or `withinBBox`.",
  },
  CartesianPoint: {
    neo4j: "POINT (Cartesian)",
    ts: "CartesianPoint",
    note: "`{ x, y, z? }`. `@index` creates a point index; filter by `distance` or `withinBBox`.",
  },
  Vector: {
    neo4j: "LIST<FLOAT>",
    ts: "number[]",
    note: "`Vector(N)`: an embedding of N floats (1 to 4096). Index it with `@vectorIndex`.",
  },
};

/** Built-in scalar type names (from `@cyphra/schema`), plus the parametric `Vector`. */
export const BUILTIN_TYPES: readonly string[] = [...SCALAR_TYPE_NAMES, "Vector"];

/** Markdown documentation of a built-in type. */
export function typeDoc(name: string): string {
  const d = TYPE_DOCS[name];
  if (!d)
    return `**${name}**: built-in scalar type.\n\n[Schema reference](${DOCS_URL}#scalar-types)`;
  return [
    `**${name}**: Neo4j \`${d.neo4j}\`, TypeScript \`${d.ts}\`.`,
    ...(d.note ? [d.note] : []),
    "Append `?` for optional or `[]` for a list.",
    `[Schema reference](${DOCS_URL}#scalar-types)`,
  ].join("\n\n");
}

export type ArgDoc = {
  readonly name: string;
  readonly doc: string;
  /** Allowed values offered on completion. */
  readonly values?: readonly string[];
  /** The value is a string literal. */
  readonly string?: boolean;
};

export type DecoratorDoc = {
  readonly name: string;
  /** Where it applies. */
  readonly on: "scalar" | "relation" | "vector" | "model";
  readonly doc: string;
  /** Snippet inserted after `@` (or `@@`). */
  readonly snippet: string;
  readonly args?: readonly ArgDoc[];
  /** Field types it fits (absent: every field of its `on` kind). */
  readonly fits?: (type: string, list: boolean) => boolean;
  /** A validation rule (documented under "Validation rules"). */
  readonly rule?: boolean;
};

const string = (type: string, list: boolean) => type === "String" && !list;
const ORDERED = ["Int", "Float", "BigInt", "DateTime", "Date"];
const BOUND_DOC =
  "The bound, inclusive: a number (`Int`, `Float`, `BigInt`) or an ISO 8601 string (`DateTime`, `Date`).";

export const DECORATORS: readonly DecoratorDoc[] = [
  {
    name: "id",
    on: "scalar",
    doc: "The node's id: a uniqueness constraint (one `@id` per node, not optional, not a list).",
    snippet: "id",
  },
  {
    name: "unique",
    on: "scalar",
    doc: "A uniqueness constraint on this property (on relationship models, a relationship property uniqueness constraint, Neo4j 5.7+).",
    snippet: "unique",
  },
  {
    name: "index",
    on: "scalar",
    doc: "A Neo4j range index on this property. Redundant with `@id` / `@unique`, which are indexed.",
    snippet: "index",
  },
  {
    name: "default",
    on: "scalar",
    doc: "Default applied on create: `cuid()`, `uuid()` (String), `now()` (DateTime / Date), a literal of the field type, an enum value, or JSON text on a Json field.",
    snippet: "default($1)",
  },
  {
    name: "length",
    on: "scalar",
    rule: true,
    doc: "Validation rule: the number of characters of a `String`, from `min` to `max` (inclusive, counted in Unicode code points): `@length(3, 20)`, `@length(max: 280)`.",
    snippet: "length(${1:1}, ${2:100})",
    fits: string,
    args: [
      { name: "min", doc: "Fewest characters (a non-negative integer)." },
      { name: "max", doc: "Most characters (a non-negative integer)." },
    ],
  },
  {
    name: "size",
    on: "scalar",
    rule: true,
    doc: "Validation rule: the number of elements of a list, from `min` to `max` (inclusive): `@size(1, 10)`, `@size(max: 5)`.",
    snippet: "size(${1:1}, ${2:10})",
    fits: (_type, list) => list,
    args: [
      { name: "min", doc: "Fewest elements (a non-negative integer)." },
      { name: "max", doc: "Most elements (a non-negative integer)." },
    ],
  },
  {
    name: "min",
    on: "scalar",
    rule: true,
    doc: 'Validation rule: the smallest value, inclusive, of an `Int`, `Float`, `BigInt`, `DateTime` or `Date` field: `@min(0)`, `@min("2020-01-01")`. Numeric `increment` / `decrement` / `multiply` updates are checked too.',
    snippet: "min(${1:0})",
    fits: (type, list) => !list && ORDERED.includes(type),
    args: [{ name: "value", doc: BOUND_DOC }],
  },
  {
    name: "max",
    on: "scalar",
    rule: true,
    doc: 'Validation rule: the largest value, inclusive, of an `Int`, `Float`, `BigInt`, `DateTime` or `Date` field: `@max(100)`, `@max("2100-01-01T00:00:00Z")`. Numeric `increment` / `decrement` / `multiply` updates are checked too.',
    snippet: "max(${1:100})",
    fits: (type, list) => !list && ORDERED.includes(type),
    args: [{ name: "value", doc: BOUND_DOC }],
  },
  {
    name: "email",
    on: "scalar",
    rule: true,
    doc: "Validation rule: a `String` holding an email address (`local@domain.tld`).",
    snippet: "email",
    fits: string,
  },
  {
    name: "url",
    on: "scalar",
    rule: true,
    doc: "Validation rule: a `String` holding an absolute `http:` or `https:` URL.",
    snippet: "url",
    fits: string,
  },
  {
    name: "regex",
    on: "scalar",
    rule: true,
    doc: 'Validation rule: a `String` matching a JavaScript regular expression, anywhere in the string (anchor it with `^…$` to match all of it): `@regex("^[a-z0-9_]+$", "i")`.',
    snippet: 'regex("${1:pattern}")',
    fits: string,
    args: [
      {
        name: "pattern",
        doc: "The regular expression (a string; `\\\\` for a backslash).",
        string: true,
      },
      { name: "flags", doc: "Flags among `i`, `m`, `s`, `u`.", string: true },
    ],
  },
  {
    name: "nonEmpty",
    on: "scalar",
    rule: true,
    doc: "Validation rule: a `String` that is not empty or only whitespace, or a list with at least one element.",
    snippet: "nonEmpty",
    fits: (type, list) => list || type === "String",
  },
  {
    name: "relationship",
    on: "relation",
    doc: 'A relation to another node: `@relationship(type: "TYPE", direction: OUT | IN, onDelete: Cascade | Restrict | SetNull)`. A `relationship { … }` model with the same type and endpoints types the edge properties.',
    snippet: 'relationship(type: "${1:TYPE}", direction: ${2|OUT,IN|})',
    args: [
      { name: "type", doc: 'The Neo4j relationship type, e.g. `"AUTHORED"`.', string: true },
      {
        name: "direction",
        doc: "`OUT` (from this node, the default) or `IN` (to this node).",
        values: ["OUT", "IN"],
      },
      {
        name: "onDelete",
        doc: "What deleting this node does to the nodes this field links it to: `Cascade` deletes them too (applying their own rules), `Restrict` refuses the delete while any exist, `SetNull` (the default) only removes the edges.",
        values: [...ON_DELETE_RULES],
      },
    ],
  },
  {
    name: "vectorIndex",
    on: "vector",
    doc: "A vector index on a `Vector(N)` field, searched by `findSimilar` (Neo4j 5.15+).",
    snippet: "vectorIndex(similarity: ${1|cosine,euclidean|})",
    args: [
      {
        name: "similarity",
        doc: "Similarity function (default `cosine`).",
        values: [...VECTOR_SIMILARITIES],
      },
      {
        name: "name",
        doc: "Index name (default `<Label>_<field>_vector`).",
        string: true,
      },
      {
        name: "quantization",
        doc: "`vector.quantization.enabled` (Neo4j 5.23+; Neo4j's default is on).",
        values: ["true", "false"],
      },
    ],
  },
  {
    name: "fulltext",
    on: "model",
    doc: 'A full-text index over `String` / `String[]` fields of the node, queried by `search`: `@@fulltext([title, body], name: "…", analyzer: "…")`.',
    snippet: "fulltext([${1}])",
    args: [
      {
        name: "name",
        doc: "Index name (default `<Label>_<field>_…_fulltext`).",
        string: true,
      },
      {
        name: "analyzer",
        doc: "`fulltext.analyzer` (Neo4j's default is `standard-no-stop-words`).",
        values: [...FULLTEXT_ANALYZERS],
        string: true,
      },
      {
        name: "eventuallyConsistent",
        doc: "Update the index in the background after commit (default `false`).",
        values: ["true", "false"],
      },
    ],
  },
  {
    name: "unique",
    on: "model",
    doc: "A composite uniqueness constraint: no two nodes share the same values for all the fields (`@@unique([provider, accountId])`). Also a `findUnique` / `upsert` / `connect` key: `where: { provider_accountId: { provider, accountId } }`.",
    snippet: "unique([${1}])",
    args: [
      {
        name: "name",
        doc: "Constraint name and `where` key (default: `<Label>_<field>_…_unique` and `<field>_<field>…`).",
        string: true,
      },
    ],
  },
  {
    name: "labels",
    on: "model",
    doc: "Dynamic labels: flags a node may carry or not (`@@labels([Archived, Featured])`), added and removed with `data: { $labels: { add, remove } }`, filtered with `where: { $labels: { has } }` and read with `select: { $labels: true }`. Only the listed labels are accepted; they must not be a model's label.",
    snippet: "labels([${1}])",
  },
  {
    name: "index",
    on: "model",
    doc: "A composite range index over several fields of the node (`@@index([tenant, createdAt])`), for filters and sorts that use them together.",
    snippet: "index([${1}])",
    args: [
      {
        name: "name",
        doc: "Index name (default `<Label>_<field>_…_idx`).",
        string: true,
      },
    ],
  },
];

export function decoratorDoc(name: string, model = false): DecoratorDoc | undefined {
  return DECORATORS.find((d) => d.name === name && (d.on === "model") === model);
}

/** Markdown hover for a decorator or model attribute. */
export function decoratorMarkdown(d: DecoratorDoc): string {
  const sigil = d.on === "model" ? "@@" : "@";
  const args = d.args?.length
    ? `\n\n${d.args.map((a) => `- \`${a.name}\`: ${a.doc}`).join("\n")}`
    : "";
  const anchor =
    d.on === "model"
      ? d.name === "fulltext"
        ? "full-text-indexes"
        : d.name === "labels"
          ? "dynamic-labels"
          : "composite-constraints-and-indexes"
      : d.on === "vector"
        ? "vector-fields"
        : d.rule
          ? "validation-rules"
          : "decorators";
  return `**${sigil}${d.name}**\n\n${d.doc}${args}\n\n[Schema reference](${DOCS_URL}#${anchor})`;
}

export const DEFAULT_FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
  cuid: ["String"],
  uuid: ["String"],
  now: ["DateTime", "Date"],
};

export const KEYWORD_DOCS: Readonly<Record<string, string>> = {
  node: "`node Name { … }`: a node label with its properties and relations.",
  relationship:
    '`relationship Name { type "TYPE" from A to B … }`: typed properties of a relationship type between two nodes.',
  enum: "`enum Name { A B C }`: a closed set of string values, usable as a field type.",
  interface:
    "`interface Name { … }`: an abstract node model. Its label, fields, relations and constraints are shared by the nodes that implement it; `db.name` queries every implementation (results carry `__typename`), but an interface cannot be created.",
  union:
    "`union Name = A | B`: a type grouping unrelated nodes (an interface member stands for every node implementing it). It adds no label: relation fields and `relationship { … }` models may target it, `db.name` reads every member (`findMany`, `findFirst`, `count`; results carry `__typename`), and relation writes name the member (`connect: { A: { id } }`).",
  implements:
    "`node Name implements A, B { … }`: the node inherits the fields of interfaces `A` and `B` and carries their labels (`:Name:A:B`).",
  extends:
    "`interface Name extends A, B { … }`: the interface inherits the fields of interfaces `A` and `B` (and of the ones they extend); nodes implementing it carry all their labels (`:Node:Name:A:B`).",
};
