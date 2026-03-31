import type { CompiledCypher } from "../../cypher.js";

export type CatalogEntryImplemented = {
  readonly status: "implemented";
  readonly id: string;
  /** Neo4j manual section or clause name for traceability */
  readonly manualSection: string;
  readonly compile: () => CompiledCypher;
  /** Expected query text after {@link normalizeCypher} */
  readonly expectedText: string;
  readonly expectedParams: Readonly<Record<string, unknown>>;
};

export type CatalogEntryPending = {
  readonly status: "pending";
  readonly id: string;
  readonly manualSection: string;
  readonly note: string;
};

export type CatalogEntry = CatalogEntryImplemented | CatalogEntryPending;
