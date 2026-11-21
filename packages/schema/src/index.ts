/**
 * @packageDocumentation
 * Cyphra schema DSL: parse `.cyphra` files into a typed AST.
 */

export type {
  Decorator,
  DecoratorArg,
  DecoratorValue,
  Declaration,
  EnumDeclaration,
  ModelAttribute,
  NodeDeclaration,
  NodeField,
  RelationshipDeclaration,
  ScalarNodeField,
  ScalarTypeName,
  ScalarTypeRef,
  RelationalNodeField,
  SchemaDocument,
} from "./ast.js";
export { SchemaValidationError } from "./errors.js";
export { printSchemaDocument, formatDecorator, formatModelAttribute } from "./printSchema.js";
export { MAX_SCHEMA_BYTES, parseSchema } from "./parseSchema.js";
export { parseSchemaFile } from "./readSchemaFile.js";
export type { CodegenModel, RenderCyphraGenOptions } from "./renderCyphraGen.js";
export {
  collectCodegenModel,
  relTypeToExportKey,
  renderClientSection,
  renderCyphraGenSource,
} from "./renderCyphraGen.js";
export {
  DEFAULT_FULLTEXT_ANALYZER,
  FULLTEXT_ANALYZERS,
  MAX_VECTOR_DIMENSIONS,
  VECTOR_SIMILARITIES,
  validateSchema,
} from "./validate.js";
export type {
  DefaultFunction,
  DefaultValueSpec,
  RelationDirection,
  ResolvedField,
  ResolvedFulltextIndex,
  ResolvedNodeModel,
  ResolvedRelationField,
  ResolvedRelationshipModel,
  ResolvedScalarField,
  ResolvedVectorIndex,
  SchemaModel,
  VectorSimilarity,
} from "./model.js";
export { SCHEMA_MODEL_VERSION, getNodeModel, resolveSchema } from "./model.js";
