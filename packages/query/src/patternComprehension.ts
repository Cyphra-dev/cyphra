import { compileWhereFragment, type WherePredicate } from "./builder.js";
import type { CompiledCypher } from "./cypher.js";

export type PatternComprehensionOptions = {
  /**
   * Pattern body only (no surrounding brackets), e.g. **`(n:N)-[:R]->(m:M)`**.
   * Must be trusted Cypher; not parsed beyond concatenation.
   */
  readonly pattern: string;
  readonly where?: readonly WherePredicate[];
  /** Expression after **`|`** (e.g. **`m.name`**, **`count(m)`**). Trusted Cypher fragment. */
  readonly projectionExpression: string;
};

/**
 * Emits a **pattern comprehension** **`[pattern WHERE … | projection]`** fragment with optional parameterized **`WHERE`**.
 */
export function compilePatternComprehension(options: PatternComprehensionOptions): CompiledCypher {
  const pattern = options.pattern.trim();
  if (!pattern) {
    throw new Error("compilePatternComprehension: pattern must be non-empty");
  }
  const proj = options.projectionExpression.trim();
  if (!proj) {
    throw new Error("compilePatternComprehension: projectionExpression must be non-empty");
  }
  const preds = options.where ?? [];
  if (preds.length === 0) {
    return { text: `[${pattern} | ${proj}]`, params: {} };
  }
  const { text: whereText, params } = compileWhereFragment([...preds]);
  if (!whereText) {
    throw new Error("compilePatternComprehension: WHERE predicates produced empty fragment");
  }
  return {
    text: `[${pattern} WHERE ${whereText} | ${proj}]`,
    params,
  };
}
