/**
 * @packageDocumentation
 * Shared **graph provider** identifiers and **driver contracts** for Cyphra.
 * Database-specific code lives in packages such as `@cyphra/provider-neo4j`.
 */

export type { CompiledGraphQuery } from "./compiled.js";
export type { CyphraDatasourceConfig } from "./datasource.js";
export type { CyphraDriverClient } from "./driver.js";
export {
  assertGraphProviderId,
  DEFAULT_GRAPH_PROVIDER,
  GRAPH_PROVIDER_META,
  type GraphProviderId,
  isGraphProviderId,
} from "./provider.js";
export type { CyphraManagedTransaction, CyphraSession } from "./session.js";
export {
  defineCyphraConfig,
  type CyphraConfigDatasource,
  type CyphraUserConfig,
} from "./cyphraUserConfig.js";
