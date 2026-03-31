import type { GraphProviderId } from "./provider.js";

/**
 * Optional Prisma-style datasource block in `cyphra.config.ts` (connection hints, provider).
 * Secrets often use `process.env.*`; runtime wiring may still use env vars in app code.
 */
export type CyphraConfigDatasource = {
  readonly provider: GraphProviderId;
  readonly url?: string;
  readonly uri?: string;
  readonly user?: string;
  readonly password?: string;
  readonly database?: string;
};

/**
 * Shape of `cyphra.config.ts` / `defineCyphraConfig(...)`.
 * Paths are relative to the config file directory (resolved at load time).
 */
export type CyphraUserConfig = {
  /** Path to `.cyphra` schema file, e.g. `"./schema.cyphra"`. */
  readonly schema: string;
  /** Migrations directory as a path string or `{ path }` (Prisma-like). */
  readonly migrations: string | { readonly path: string };
  readonly provider?: GraphProviderId;
  /** When `provider` is omitted, `datasource.provider` is used (Prisma-like). */
  readonly datasource?: CyphraConfigDatasource;
  /** Neo4j server / Cypher dialect hint for docs and future emit (optional). */
  readonly targetNeo4j?: string;
};

/**
 * Type helper for `cyphra.config.ts` (similar to `defineConfig` in Vite / Drizzle).
 */
export function defineCyphraConfig<const C extends CyphraUserConfig>(config: C): C {
  return config;
}
