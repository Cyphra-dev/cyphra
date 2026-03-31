/**
 * @packageDocumentation
 * Graph ORM helpers driven by `.cyphra` + {@link CyphraClient}.
 */

export { runCompiledBatchWrite } from "./batch.js";
export type { CreateLinkedNodesSpec, RootOptionalOutgoingReadSpec } from "./graphOps.js";
export {
  queryRecordRootOptionalOutgoing,
  queryRecordsRootOptionalOutgoing,
  runCreateLinkedNodes,
  runCreateLinkedNodesTx,
} from "./graphOps.js";
export { createNodeCrud, type NodeCrud } from "./crud.js";
export type {
  CyphraSchemaClient,
  ModelCreateArgs,
  ModelDelegate,
  ModelDeleteArgs,
  ModelFindFirstArgs,
  ModelFindManyArgs,
  ModelFindUniqueArgs,
  ModelUpdateArgs,
} from "./schemaClient.js";
export { createSchemaClient, modelNameToClientKey } from "./schemaClient.js";
export { queryRelatedNodes, queryShortestPath } from "./related.js";
export {
  getIdFieldName,
  getNodeDeclaration,
  getScalarFields,
  getUniqueFieldNames,
} from "./nodeMeta.js";
export { compileRelatedNodes, compileShortestPath, type TraverseDirection } from "./traverse.js";
