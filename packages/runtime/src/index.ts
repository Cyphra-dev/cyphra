/**
 * @packageDocumentation
 * Execute Cyphra queries against Neo4j with `neo4j-driver` (Bolt) or the Neo4j Query API (HTTP,
 * for edge runtimes).
 */

export {
  CyphraClient,
  type CyphraClientOptions,
  type CyphraConnectionOptions,
  type CyphraDriverOptions,
  type CyphraHttpOptions,
  type CyphraTransport,
  type DriverLike,
  type SessionLike,
  type TransactionLike,
} from "./client.js";
export type { Config, Driver, ManagedTransaction, Session } from "./client.js";
export { toPlainRecord, toPlainRecords } from "./records.js";
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
