/**
 * Print a {@link GraphQLImportResult} as `.cyphra` source, merge it into an existing schema, and
 * format the import report. The printing itself is shared with the other importers
 * (`@cyphra/schema`); this module adds the GraphQL header and section titles.
 *
 * @packageDocumentation
 */

import { formatImportIssues, mergeImportResult, printImportResult } from "@cyphra/schema";
import type { GraphQLImportResult } from "./convert.js";
import type { ImportIssue } from "./mappings.js";

const HEADER = "// Imported from @neo4j/graphql type definitions with `cyphra import graphql`.";

/**
 * The imported schema as a new `.cyphra` file.
 *
 * @param result - Output of {@link convertGraphQLTypeDefs}.
 */
export function printImportedSchema(result: GraphQLImportResult): string {
  return printImportResult(result, { header: HEADER });
}

/**
 * Merge the imported schema into an existing `.cyphra` source.
 *
 * Existing declarations, fields and comments are kept as written. Fields the existing nodes lack
 * are added at the end of their block; new nodes and relationships are appended. When a field or
 * relationship exists on both sides with a different definition, the existing one wins and an
 * issue says so.
 *
 * @returns The merged source and the extra issues the merge produced.
 * @throws When the existing source does not parse, or the merged schema does not resolve.
 */
export function mergeImportedSchema(
  existing: string,
  result: GraphQLImportResult,
): { source: string; issues: ImportIssue[] } {
  return mergeImportResult(existing, result, { header: HEADER });
}

/**
 * The import report as plain text, grouped by severity. Empty string when there is nothing to
 * report.
 */
export function formatImportReport(issues: readonly ImportIssue[]): string {
  return formatImportIssues(issues, { ignoredTitle: "Ignored (GraphQL API only)" });
}
