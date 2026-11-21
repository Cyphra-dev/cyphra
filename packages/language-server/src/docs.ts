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
};

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
        : "composite-constraints-and-indexes"
      : d.on === "vector"
        ? "vector-fields"
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
};
