/**
 * @packageDocumentation
 * Cypher-first query helpers: tagged templates, fluent `select()`, and the fluent read chain (`createFluentQueryRoot`).
 */

export type { CompiledCypher } from "./cypher.js";
export { compileCypher, cypher, remapCompiledCypherParamKeys } from "./cypher.js";
export type { LetBinding, WhenBranch } from "./cypher25.js";
export {
  appendFinish,
  compileCreateConstraintNodeUnique,
  compileCreateConstraintRelationshipUnique,
  compileCreateRangeIndexNode,
  compileCreateRangeIndexRelationship,
  compileLetClause,
  compileMatchFilterReturn,
  compileSequentialNext,
  compileWhenThenElse,
} from "./cypher25.js";
export { CyphraQueryError } from "./errors.js";
export { concatCompiledCypher } from "./compose.js";
export {
  compileCollectBlock,
  compileCountBlock,
  compileExistsBlock,
} from "./subqueryExpression.js";
export type { CallSubqueryOptions } from "./call.js";
export { callSubqueryCompiled, callSubqueryCompiledWith } from "./call.js";
export type { CaseWhenBranch } from "./caseExpr.js";
export { compileCaseExpression } from "./caseExpr.js";
export type {
  EqPredicate,
  NodeRef,
  OrderByClause,
  OrderDirection,
  PropRef,
  RelRef,
  RelVarLength,
  WherePredicate,
} from "./builder.js";
export {
  and,
  bareVar,
  between,
  compileWhereFragment,
  contains,
  endsWith,
  eq,
  exists,
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
export { unionAllCompiled, unionCompiled } from "./union.js";
export type { LoadCsvFieldTerminator } from "./loadCsv.js";
export { compileLoadCsvFrom } from "./loadCsv.js";
export {
  matchHintUsingIndex,
  matchHintUsingJoin,
  matchHintUsingPointIndex,
  matchHintUsingRangeIndex,
  matchHintUsingScan,
  matchHintUsingTextIndex,
} from "./hints.js";
export { compileComprehensionFilterClause } from "./comprehension.js";
export { compileMapProjection } from "./mapProjection.js";
export type {
  CreateLinkedNodesSpec,
  JsMapProjection,
  JsScalarRef,
  OutgoingRelSpec,
} from "./graphQuery.js";
export {
  buildReturnRawFieldsMap,
  compileCreateLinkedNodes,
  compileRootOptionalOutgoingSelect,
  compileRootWithOptionalOut,
} from "./graphQuery.js";
export {
  createFluentQueryRoot,
  MatchVar,
  type FluentQueryRoot,
  type FluentReadClient,
} from "./fluentReadQuery.js";
export type { PatternComprehensionOptions } from "./patternComprehension.js";
export { compilePatternComprehension } from "./patternComprehension.js";
export {
  absExpr,
  avgExpr,
  ceilExpr,
  collectExpr,
  countDistinct,
  countStar,
  countVariable,
  floorExpr,
  maxExpr,
  minExpr,
  randExpr,
  roundExpr,
  sizeExpr,
  sqrtExpr,
  sumExpr,
  toLowerExpr,
  toUpperExpr,
} from "./exprBuiltins.js";
export {
  currentDateExpr,
  currentDateTimeExpr,
  currentLocalDateTimeExpr,
  currentLocalTimeExpr,
  currentTimeExpr,
} from "./temporalExpr.js";
export { lengthPath, nodesPath, relationshipsPath } from "./pathExpr.js";
export { compilePointCartesian2D, compilePointWGS84 } from "./spatialPoint.js";
export { usingPeriodicCommitClause } from "./periodicCommit.js";
export type { ShowAdminKind } from "./showAdmin.js";
export { compileShowAdmin } from "./showAdmin.js";
export {
  compileDenyAccessOnDatabase,
  compileGrantRole,
  compileRevokeRole,
} from "./securityAdmin.js";
export { compileShowTransactions, compileTerminateTransactions } from "./transactionAdmin.js";
export type { CompileMergeSetOptions, RelationshipEndpointsPattern } from "./write.js";
export {
  compileCreate,
  compileCreateRelationship,
  compileCreateRelationshipIn,
  compileDeleteRelationshipWhere,
  compileDeleteWhere,
  compileDetachDeleteWhere,
  compileForeachDeleteRelationshipsFromPath,
  compileForeachMergeSet,
  compileMergeRelationship,
  compileMergeRelationshipIn,
  compileMergeSet,
  compileRemoveProperties,
  compileRemoveRelationshipProperties,
  compileSetRelationshipWhere,
  compileSetWhere,
  compileUnwindDetachDelete,
  compileUnwindMergeSet,
} from "./write.js";
