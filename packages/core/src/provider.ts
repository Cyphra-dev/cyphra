/**
 * Built-in graph database providers. New providers extend this union as implementations ship.
 */
export type GraphProviderId = "neo4j";

/** Default when `cyphra.json` omits `provider`. */
export const DEFAULT_GRAPH_PROVIDER: GraphProviderId = "neo4j";

/** Metadata for docs, CLI messages, and future generator wiring (Prisma-style datasource). */
export const GRAPH_PROVIDER_META: Record<
  GraphProviderId,
  { label: string; queryDialect: "cypher"; npmDriverHint: string }
> = {
  neo4j: {
    label: "Neo4j",
    queryDialect: "cypher",
    npmDriverHint: "neo4j-driver",
  },
};

export function isGraphProviderId(value: string): value is GraphProviderId {
  return value === "neo4j";
}

export function assertGraphProviderId(value: string): GraphProviderId {
  if (!isGraphProviderId(value)) {
    throw new Error(
      `Unknown Cyphra graph provider "${value}". Supported: ${Object.keys(GRAPH_PROVIDER_META).join(", ")}`,
    );
  }
  return value;
}
