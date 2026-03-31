import type { CompiledCypher } from "./cypher.js";
import { remapCompiledCypherParamKeys } from "./cypher.js";
import { compileWhereFragment, type WherePredicate } from "./builder.js";

export type CaseWhenBranch = {
  /** AND-combined (same rules as {@link compileWhereFragment}). */
  readonly when: readonly WherePredicate[];
  /** Bound as a Neo4j parameter in **`THEN`**. */
  readonly then: unknown;
};

/**
 * Parameterized **`CASE WHEN … THEN … [ELSE …] END`** expression (no generic Cypher in **`WHEN`** —
 * only {@link WherePredicate} trees). **`THEN`** / **`ELSE`** values are always parameters.
 *
 * Use inside **`RETURN`**, **`WITH`**, or projections composed with **`cypher`** / string concat.
 */
export function compileCaseExpression(
  branches: readonly CaseWhenBranch[],
  elseThen: unknown,
): CompiledCypher {
  if (branches.length === 0) {
    throw new Error("compileCaseExpression: at least one WHEN branch is required");
  }
  let text = "CASE";
  const params: Record<string, unknown> = {};
  for (let i = 0; i < branches.length; i++) {
    const br = branches[i]!;
    if (br.when.length === 0) {
      throw new Error("compileCaseExpression: each branch requires at least one WHEN predicate");
    }
    const w = compileWhereFragment([...br.when]);
    const cond = remapCompiledCypherParamKeys(w, `b${i}_`);
    const thenKey = `t${i}`;
    text += ` WHEN ${cond.text} THEN $${thenKey}`;
    params[thenKey] = br.then;
    Object.assign(params, cond.params);
  }
  const elseKey = "e";
  text += ` ELSE $${elseKey} END`;
  params[elseKey] = elseThen;
  return { text, params };
}
