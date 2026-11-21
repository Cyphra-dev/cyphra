/**
 * `@neo4j/graphql` v7 compatible API: the same generated schema, served on the Cyphra runtime.
 *
 * @packageDocumentation
 */

import {
  isObjectType,
  type GraphQLFieldResolver,
  type GraphQLResolveInfo,
  type GraphQLSchema,
} from "graphql";
import { resolveSchema, type SchemaDocument, type SchemaModel } from "@cyphra/schema";
import { convertGraphQLTypeDefs, type ImportIssue } from "../import/index.js";
import { SelectionCompiler } from "./cypher/select.js";
import { MutationCompiler } from "./cypher/mutate.js";
import {
  createExecutors,
  type Executors,
  type ExecutorOptions,
  type ReadExecutor,
  type WriteExecutor,
} from "./execute.js";
import { readTypeDefs, type V7Model } from "./model.js";
import { buildV7Schema } from "./sdl.js";

export type MakeSchemaOptions = ExecutorOptions & {
  /** v7 type definitions (`@node`, `@relationship`, …). */
  typeDefs: string;
};

type AnyRecord = Record<string, unknown>;

/** Reads values by response key, so aliases (`paged: actorsConnection(...)`) resolve. */
const byResponseKey: GraphQLFieldResolver<unknown, unknown> = (source, _args, _ctx, info) =>
  source && typeof source === "object" ? (source as AnyRecord)[info.path.key as string] : undefined;

function rootReadResolver(
  model: V7Model,
  execute: ReadExecutor,
  nodeName: string,
  kind: "list" | "connection",
): GraphQLFieldResolver<unknown, unknown> {
  return async (_source, args, _ctx, info: GraphQLResolveInfo) => {
    const node = model.node(nodeName);
    const compiler = new SelectionCompiler(model, info);
    const compiled =
      kind === "list"
        ? compiler.rootList(node, args as AnyRecord, info.fieldNodes)
        : compiler.rootConnection(node, args as AnyRecord, info.fieldNodes);
    return compiled.decode(await execute(compiled.cypher, compiled.params));
  };
}

function rootMutationResolver(
  model: V7Model,
  execute: WriteExecutor,
  nodeName: string,
  kind: "create" | "update" | "delete",
): GraphQLFieldResolver<unknown, unknown> {
  return async (_source, args, _ctx, info: GraphQLResolveInfo) => {
    const node = model.node(nodeName);
    const compiler = new MutationCompiler(model, info);
    const a = args as AnyRecord;
    const compiled =
      kind === "create"
        ? compiler.rootCreate(node, a, info.fieldNodes)
        : kind === "update"
          ? compiler.rootUpdate(node, a, info.fieldNodes)
          : compiler.rootDelete(node, a, info.fieldNodes);
    return execute(compiled.cypher, compiled.params, compiled.decode);
  };
}

/** Attaches resolvers: one Cypher statement (and transaction) per root field. */
function attachResolvers(schema: GraphQLSchema, model: V7Model, executors: Executors): void {
  const execute = executors.read;
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) || type.name.startsWith("__")) continue;
    if (type === schema.getQueryType() || type === schema.getMutationType()) continue;
    for (const field of Object.values(type.getFields())) field.resolve = byResponseKey;
  }
  const query = schema.getQueryType()!.getFields();
  for (const node of model.nodes) {
    query[node.plural]!.resolve = rootReadResolver(model, execute, node.name, "list");
    query[`${node.plural}Connection`]!.resolve = rootReadResolver(
      model,
      execute,
      node.name,
      "connection",
    );
  }
  const mutation = schema.getMutationType()!.getFields();
  for (const node of model.nodes) {
    for (const kind of ["create", "update", "delete"] as const) {
      mutation[`${kind}${node.pascalPlural}`]!.resolve = rootMutationResolver(
        model,
        executors.write,
        node.name,
        kind,
      );
    }
  }
}

/**
 * Build the GraphQL schema `@neo4j/graphql` v7 generates for `typeDefs`, with resolvers that run on
 * Neo4j through `driver` or `client`. Drop-in for `new Neo4jGraphQL({ typeDefs, driver }).getSchema()`.
 *
 * Today: the full v7 schema (SDL identical to v7), the read API (list and connection queries,
 * filters, sorting, offset and cursor pagination, nested relationships and connections with edge
 * properties, connection `aggregate` selections and aggregation filters) and mutations (create,
 * update, delete with every nested operation and `info` counters). Authorization (#74) and
 * `@cypher` fields (#75) are in the schema but answer with a "Not implemented yet" error.
 *
 * @example
 * ```ts
 * import { compat } from "@cyphra/graphql";
 * const schema = compat.v7.makeSchema({ typeDefs, driver });
 * ```
 */
export function makeSchema(options: MakeSchemaOptions): GraphQLSchema {
  const model = readTypeDefs(options.typeDefs);
  const schema = buildV7Schema(model);
  attachResolvers(schema, model, createExecutors(options));
  return schema;
}

/**
 * The GraphQL `contextValue` for a request. v7 reads the decoded JWT from `context.jwt`; it is
 * accepted for compatibility (authorization itself is #74).
 */
export function contextFor(opts: { jwt?: Record<string, unknown> } = {}): Record<string, unknown> {
  return opts.jwt ? { jwt: opts.jwt } : {};
}

/**
 * The Cyphra schema for the same type definitions (through `convertGraphQLTypeDefs`, the converter
 * behind `cyphra import graphql`): use it with `createOrm` to work on the graph the GraphQL API
 * serves. `issues` lists what Cyphra models differently (e.g. `@cypher` fields are not converted).
 */
export function cyphraSchema(typeDefs: string): {
  document: SchemaDocument;
  model: SchemaModel;
  issues: readonly ImportIssue[];
} {
  const { document, issues } = convertGraphQLTypeDefs([
    { name: "typeDefs.graphql", body: typeDefs },
  ]);
  return { document, model: resolveSchema(document), issues };
}

export { readTypeDefs, UnsupportedTypeDefsError, type V7Model } from "./model.js";
export { buildV7Schema } from "./sdl.js";
export { cursorToOffset, offsetToCursor } from "./cypher/select.js";
