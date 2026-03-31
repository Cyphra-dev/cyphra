import type { CompiledCypher } from "./cypher.js";
import { remapCompiledCypherParamKeys } from "./cypher.js";

/**
 * Concatenate compiled fragments left-to-right with a separator (default single space).
 * The **first** fragment keeps its parameter keys (**`p0`**, **`p1`**, …); each **following** fragment is
 * {@link remapCompiledCypherParamKeys | remapped} with **`f1_`**, **`f2_`**, … so names never collide.
 */
export function concatCompiledCypher(
  parts: readonly CompiledCypher[],
  options?: { readonly separator?: string },
): CompiledCypher {
  if (parts.length === 0) {
    throw new Error("concatCompiledCypher: at least one part is required");
  }
  const separator = options?.separator ?? " ";
  if (parts.length === 1) {
    const p = parts[0]!;
    return { text: p.text, params: { ...p.params } };
  }
  const texts: string[] = [parts[0]!.text];
  const params: Record<string, unknown> = { ...parts[0]!.params };
  for (let i = 1; i < parts.length; i++) {
    const remapped = remapCompiledCypherParamKeys(parts[i]!, `f${i}_`);
    texts.push(remapped.text);
    Object.assign(params, remapped.params);
  }
  return { text: texts.join(separator), params };
}
