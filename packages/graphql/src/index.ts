/**
 * GraphQL for Neo4j on the Cyphra runtime.
 *
 * `compat.v7` serves the API `@neo4j/graphql` v7 generates from the same type definitions, so
 * frontends can switch without changing their queries. `native` serves the Cyphra-native API,
 * generated from `schema.cyphra` (experimental).
 *
 * @packageDocumentation
 */

import * as v7 from "./v7/index.js";
import * as nativeApi from "./native/index.js";

export const compat = { v7 } as const;

/**
 * The Cyphra-native API (`native.makeSchema`, `native.printSchema`, `native.defineGraphQL`),
 * generated from `schema.cyphra` and served by the typed client.
 *
 * @experimental
 */
export const native = nativeApi;

export {
  defineGraphQL,
  NativeSchemaError,
  type FieldToggle,
  type GraphQLConfig,
  type Limits,
  type ModelConfig,
  type NativeMakeSchemaOptions,
  type OperationToggles,
  type ReadOperation,
  type RootOperation,
  type WriteOperation,
} from "./native/index.js";

export type {
  AuthorizationFeature,
  CDCEngineOptions,
  CheckTypeDefsOptions,
  TypeDefsIssue,
  TypeDefsIssueCode,
  TypeDefsIssueLocation,
  TypeDefsSource,
  Features,
  JwtKey,
  MakeSchemaOptions,
  Resolvers,
  SubscriptionsFeature,
} from "./v7/index.js";
export { CDCSubscriptionsEngine } from "./v7/index.js";
export { formatIssueLocation, UnsupportedTypeDefsError } from "./v7/model.js";

export {
  GraphQLImportError,
  convertGraphQLTypeDefs,
  formatImportReport,
  mergeImportedSchema,
  printImportedSchema,
  type GraphQLImportOptions,
  type GraphQLImportResult,
  type GraphQLSource,
  type ImportIssue,
  type ImportSeverity,
  type UniquenessConstraint,
} from "./import/index.js";
