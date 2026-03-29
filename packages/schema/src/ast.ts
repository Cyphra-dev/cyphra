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
};

export type RelationshipDeclaration = {
  readonly kind: "Relationship";
  readonly name: string;
  readonly relType: string;
  readonly from: string;
  readonly to: string;
  readonly fields: readonly ScalarNodeField[];
};

export type NodeField = ScalarNodeField | RelationalNodeField;

export type ScalarTypeName = "String" | "Int" | "Float" | "Boolean" | "DateTime";

export type ScalarTypeRef = {
  readonly name: ScalarTypeName;
  readonly optional: boolean;
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
  | { readonly kind: "identifier"; readonly value: string };
