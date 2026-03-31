import type { CompiledCypher } from "./cypher.js";
import { remapCompiledCypherParamKeys } from "./cypher.js";

export type CallSubqueryOptions = {
  /** Defaults to `0` — use `1`, `2`, … when composing multiple `CALL { }` blocks in one query. */
  readonly branchIndex?: number;
};

/**
 * Wrap a compiled inner query in **`CALL { … }`** and namespace its parameters (`$p0` → `$c0_p0` by default)
 * so you can concatenate it with an outer query without key collisions.
 *
 * Pass a distinct {@link CallSubqueryOptions.branchIndex} for each subquery in the same outer statement.
 *
 * The inner fragment must be a valid Neo4j subquery (typically ends with **`RETURN`**).
 */
function assertImportVariable(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`callSubqueryCompiledWith: invalid import variable ${JSON.stringify(name)}`);
  }
}

export function callSubqueryCompiled(
  compiled: CompiledCypher,
  options?: CallSubqueryOptions,
): CompiledCypher {
  const i = options?.branchIndex ?? 0;
  if (!Number.isInteger(i) || i < 0) {
    throw new Error("callSubqueryCompiled: branchIndex must be a non-negative integer");
  }
  const inner = remapCompiledCypherParamKeys(compiled, `c${i}_`);
  return {
    text: `CALL { ${inner.text} }`,
    params: inner.params,
  };
}

/**
 * Correlated subquery: **`CALL { WITH v1, v2, … inner… }`** — imports outer variables into the subquery (Cypher Manual subqueries).
 * The **`inner`** fragment should continue with **`MATCH`**, **`RETURN`**, etc. after the implied **`WITH`**.
 */
export function callSubqueryCompiledWith(
  importVariables: readonly string[],
  inner: CompiledCypher,
  options?: CallSubqueryOptions,
): CompiledCypher {
  for (const v of importVariables) {
    assertImportVariable(v);
  }
  const prefix =
    importVariables.length > 0 ? `WITH ${importVariables.join(", ")} ` : "";
  return callSubqueryCompiled(
    { text: prefix + inner.text, params: { ...inner.params } },
    options,
  );
}
