/**
 * @packageDocumentation
 * Test helpers for Cyphra: start Neo4j, Memgraph or FalkorDB with Testcontainers, apply the schema
 * and migrations, isolate tests (rollback or wipe) and build records with typed factories.
 */

export {
  DEFAULT_FALKORDB_GRAPH,
  TEST_ENV,
  connectionEnv,
  connectionFromEnv,
  hasTestDatabase,
  type TestConnection,
} from "./connection.js";
export {
  DEFAULT_IMAGES,
  DEFAULT_NEO4J_PASSWORD,
  startDatabase,
  waitUntilReady,
  type StartDatabaseOptions,
  type StartedTestDatabase,
} from "./container.js";
export {
  applySchema,
  dropSchema,
  loadMigrations,
  loadSchema,
  schemaStatements,
  type ApplySchemaOptions,
  type ApplySchemaResult,
  type ClientLike,
  type MigrationsInput,
  type SchemaInput,
} from "./schema.js";
export {
  wipeDatabase,
  withRollback,
  type TransactionalClient,
  type WipeOptions,
} from "./isolation.js";
export {
  defineFactory,
  factoriesFor,
  resetSequences,
  type CreatableModel,
  type Factory,
  type FactoryClient,
  type FactoryContext,
  type FactoryDefaults,
  type FactoryOverrides,
  type FactoryRecord,
} from "./factory.js";
export { createTestDatabase, type TestDatabase, type TestDatabaseOptions } from "./harness.js";
