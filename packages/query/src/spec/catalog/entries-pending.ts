import type { CatalogEntryPending } from "./types.js";

/**
 * Reserved conformance IDs for Cypher Manual capabilities not yet emitted by the typed DSL.
 * Each row maps 1:1 to a skipped test until TDD implements the DSL surface.
 */
export const pendingCatalogEntries: readonly CatalogEntryPending[] = [];
