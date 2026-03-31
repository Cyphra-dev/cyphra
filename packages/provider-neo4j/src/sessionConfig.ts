import type { SessionConfig } from "neo4j-driver";
import type { CyphraNeo4j } from "./adapter.js";

/**
 * Merge {@link CyphraNeo4j} defaults (e.g. `database`) with per-session overrides.
 * Explicit `database` in `override` wins; otherwise the adapter’s `database` is applied when set.
 */
export function mergeSessionConfig(
  adapter: Pick<CyphraNeo4j, "database">,
  override?: SessionConfig,
): SessionConfig {
  const database = override?.database ?? adapter.database;
  return {
    ...override,
    ...(database !== undefined ? { database } : {}),
  };
}
