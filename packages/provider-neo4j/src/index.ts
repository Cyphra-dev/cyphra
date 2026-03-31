/**
 * Neo4j graph provider for Cyphra (Bolt + `neo4j-driver`).
 *
 * @packageDocumentation
 */

export {
  CyphraClient,
  type CyphraClientAdapterOptions,
  type CyphraClientLegacyOptions,
  type CyphraClientOptions,
  type CyphraQueryInfo,
  type CyphraRunCompiledOptions,
} from "./client.js";
export {
  CyphraNeo4j,
  type CyphraNeo4jConnectOptions,
  type CyphraNeo4jDriverOptions,
  type CyphraNeo4jOptions,
} from "./adapter.js";
export {
  eagerResultToPlainRecords,
  toPlainRecord,
  toPlainRecords,
} from "./records.js";
export { mergeSessionConfig } from "./sessionConfig.js";
export {
  NEO4J_DRIVER_ADAPTER_COVERAGE,
  type Neo4jDriverCoverageRow,
  type Neo4jDriverCoverageSupport,
} from "./neo4jDriverCoverage.js";
export type {
  Config,
  Driver,
  EagerResult,
  ManagedTransaction,
  QueryConfig,
  Session,
  SessionConfig,
} from "neo4j-driver";
