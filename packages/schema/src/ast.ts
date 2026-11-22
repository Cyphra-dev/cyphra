/**
 * Discriminated AST for parsed `.cyphra` schema documents.
 *
 * @packageDocumentation
 */

/** A point in the source text: `offset` is 0-based, `line` and `column` are 1-based (Peggy). */
export type SourcePosition = {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
};

/**
 * A source range, end exclusive. Present on AST nodes only when parsing with
 * `{ locations: true }` (see {@link ParseSchemaOptions}).
 */
export type SourceRange = {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
};

/** A `// …` line comment (recorded only when parsing with `{ locations: true }`). */
export type SchemaComment = {
  /** The comment text, `//` included. */
  readonly text: string;
  readonly loc: SourceRange;
};

/** Options of {@link parseSchemaSyntax} and `parseSchema`. */
export type ParseSchemaOptions = {
  /**
   * Record source ranges (`loc`, `nameLoc`, …) on AST nodes and the document's comments, for
   * editor tooling. Off by default, so the AST carries no positions.
   */
  readonly locations?: boolean;
};

/** Root document produced by the parser (before semantic validation). */
export type SchemaDocument = {
  readonly kind: "Document";
  readonly declarations: readonly Declaration[];
  /** Line comments in source order (only with `{ locations: true }`). */
  readonly comments?: readonly SchemaComment[];
};

export type Declaration =
  NodeDeclaration | RelationshipDeclaration | EnumDeclaration | UnionDeclaration;

/**
 * `union SearchHit = Post | User`: a type grouping unrelated node models. It adds no label: relation
 * fields may target it, and queries through it return its members.
 */
export type UnionDeclaration = {
  readonly kind: "Union";
  readonly name: string;
  /** Member node models, in declaration order. */
  readonly members: readonly string[];
  readonly loc?: SourceRange;
  readonly nameLoc?: SourceRange;
  /** Range of each member name, parallel to `members`. */
  readonly memberLocs?: readonly SourceRange[];
};

/** `enum Role { ADMIN USER }`: a closed set of string values. */
export type EnumDeclaration = {
  readonly kind: "Enum";
  readonly name: string;
  /** Values in declaration order. */
  readonly values: readonly string[];
  readonly loc?: SourceRange;
  readonly nameLoc?: SourceRange;
  /** Range of each value, parallel to `values`. */
  readonly valueLocs?: readonly SourceRange[];
};

/**
 * `node X { … }`, `node X implements A, B { … }`, `interface A { … }` (`abstract: true`): an
 * abstract node model whose label and fields its implementations share, or
 * `interface B extends A { … }`: an interface that inherits another's fields and label.
 */
export type NodeDeclaration = {
  readonly kind: "Node";
  readonly name: string;
  /** `true` for an `interface` declaration (absent for a `node`). */
  readonly abstract?: true;
  /** Interfaces named after `implements`, in order (absent when there is no `implements`). */
  readonly implements?: readonly string[];
  /** Interfaces named after `extends` on an interface, in order (absent when there is none). */
  readonly extends?: readonly string[];
  readonly fields: readonly NodeField[];
  /** Model-level `@@…` attributes (absent when the model has none). */
  readonly attributes?: readonly ModelAttribute[];
  readonly loc?: SourceRange;
  readonly nameLoc?: SourceRange;
  /** Range of each name in `implements`, parallel to it. */
  readonly implementsLocs?: readonly SourceRange[];
  /** Range of each name in `extends`, parallel to it. */
  readonly extendsLocs?: readonly SourceRange[];
};

export type RelationshipDeclaration = {
  readonly kind: "Relationship";
  readonly name: string;
  readonly relType: string;
  readonly from: string;
  readonly to: string;
  readonly fields: readonly ScalarNodeField[];
  /** Model-level `@@…` attributes (absent when the model has none). */
  readonly attributes?: readonly ModelAttribute[];
  readonly loc?: SourceRange;
  readonly nameLoc?: SourceRange;
  /** Range of the `type "…"` string literal. */
  readonly relTypeLoc?: SourceRange;
  readonly fromLoc?: SourceRange;
  readonly toLoc?: SourceRange;
};

