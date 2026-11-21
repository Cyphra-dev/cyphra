/**
 * GraphQL for Neo4j on the Cyphra runtime.
 *
 * `compat.v7` serves the API `@neo4j/graphql` v7 generates from the same type definitions, so
 * frontends can switch without changing their queries.
 *
 * @packageDocumentation
 */

import * as v7 from "./v7/index.js";

export const compat = { v7 } as const;

export type { AuthorizationFeature, Features, JwtKey, MakeSchemaOptions } from "./v7/index.js";
export { UnsupportedTypeDefsError } from "./v7/model.js";

export {
  GraphQLImportError,
  convertGraphQLTypeDefs,
  formatImportReport,
  mergeImportedSchema,
  printImportedSchema,
  type GraphQLImportResult,
  type GraphQLSource,
  type ImportIssue,
  type ImportSeverity,
} from "./import/index.js";
