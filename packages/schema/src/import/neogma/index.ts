/**
 * neogma models to Cyphra schema: used by `cyphra import neogma`. Reads the model files statically
 * with the TypeScript compiler API, which the caller passes in (no neogma dependency, no file
 * system, no code run).
 *
 * @packageDocumentation
 */

import type { ImportIssue } from "../print.js";
import { formatImportIssues, mergeImportResult, printImportResult } from "../print.js";
import type { NeogmaImportResult } from "./convert.js";

export {
  convertNeogmaModels,
  convertNeogmaSchema,
  type NeogmaImportOptions,
  type NeogmaImportResult,
} from "./convert.js";
export { NeogmaImportError, parseNeogmaSources } from "./parse.js";
export type {
  NeogmaAnnotation,
  NeogmaMember,
  NeogmaModel,
  NeogmaProperty,
  NeogmaRelationship,
  NeogmaSchema,
  NeogmaSource,
  NeogmaValue,
  TypeScriptApi,
} from "./parse.js";

const HEADER = "// Imported from neogma models with `cyphra import neogma`.";

/** The imported schema as a new `.cyphra` file (see {@link convertNeogmaModels}). */
export function printNeogmaImport(result: NeogmaImportResult): string {
  return printImportResult(result, { header: HEADER });
}

/**
 * Merge the imported schema into an existing `.cyphra` source, keeping its declarations, fields
 * and comments (see {@link mergeImportResult}).
 */
export function mergeNeogmaImport(
  existing: string,
  result: NeogmaImportResult,
): { source: string; issues: ImportIssue[] } {
  return mergeImportResult(existing, result, { header: HEADER });
}

/** The import report as plain text, grouped by severity (empty when there is nothing to report). */
export function formatNeogmaImportReport(issues: readonly ImportIssue[]): string {
  return formatImportIssues(issues);
}