export type NodeField = ScalarNodeField | RelationalNodeField;

export type ScalarTypeName =
  | "String"
  | "Int"
  | "Float"
  | "Boolean"
  | "DateTime"
  | "Date"
  /** 64-bit integer: a Neo4j `INTEGER`, a JS `bigint`. */
  | "BigInt"
  /** Any JSON value, stored as its JSON text (a string property). */
  | "Json"
  /** Date and time without a time zone: a Neo4j `LOCAL DATETIME`, an ISO 8601 string in JS. */
  | "LocalDateTime"
  /** Time of day without a time zone: a Neo4j `LOCAL TIME`, an ISO 8601 string in JS. */
  | "LocalTime"
  /** Time of day with a UTC offset: a Neo4j `ZONED TIME`, an ISO 8601 string in JS. */
  | "Time"
  /** An amount of time (months, days, seconds): a Neo4j `DURATION`, an ISO 8601 string in JS. */
  | "Duration"
  /** A WGS-84 geographic point (`srid` 4326, or 4979 with a height): `{ longitude, latitude, height? }`. */
  | "Point"
  /** A Cartesian point (`srid` 7203, or 9157 with `z`): `{ x, y, z? }`. */
  | "CartesianPoint"
  /** `Vector(N)`: an embedding of `N` floats, stored as `LIST<FLOAT>`. */
  | "Vector"
  /** A value of a declared `enum` (named by `enum`), stored as a string. */
  | "Enum";

export type ScalarTypeRef = {
  readonly name: ScalarTypeName;
  readonly optional: boolean;
  /** `String[]`-style scalar list (lists are never optional; an absent list reads as `[]`). */
  readonly list?: boolean;
  /** Number of dimensions of a `Vector(N)` type (only set when `name` is `"Vector"`). */
  readonly dimensions?: number;
  /** Name of the `enum` declaration (only set when `name` is `"Enum"`). */
  readonly enum?: string;
};

export type ScalarNodeField = {
  readonly kind: "Scalar";
  readonly name: string;
  readonly type: ScalarTypeRef;
  readonly decorators: readonly Decorator[];
  /** The whole field line (name to last decorator). */
  readonly loc?: SourceRange;
  readonly nameLoc?: SourceRange;
  /** The type expression (name plus any `(N)`, `?` or `[]`). */
  readonly typeLoc?: SourceRange;
};

export type RelationalNodeField = {
  readonly kind: "Relational";
  readonly name: string;
  readonly target: string;
  readonly cardinality: "one" | "many";
  readonly optional: boolean;
  readonly decorators: readonly Decorator[];
  readonly loc?: SourceRange;
  readonly nameLoc?: SourceRange;
  /** The type expression (target name plus any `?` or `[]`). */
  readonly typeLoc?: SourceRange;
};

/** Parsed decorator such as `@id` or `@relationship(type: "X", direction: OUT)`. */
export type Decorator = {
  readonly name: string;
  readonly args: readonly DecoratorArg[];
  readonly loc?: SourceRange;
};

export type DecoratorArg = {
  readonly key: string;
  readonly value: DecoratorValue;
  readonly loc?: SourceRange;
  /** The `key` identifier (absent for the implicit argument of `@default(…)`). */
  readonly keyLoc?: SourceRange;
  readonly valueLoc?: SourceRange;
};

export type DecoratorValue =
  | { readonly kind: "string"; readonly value: string }
  | {
      readonly kind: "number";
      readonly value: number;
      /** Exact digits of an integer literal beyond `Number.MAX_SAFE_INTEGER` (for BigInt). */
      readonly raw?: string;
    }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "identifier"; readonly value: string };

/**
 * Parsed model-level attribute such as `@@fulltext([title, body], name: "postSearch")`: a name, an
 * optional leading list of the model's field names, and named arguments.
 */
export type ModelAttribute = {
  readonly kind: "ModelAttribute";
  readonly name: string;
  /** Field names of the leading `[a, b]` list (absent when the attribute has no list). */
  readonly fields?: readonly string[];
  readonly args: readonly DecoratorArg[];
  readonly loc?: SourceRange;
  /** Range of each name in `fields`. */
  readonly fieldLocs?: readonly SourceRange[];
};
