/**
 * @packageDocumentation
 * Execute Cyphra queries against Neo4j with `neo4j-driver`.
 */

export {
  CyphraClient,
  type CyphraClientOptions,
  type CyphraConnectionOptions,
  type CyphraDriverOptions,
  type DriverLike,
  type SessionLike,
  type TransactionLike,
} from "./client.js";
export type { Config, Driver, ManagedTransaction, Session } from "./client.js";
export { toPlainRecord, toPlainRecords } from "./records.js";
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
