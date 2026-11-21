/**
 * @packageDocumentation
 * Language server for Cyphra `.cyphra` schema files: diagnostics, completion, hover, go to
 * definition, references, rename, outline and formatting. Run `cyphra-language-server --stdio`
 * from any LSP client, or call {@link startServer}. The analysis functions are exported for
 * editor integrations that do not speak LSP.
 */
export { analyze, locateValidationError } from "./analysis.js";
export type { Analysis, SchemaProblem, Span } from "./analysis.js";
export { completionsAt } from "./completion.js";
export type { Completion, CompletionKind } from "./completion.js";
export { hoverAt } from "./hover.js";
export type { HoverResult } from "./hover.js";
export { formatText, outline } from "./outline.js";
export type { OutlineKind, OutlineSymbol } from "./outline.js";
export { DIAGNOSTIC_SOURCE, startServer } from "./server.js";
export { definitionAt, occurrences, referencesAt, renameEdits, renameTargetAt } from "./symbols.js";
export type { Occurrence } from "./symbols.js";
export { tokenize } from "./lexer.js";
