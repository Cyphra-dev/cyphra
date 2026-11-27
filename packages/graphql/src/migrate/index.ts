/**
 * Migration tooling from `compat.v7` to the native API: the operation codemod
 * (`translateDocument`), the dual-run comparison (`compareResults`) and the rules drafter
 * (`draftRules`), behind `cyphra graphql migrate-operations`, `compare` and `migrate-rules`.
 *
 * @experimental
 * @packageDocumentation
 */

export {
  createMigrationContext,
  MigrationContext,
  type MigrationContextOptions,
} from "./context.js";
export {
  position,
  translateDocument,
  Unmapped,
  type DefinitionTranslation,
  type DocumentStatus,
  type DocumentTranslation,
  type TranslateOptions,
} from "./operations.js";
export {
  compareResults,
  type CompareOptions,
  type GraphQLResultLike,
  type ResultDifference,
} from "./compare.js";
export {
  draftRules,
  type DraftRulesOptions,
  type RuleDraftEntry,
  type RuleDraftStatus,
  type RulesDraft,
} from "./rules.js";
export type { IssueKind, MigrationIssue } from "./where.js";
