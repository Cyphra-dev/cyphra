/**
 * @packageDocumentation
 * Execute Cyphra queries against Neo4j with `neo4j-driver` (Bolt) or the Neo4j Query API (HTTP,
 * for edge runtimes), against Memgraph (Bolt), or against FalkorDB (the Redis protocol, with the
 * optional `falkordb` package).
 */

export {
  CyphraClient,
  type CyphraClientOptions,
  type CyphraConnectionOptions,
  type CyphraDriverOptions,
  type CyphraFalkorDBOptions,
  type CyphraHttpOptions,
  type CyphraTransport,
  type DriverLike,
  type SessionLike,
  type TransactionLike,
} from "./client.js";
export type { Config, Driver, ManagedTransaction, Session } from "./client.js";
export { toPlainRecord, toPlainRecords } from "./records.js";
export {
  DIALECTS,
  detectDialect,
  dialectFromServerAgent,
  dialectName,
  parseDialect,
  unsupportedOnFalkorDB,
  type CyphraDialect,
} from "./dialect.js";
export {
  HttpDriver,
  HttpRecord,
  HttpSession,
  HttpTransaction,
  Neo4jHttpError,
  basicAuth,
  type FetchLike,
  type HttpDriverConfig,
  type HttpPlan,
  type HttpResult,
} from "./http/driver.js";
export { decodeTyped, encodeParameters, encodeTyped, type TypedValue } from "./http/codec.js";
export {
  FalkorDBDriver,
  FalkorDBError,
  FalkorDBSession,
  FalkorDBTransaction,
  parseConstraintCommand,
  type FalkorDBClientLike,
  type FalkorDBConnectionOptions,
  type FalkorDBGraphLike,
  type FalkorDBReply,
  type FalkorDBResult,
} from "./falkordb/driver.js";
export { rewriteForFalkorDB } from "./falkordb/rewrite.js";
export { paramsHeader as falkordbParamsHeader } from "./falkordb/codec.js";
export {
  CypherDate,
  CypherDateTime,
  CypherDuration,
  CypherInteger,
  CypherLocalDateTime,
  CypherLocalTime,
  CypherNode,
  CypherPath,
  CypherPathSegment,
  CypherPoint,
  CypherRelationship,
  CypherTime,
  int,
} from "./cypher-values.js";
export {
  Instrumentation,
  findUnindexedFilters,
  redactParams,
  type CyphraEvent,
  type ErrorEvent,
  type LogLevel,
  type ObservabilityOptions,
  type QueryEvent,
  type QueryMeta,
  type ScanFinding,
  type SpanLike,
  type TracerLike,
  type WarnEvent,
} from "./observability.js";
export * from "./orm/index.js";
export type { SchemaModel } from "@cyphra/schema";
