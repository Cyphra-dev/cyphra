/**
 * @packageDocumentation
 * Cypher-first query helpers: tagged templates and a small fluent builder.
 */

export type { CompiledCypher } from "./cypher.js";
export { compileCypher, cypher } from "./cypher.js";
export type { EqPredicate, NodeRef, PropRef, RelRef } from "./builder.js";
export { eq, node, prop, rel, select, SelectQuery } from "./builder.js";
