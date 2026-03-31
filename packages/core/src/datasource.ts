import type { GraphProviderId } from "./provider.js";

/**
 * Project-level datasource (Prisma-style). Stored in `cyphra.json` alongside paths.
 */
export type CyphraDatasourceConfig = {
  /** Graph database provider; defaults to {@link DEFAULT_GRAPH_PROVIDER}. */
  readonly provider: GraphProviderId;
};
