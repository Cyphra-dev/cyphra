/**
 * @packageDocumentation
 * Better Auth database adapter for Neo4j, built on the Cyphra ORM: auth data and your own models
 * live in one typed graph, with one schema and one migration system.
 */

export { cyphraAdapter, type CyphraAdapterConfig } from "./adapter.js";
export { authSchema, type AuthSchemaOptions } from "./options.js";
export { neo4jBetterAuthMigration } from "./legacy.js";
export { mergeAuthSchema } from "./merge.js";
export {
  deriveAuthGraph,
  type AuthGraph,
  type DeriveAuthGraphOptions,
  type FieldMapping,
  type ForeignKeyMapping,
  type ModelMapping,
  type NumberFields,
  type NumberKind,
  type OnDelete,
  type ScalarMapping,
  type SchemaNaming,
} from "./schema.js";
