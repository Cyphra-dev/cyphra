/**
 * Default Cyphra **runtime** entry: re-exports graph **provider contracts** from `@cyphra/core`
 * and the **Neo4j** driver implementation from `@cyphra/provider-neo4j`.
 *
 * @packageDocumentation
 */

export type {
  CompiledGraphQuery,
  CyphraDatasourceConfig,
  CyphraDriverClient,
  CyphraManagedTransaction,
  CyphraSession,
  GraphProviderId,
} from "@cyphra/core";
export {
  assertGraphProviderId,
  DEFAULT_GRAPH_PROVIDER,
  GRAPH_PROVIDER_META,
  isGraphProviderId,
} from "@cyphra/core";
export {
  CyphraClient,
  CyphraNeo4j,
  type CyphraClientAdapterOptions,
  type CyphraClientLegacyOptions,
  type CyphraClientOptions,
  type CyphraQueryInfo,
  type CyphraRunCompiledOptions,
  type CyphraNeo4jConnectOptions,
  type CyphraNeo4jDriverOptions,
  type CyphraNeo4jOptions,
  eagerResultToPlainRecords,
  mergeSessionConfig,
  NEO4J_DRIVER_ADAPTER_COVERAGE,
  type Neo4jDriverCoverageRow,
  type Neo4jDriverCoverageSupport,
  toPlainRecord,
  toPlainRecords,
  type Config,
  type Driver,
  type EagerResult,
  type ManagedTransaction,
  type QueryConfig,
  type Session,
  type SessionConfig,
} from "@cyphra/provider-neo4j";
