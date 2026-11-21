/**
 * Discriminated AST for parsed `.cyphra` schema documents.
 *
 * @packageDocumentation
 */

/** Root document produced by the parser (before semantic validation). */
export type SchemaDocument = {
  readonly kind: "Document";
  readonly declarations: readonly Declaration[];
};

export type Declaration = NodeDeclaration | RelationshipDeclaration;

export type NodeDeclaration = {
  readonly kind: "Node";
  readonly name: string;
  readonly fields: readonly NodeField[];
  /** Model-level `@@…` attributes (absent when the model has none). */
  readonly attributes?: readonly ModelAttribute[];
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
};

export type NodeField = ScalarNodeField | RelationalNodeField;

export type ScalarTypeName =
  | "String"
  | "Int"
  | "Float"
  | "Boolean"
  | "DateTime"
  | "Date"
  /** `Vector(N)`: an embedding of `N` floats, stored as `LIST<FLOAT>`. */
  | "Vector";

export type ScalarTypeRef = {
  readonly name: ScalarTypeName;
  readonly optional: boolean;
  /** `String[]`-style scalar list (lists are never optional; an absent list reads as `[]`). */
  readonly list?: boolean;
  /** Number of dimensions of a `Vector(N)` type (only set when `name` is `"Vector"`). */
  readonly dimensions?: number;
};

export type ScalarNodeField = {
  readonly kind: "Scalar";
  readonly name: string;
  readonly type: ScalarTypeRef;
  readonly decorators: readonly Decorator[];
};

export type RelationalNodeField = {
  readonly kind: "Relational";
  readonly name: string;
  readonly target: string;
  readonly cardinality: "one" | "many";
  readonly optional: boolean;
  readonly decorators: readonly Decorator[];
};

/** Parsed decorator such as `@id` or `@relationship(type: "X", direction: OUT)`. */
export type Decorator = {
  readonly name: string;
  readonly args: readonly DecoratorArg[];
};

export type DecoratorArg = {
  readonly key: string;
  readonly value: DecoratorValue;
};

export type DecoratorValue =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
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
};
