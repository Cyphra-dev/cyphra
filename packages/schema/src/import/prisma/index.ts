/**
 * Prisma schema to Cyphra schema: used by `cyphra import prisma`. Self-contained (no Prisma
 * dependency, no file system).
 *
 * @packageDocumentation
 */

import type { ImportIssue } from "../print.js";
import { formatImportIssues, mergeImportResult, printImportResult } from "../print.js";
import type { PrismaImportResult } from "./convert.js";

export { convertPrismaSchema, type PrismaImportResult, type PrismaSource } from "./convert.js";
export { PrismaImportError, parsePrismaSchema } from "./parse.js";
export type {
  PrismaArg,
  PrismaAttribute,
  PrismaBlock,
  PrismaConfigBlock,
  PrismaEnum,
  PrismaField,
  PrismaModel,
  PrismaSchema,
  PrismaValue,
} from "./parse.js";

const HEADER = "// Imported from a Prisma schema with `cyphra import prisma`.";

/** The imported schema as a new `.cyphra` file (see {@link convertPrismaSchema}). */
export function printPrismaImport(result: PrismaImportResult): string {
  return printImportResult(result, { header: HEADER });
}

/**
 * Merge the imported schema into an existing `.cyphra` source, keeping its declarations, fields
 * and comments (see {@link mergeImportResult}).
 */
export function mergePrismaImport(
  existing: string,
  result: PrismaImportResult,
): { source: string; issues: ImportIssue[] } {
  return mergeImportResult(existing, result, { header: HEADER });
}

/** The import report as plain text, grouped by severity (empty when there is nothing to report). */
export function formatPrismaImportReport(issues: readonly ImportIssue[]): string {
  return formatImportIssues(issues, { ignoredTitle: "Ignored (no effect on the graph)" });
}
