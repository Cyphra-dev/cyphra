/**
 * Path segments for static doc URLs under https://www.cyphra.dev
 * (empty string = home). Order matches the sidebar in `app/_meta.tsx`.
 */
export const SITEMAP_DOC_SEGMENTS = [
  "",
  "introduction",
  "getting-started",
  "configuration",
  "providers",
  "supported-databases",
  "schema",
  "introspection",
  "queries",
  "cypher-coverage",
  "graph-orm",
  "runtime",
  "migrations",
  "cli",
  "production",
  "governance",
  "example",
] as const;
