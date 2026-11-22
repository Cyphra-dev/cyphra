/**
 * @packageDocumentation
 * Cyphra migrations: defineMigration, runner, schema push, rename helpers, batch wrapper.
 */

export { wrapInTransactions } from "./batch.js";
export { defineMigration, type MigrationDefinition } from "./defineMigration.js";
export {
  createMigrationDb,
  type MigrationDb,
  type MigrationMigrateHelpers,
} from "./migrationDb.js";
export {
  constraintStatementsFromSchema,
  fulltextIndexStatementsFromSchema,
  indexStatementsFromSchema,
  vectorIndexStatementsFromSchema,
} from "./push.js";
export { compileRenameLabel, compileRenameProperty } from "./rename.js";
export { applyConstraintStatements, runPendingMigrations, type LoadedMigration } from "./runner.js";
export { schemaIntegrationHints } from "./schemaHints.js";
export {
  EMPTY_SCHEMA_MODEL,
  compoundIndexStatement,
  compoundUniqueStatement,
  ddlObjectsFromModel,
  diffSchemaModels,
  fulltextIndexStatement,
  vectorIndexStatement,
  isEmptyPlan,
  type DdlObject,
  type DdlOptions,
  type MigrationPlan,
  type MigrationStep,
} from "./diff.js";
export { renderMigrationSource, type RenderMigrationOptions } from "./renderMigration.js";
export {
  ENDPOINT_SAMPLE_SIZE,
  introspectDatabase,
  schemaFromIntrospection,
  type IntrospectedProperty,
  type IntrospectionResult,
} from "./introspect.js";
export {
  compareSchemaObjects,
  describeSchemaObject,
  detectDrift,
  expectedSchemaForDialect,
  expectedSchemaFromModel,
  expectedSchemaFromStatements,
  isDriftFree,
  parseDdlStatement,
  readSchemaObjects,
  replayMigrations,
  schemaObjectsFromShow,
  type ChangedSchemaObject,
  type DriftReport,
  type ParsedDdl,
  type SchemaObject,
  type SchemaOptionValue,
  type ShowRow,
} from "./drift.js";
export { listAppliedMigrations, type AppliedMigration } from "./tracker.js";
export {
  MEMGRAPH_VECTOR_CAPACITY,
  ddlForDialect,
  isMemgraphDdl,
  memgraphDdl,
  memgraphDropStatement,
  memgraphSchemaObjects,
  memgraphStatements,
  memgraphVectorMetric,
  parseMemgraphDdl,
  type ParsedMemgraphDdl,
} from "./memgraph.js";
export {
  dropAllFalkorDBSchema,
  falkordbDdl,
  falkordbDdlStatements,
  falkordbExecutable,
  falkordbSchemaObjects,
  falkordbStatements,
  falkordbVectorSimilarity,
  isFalkorDBDdl,
  normalizeFalkorDBObjects,
  parseFalkorDBDdl,
  readFalkorDBSchemaObjects,
  runFalkorDBDdl,
  type ParsedFalkorDBDdl,
} from "./falkordb.js";
export {
  CYPHRA_MIGRATION_LABEL,
  FALKORDB_MIGRATION_CONSTRAINT,
  ensureMigrationInfrastructure,
  isMigrationApplied,
  recordMigration,
} from "./tracker.js";
