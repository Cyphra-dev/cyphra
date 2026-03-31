import type { CompiledCypher } from "./cypher.js";
import { remapCompiledCypherParamKeys } from "./cypher.js";

/**
 * Existential / aggregating subquery **expressions** (`EXISTS { … }`, `COUNT { … }`, `COLLECT { … }`).
 * Inner parameters are prefixed so the block can be embedded in a larger query.
 * When using `concatCompiledCypher`, put this block in a **single** fragment or merge text manually —
 * otherwise later fragments are remapped again and parameter names gain an extra prefix.
 *
 * @see https://neo4j.com/docs/cypher-manual/current/subqueries/
 */

function wrapBlock(keyword: string, prefix: string, block: CompiledCypher): CompiledCypher {
  const inner = remapCompiledCypherParamKeys(block, prefix);
  return {
    text: `${keyword} { ${inner.text.trim()} }`,
    params: inner.params,
  };
}

/** `EXISTS { … }` */
export function compileExistsBlock(block: CompiledCypher): CompiledCypher {
  return wrapBlock("EXISTS", "ex_", block);
}

/** `COUNT { … }` */
export function compileCountBlock(block: CompiledCypher): CompiledCypher {
  return wrapBlock("COUNT", "ct_", block);
}

/** `COLLECT { … }` */
export function compileCollectBlock(block: CompiledCypher): CompiledCypher {
  return wrapBlock("COLLECT", "cl_", block);
}
