/**
 * `@neo4j/graphql` v7 compatible API: the same generated schema, served on the Cyphra runtime.
 *
 * @packageDocumentation
 */

import {
  GraphQLError,
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
import { AUTH_OPERATIONS, readTypeDefs, UnsupportedTypeDefsError, type V7Model } from "./model.js";
import { buildV7Schema } from "./sdl.js";
import {
  authContextFor,
  checkRootAuthentication,
  forbidden,
  type AuthContext,
} from "./auth/context.js";
import { JwtDecoder, type Features } from "./auth/jwt.js";
import { AuthRules } from "./auth/rules.js";
import { CypherContext } from "./cypher/context.js";
import { containsForbidden } from "./cypher/select.js";

export type MakeSchemaOptions = ExecutorOptions & {
  /** v7 type definitions (`@node`, `@relationship`, …). */
  typeDefs: string;
  /**
   * v7 `features`. `authorization` configures JWT verification for `@authentication` /
   * `@authorization`: the request's `context.token` (`Bearer <jwt>`) is verified with `key` (a
   * secret, a JWKS `{ url }`, or a function of the context returning one). Without it, only a
   * decoded `context.jwt` (trusted as-is) authenticates requests.
   */
  features?: Features;
};

type AnyRecord = Record<string, unknown>;

/** Reads values by response key, so aliases (`paged: actorsConnection(...)`) resolve. */
const byResponseKey: GraphQLFieldResolver<unknown, unknown> = (source, _args, _ctx, info) =>
  source && typeof source === "object" ? (source as AnyRecord)[info.path.key as string] : undefined;

type Auth = { model: V7Model; decoder?: JwtDecoder };

/**
 * v7 passes `context.cypherParams` as top-level parameters of every statement (`$name` in `@cypher`
 * statements). A name that clashes with a generated parameter is an error, like in v7.
 */
function withCypherParams(params: Record<string, unknown>, ctx: unknown): Record<string, unknown> {
  const extra = ctx && typeof ctx === "object" ? (ctx as AnyRecord).cypherParams : undefined;
  if (extra === undefined || extra === null) return params;
  if (typeof extra !== "object" || Array.isArray(extra)) {
    throw new GraphQLError("context.cypherParams must be an object.");
  }
  const clash = Object.keys(extra).filter((k) => Object.prototype.hasOwnProperty.call(params, k));
  if (clash.length) {
    throw new GraphQLError(
      `Duplicate parameter keys between context.cypherParams and generated parameters: [${clash.join(", ")}]`,
    );
  }
  return { ...(extra as AnyRecord), ...params };
}

/** Throws `Forbidden` when the statement replaced a selection by the forbidden marker. */
function checked<T>(decode: (rows: readonly unknown[]) => T): (rows: readonly unknown[]) => T {
  return (rows) => {
    if (containsForbidden(rows)) throw forbidden();
    return decode(rows);
  };
}

function rootReadResolver(
  { model, decoder }: Auth,
  execute: ReadExecutor,
  nodeName: string,
  kind: "list" | "connection",
): GraphQLFieldResolver<unknown, unknown> {
  return async (_source, args, ctx, info: GraphQLResolveInfo) => {
    const node = model.node(nodeName);
    const auth = await authContextFor(ctx, model, decoder);
    const compiler = new SelectionCompiler(model, info, auth);
    const compiled =
      kind === "list"
        ? compiler.rootList(node, args as AnyRecord, info.fieldNodes)
        : compiler.rootConnection(node, args as AnyRecord, info.fieldNodes);
    return checked(compiled.decode)(
      await execute(compiled.cypher, withCypherParams(compiled.params, ctx)),
    );
  };
}

function fulltextResolver(
  { model, decoder }: Auth,
  execute: ReadExecutor,
  nodeName: string,
  queryName: string,
): GraphQLFieldResolver<unknown, unknown> {
  return async (_source, args, ctx, info: GraphQLResolveInfo) => {
    const node = model.node(nodeName);
    const index = node.fulltext.find((f) => f.queryName === queryName)!;
    const auth = await authContextFor(ctx, model, decoder);
    const compiled = new SelectionCompiler(model, info, auth).rootFulltext(
      node,
      index,
      args as AnyRecord,
      info.fieldNodes,
    );
    return checked(compiled.decode)(
      await execute(compiled.cypher, withCypherParams(compiled.params, ctx)),
    );
  };
}

/** `Query` fields run in a read transaction, `Mutation` fields in a write transaction. */
function rootCypherResolver(
  { model, decoder }: Auth,
  executors: Executors,
  type: "Query" | "Mutation",
  fieldName: string,
): GraphQLFieldResolver<unknown, unknown> {
  return async (_source, args, ctx, info: GraphQLResolveInfo) => {
    const field = (type === "Query" ? model.query : model.mutation).fields.find(
      (f) => f.name === fieldName,
    )!;
    const auth = await authContextFor(ctx, model, decoder);
    checkRootAuthentication(model, auth, type, field);
    const compiled = new SelectionCompiler(model, info, auth).rootCypher(
      field,
      args as AnyRecord,
      info.fieldNodes,
    );
    const params = withCypherParams(compiled.params, ctx);
    if (type === "Query")
      return checked(compiled.decode)(await executors.read(compiled.cypher, params));
    return executors.write(compiled.cypher, params, checked(compiled.decode));
  };
}

function rootMutationResolver(
  { model, decoder }: Auth,
  execute: WriteExecutor,
  nodeName: string,
  kind: "create" | "update" | "delete",
): GraphQLFieldResolver<unknown, unknown> {
  return async (_source, args, ctx, info: GraphQLResolveInfo) => {
    const node = model.node(nodeName);
    const auth = await authContextFor(ctx, model, decoder);
    const compiler = new MutationCompiler(model, info, auth);
    const a = args as AnyRecord;
    const compiled =
      kind === "create"
        ? compiler.rootCreate(node, a, info.fieldNodes)
        : kind === "update"
          ? compiler.rootUpdate(node, a, info.fieldNodes)
          : compiler.rootDelete(node, a, info.fieldNodes);
    // Decoded inside the transaction: a failed check throws and rolls the statement back.
    return execute(
      compiled.cypher,
      withCypherParams(compiled.params, ctx),
      checked(compiled.decode),
    );
  };
}

/**
 * Compiles every `@authorization` rule once with an empty context, so a rule that does not fit the
 * type (unknown field, wrong operator, …) fails when the schema is built, not on a request.
 */
function checkRules(model: V7Model): void {
  const auth: AuthContext = {
    isAuthenticated: false,
    jwt: undefined,
    claims: undefined,
    context: {},
  };
  for (const node of model.nodes) {
    for (const attr of [undefined, ...node.attributes]) {
      const annotation = attr ? attr.auth : node.auth;
      if (!annotation?.authorization) continue;
      const target = attr ? { ...node, auth: {} } : node;
      const attrs = attr ? [attr] : [];
      try {
        const rules = new AuthRules(model, new CypherContext(), auth);
        for (const op of AUTH_OPERATIONS) {
          rules.filter("this", target, op, attrs);
          rules.validations("this", target, op, "BEFORE", attrs);
          rules.validations("this", target, op, "AFTER", attrs);
        }
      } catch (e) {
        throw new UnsupportedTypeDefsError(
          `${node.name}${attr ? `.${attr.name}` : ""}: invalid @authorization rule: ${(e as Error).message}`,
        );
      }
    }
  }
}

/** Attaches resolvers: one Cypher statement (and transaction) per root field. */
function attachResolvers(schema: GraphQLSchema, auth: Auth, executors: Executors): void {
  const model = auth.model;
  const execute = executors.read;
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) || type.name.startsWith("__")) continue;
    if (type === schema.getQueryType() || type === schema.getMutationType()) continue;
    for (const field of Object.values(type.getFields())) field.resolve = byResponseKey;
  }
  const query = schema.getQueryType()!.getFields();
  for (const node of model.nodes) {
    query[node.plural]!.resolve = rootReadResolver(auth, execute, node.name, "list");
    query[`${node.plural}Connection`]!.resolve = rootReadResolver(
      auth,
      execute,
      node.name,
      "connection",
    );
    for (const ft of node.fulltext) {
      query[ft.queryName]!.resolve = fulltextResolver(auth, execute, node.name, ft.queryName);
    }
  }
  for (const f of model.query.fields) {
    query[f.name]!.resolve = rootCypherResolver(auth, executors, "Query", f.name);
  }
  const mutation = schema.getMutationType()!.getFields();
  for (const f of model.mutation.fields) {
    mutation[f.name]!.resolve = rootCypherResolver(auth, executors, "Mutation", f.name);
  }
  for (const node of model.nodes) {
    for (const kind of ["create", "update", "delete"] as const) {
      mutation[`${kind}${node.pascalPlural}`]!.resolve = rootMutationResolver(
        auth,
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
 * properties, connection `aggregate` selections and aggregation filters), mutations (create,
 * update, delete with every nested operation and `info` counters) and `@authentication` /
 * `@authorization` (compiled into each statement; JWTs verified with `features.authorization`),
 * `@cypher` fields (on node types, relationship properties, `Query` and `Mutation`; sortable and
 * filterable like v7) and `@fulltext` queries (on indexes the application creates).
 *
 * @example
 * ```ts
 * import { compat } from "@cyphra/graphql";
 * const schema = compat.v7.makeSchema({ typeDefs, driver });
 * ```
 */
export function makeSchema(options: MakeSchemaOptions): GraphQLSchema {
  const model = readTypeDefs(options.typeDefs);
  checkRules(model);
  const schema = buildV7Schema(model);
  const feature = options.features?.authorization;
  const decoder = feature ? new JwtDecoder(feature) : undefined;
  attachResolvers(schema, { model, decoder }, createExecutors(options));
  return schema;
}

/**
 * The GraphQL `contextValue` for a request, as v7 reads it: `token` is the `Authorization` header
 * (`Bearer <jwt>`, verified with `features.authorization`), `jwt` a payload the server already
 * verified (trusted as-is, takes precedence over `token`). Other keys are kept for
 * `$context.<path>` references in rules.
 */
export function contextFor(
  opts: { jwt?: Record<string, unknown>; token?: string; [key: string]: unknown } = {},
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
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
export type { AuthorizationFeature, Features, JwtKey } from "./auth/jwt.js";
export { buildV7Schema } from "./sdl.js";
export { cursorToOffset, offsetToCursor } from "./cypher/select.js";
