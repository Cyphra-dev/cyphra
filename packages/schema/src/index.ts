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
  ParseSchemaOptions,
  RelationshipDeclaration,
  ScalarNodeField,
  ScalarTypeName,
  ScalarTypeRef,
  RelationalNodeField,
  SchemaComment,
  SchemaDocument,
  SourcePosition,
  SourceRange,
} from "./ast.js";
export { SchemaValidationError } from "./errors.js";
export {
  printSchemaDocument,
  formatDecorator,
  formatModelAttribute,
  quoteSchemaString,
} from "./printSchema.js";
export type { FormatSchemaOptions } from "./formatSchema.js";
export { formatSchema } from "./formatSchema.js";
export { MAX_SCHEMA_BYTES, parseSchema, parseSchemaSyntax } from "./parseSchema.js";
export { parseSchemaFile } from "./readSchemaFile.js";
export type { CodegenModel, RenderCyphraGenOptions, RuntimeTypeNames } from "./renderCyphraGen.js";
export {
  collectCodegenModel,
  relTypeToExportKey,
  renderClientSection,
  renderCyphraGenSource,
  runtimeTypeImports,
} from "./renderCyphraGen.js";
export type {
  DurationParts,
  IsoTemporalType,
  LocalDateTimeParts,
  LocalTimeParts,
  TimeParts,
} from "./temporal.js";
export {
  TEMPORAL_EXAMPLES,
  formatDuration,
  formatLocalDateTime,
  formatLocalTime,
  formatTime,
  isValidTemporalText,
  parseDuration,
  parseLocalDateTime,
  parseLocalTime,
  parseTime,
} from "./temporal.js";
export {
  DEFAULT_FULLTEXT_ANALYZER,
  FULLTEXT_ANALYZERS,
  MAX_VECTOR_DIMENSIONS,
  SCALAR_TYPE_NAMES,
  VECTOR_SIMILARITIES,
  validateSchema,
} from "./validate.js";
export type {
  DefaultFunction,
  DefaultValueSpec,
  OnDeleteRule,
  RelationDirection,
  ResolvedField,
  ResolvedCompoundIndex,
  ResolvedCompoundUnique,
  ResolvedFulltextIndex,
  ResolvedNodeModel,
  ResolvedRelationField,
  ResolvedRelationshipModel,
  ResolvedScalarField,
  ResolvedVectorIndex,
  SchemaModel,
  VectorSimilarity,
} from "./model.js";
export type { RuleField, RuleViolation, ValidationRule, ValidationRuleName } from "./rules.js";
export {
  REGEX_FLAGS,
  RULE_POSITIONAL_ARGS,
  VALIDATION_RULES,
  checkRules,
  formatRule,
  isRuleDecorator,
  listRequiresElements,
} from "./rules.js";
export { ON_DELETE_RULES, SCHEMA_MODEL_VERSION, getNodeModel, resolveSchema } from "./model.js";
