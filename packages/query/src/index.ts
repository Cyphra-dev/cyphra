/**
 * @packageDocumentation
 * Cypher-first query helpers: tagged templates and a small fluent builder.
 */

export type { CompiledCypher } from "./cypher.js";
export { compileCypher, cypher } from "./cypher.js";
export type {
  EqPredicate,
  NodeRef,
  OrderByClause,
  OrderDirection,
  PropRef,
  RelRef,
  WherePredicate,
} from "./builder.js";
export {
  and,
  contains,
  endsWith,
  eq,
  gt,
  gte,
  inList,
  isNotNull,
  isNull,
  lt,
  lte,
  matches,
  neq,
  not,
  or,
  node,
  prop,
  rel,
  select,
  SelectQuery,
  startsWith,
} from "./builder.js";
