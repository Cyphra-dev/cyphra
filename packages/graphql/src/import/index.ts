/**
 * `@neo4j/graphql` v7 type definitions to Cyphra schema. Self-contained (no CLI or file system
 * code): used by `cyphra import graphql` and by `@cyphra/graphql` to derive the Cyphra schema model.
 *
 * @packageDocumentation
 */

export {
  GraphQLImportError,
  convertGraphQLTypeDefs,
  type GraphQLImportOptions,
  type GraphQLImportResult,
  type GraphQLSource,
} from "./convert.js";
export type { UniquenessConstraint } from "./constraints.js";
export type { ImportIssue, ImportSeverity } from "./mappings.js";
export { formatImportReport, mergeImportedSchema, printImportedSchema } from "./print.js";
