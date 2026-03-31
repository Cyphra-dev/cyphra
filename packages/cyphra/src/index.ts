/**
 * Single entry for Cyphra: schema, queries, graph providers, runtime, and migrations.
 * Re-exports `@cyphra/core`, `@cyphra/schema`, `@cyphra/query`, `@cyphra/runtime`, and `@cyphra/migrator`.
 * Depends on `@cyphra/provider-neo4j` for the default Neo4j stack and `@cyphra/cli` for the `cyphra` binary.
 *
 * **`CyphraClient`** from this package includes a lazy **`.orm`** layer; **`@cyphra/runtime`** exposes the Bolt-only client.
 *
 * Namespaces **`query`** and **`orm`** group the Cypher-JS and ORM surfaces; subpaths **`cyphra/query`** and **`cyphra/orm`** mirror them for tree-shaking.
 *
 * @packageDocumentation
 */

import * as ormNamespace from "@cyphra/orm";
import * as queryNamespace from "@cyphra/query";

export * from "@cyphra/core";
export type { CyphraConfig } from "@cyphra/config";
export { coerceMigrationsPath, loadConfig, loadConfigSync } from "@cyphra/config";
export * from "@cyphra/schema";
export * from "@cyphra/query";
export type {
  CompiledGraphQuery,
  CyphraDatasourceConfig,
  CyphraDriverClient,
  CyphraManagedTransaction,
  CyphraSession,
  GraphProviderId,
} from "@cyphra/runtime";
export {
  assertGraphProviderId,
  DEFAULT_GRAPH_PROVIDER,
  GRAPH_PROVIDER_META,
  isGraphProviderId,
} from "@cyphra/runtime";
export {
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
} from "@cyphra/runtime";
export * from "@cyphra/orm";
export * from "@cyphra/migrator";

export { CyphraClient, type CyphraAppClientOptions } from "./appClient.js";

/** Cypher-JS / Drizzle-like compilers and builders (`query.select`, `query.cypher`, …). */
export const query = queryNamespace;
/** Schema-driven ORM (`orm.createSchemaClient`, `orm.createNodeCrud`, …). */
export const orm = ormNamespace;

export { loadCyphraWorkspace, type CyphraWorkspace } from "./workspace.js";
