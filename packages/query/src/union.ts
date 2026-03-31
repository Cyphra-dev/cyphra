import type { CompiledCypher } from "./cypher.js";
import { remapCompiledCypherParamKeys } from "./cypher.js";

/**
 * Combine compiled queries with `UNION ALL`, namespacing parameters per branch
 * (`$p0` in branch 0 → `$u0_p0`) so keys never collide.
 */
export function unionAllCompiled(parts: readonly CompiledCypher[]): CompiledCypher {
  if (parts.length === 0) {
    throw new Error("unionAllCompiled: at least one compiled query is required");
  }
  const chunks: string[] = [];
  const allParams: Record<string, unknown> = {};
  for (let i = 0; i < parts.length; i++) {
    const remapped = remapCompiledCypherParamKeys(parts[i]!, `u${i}_`);
    chunks.push(remapped.text);
    Object.assign(allParams, remapped.params);
  }
  return { text: chunks.join(" UNION ALL "), params: allParams };
}

/**
 * Same as {@link unionAllCompiled} but uses `UNION` (distinct rows).
 */
export function unionCompiled(parts: readonly CompiledCypher[]): CompiledCypher {
  if (parts.length === 0) {
    throw new Error("unionCompiled: at least one compiled query is required");
  }
  const u = unionAllCompiled(parts);
  return { text: u.text.replace(/ UNION ALL /g, " UNION "), params: u.params };
}
