import { implementedCatalogEntries } from "./entries-implemented.js";
import { pendingCatalogEntries } from "./entries-pending.js";
import type { CatalogEntry } from "./types.js";

export type { CatalogEntry, CatalogEntryImplemented, CatalogEntryPending } from "./types.js";
export { implementedCatalogEntries } from "./entries-implemented.js";
export { pendingCatalogEntries } from "./entries-pending.js";

/** Full conformance backlog: implemented golden tests + pending DSL rows. */
export const catalogEntries: readonly CatalogEntry[] = [
  ...implementedCatalogEntries,
  ...pendingCatalogEntries,
];
