/**
 * The Cyphra-native GraphQL API: generated from `schema.cyphra`, configured in TypeScript
 * (`defineGraphQL`), and served by the typed client, so filters, ordering, paging and errors
 * behave as they do from TypeScript. Every root field is one client operation, compiled to one
 * Cypher statement.
 *
 * @experimental The native API may change in minor releases (see the stability policy).
 * @packageDocumentation
 */

import {
  lexicographicSortSchema,
  printSchema as printGraphQLSchema,
  type GraphQLSchema,
} from "graphql";
import type { SchemaModel } from "@cyphra/schema";
import { ApiModel } from "./api.js";
import { checkRuleWheres } from "./auth.js";
import { checkConfig, NativeSchemaError, type GraphQLConfig } from "./config.js";
import {
  nodeResolver,
  rootResolvers,
  sessions,
  type ClientSource,
  type Session,
} from "./resolvers.js";
import { SchemaBuilder } from "./schema.js";

export { jwtContext, type JwtContext, type JwtContextOptions } from "./jwt.js";

export { fromGlobalId, toGlobalId } from "./relay.js";
export {
  CREATE_OPERATIONS,
  defineGraphQL,
  DELETE_OPERATIONS,
  NativeSchemaError,
  READ_OPERATIONS,
  UPDATE_OPERATIONS,
  WRITE_OPERATIONS,
  type CreateOperation,
  type DeleteOperation,
  type ContextPredicate,
  type ContextRule,
  type CreateRule,
  type FieldReadRule,
  type FieldToggle,
  type GraphQLConfig,
  type ModelRules,
  type RuleArgs,
  type RuleCreateData,
  type RuleWhere,
  type WhereRule,
  type Limits,
  type ModelConfig,
  type OperationToggles,
  type ReadOperation,
  type RootOperation,
  type UpdateOperation,
  type WriteOperation,
} from "./config.js";

/** Options of {@link makeSchema}. */
export type NativeMakeSchemaOptions = {
  /**
   * The Cyphra client (`createClient(…)` of `cyphra.gen.ts`, possibly `$extends`-ed), or a
   * function of the GraphQL context returning the request's client (query hooks then run per
   * request). With a function, pass `schema` too.
   */
  readonly client: object | ((context: never) => object | Promise<object>);
  /** The schema model; defaults to `client.$schema`. Required when `client` is a function. */
  readonly schema?: SchemaModel;
  /**
   * The API's configuration (`defineGraphQL`). Default: every read operation, no writes (turn
   * them on per model with `operations: { create, update, delete }`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any type map and context
  readonly config?: GraphQLConfig<any, any>;
  /** Show the message of unexpected errors instead of masking them (`INTERNAL_SERVER_ERROR`). */
  readonly debug?: boolean;
};

function schemaOf(options: { client?: unknown; schema?: SchemaModel }): SchemaModel {
  if (options.schema) return options.schema;
  const s = (options.client as { $schema?: SchemaModel } | undefined)?.$schema;
  if (typeof options.client === "function" || !s) {
    throw new NativeSchemaError(
      "native.makeSchema: pass schema (e.g. db.$schema) when client is a function or not a Cyphra client.",
    );
  }
  return s;
}

/**
 * The native GraphQL schema of a Cyphra client, with its resolvers: serve it with GraphQL Yoga,
 * Apollo Server or any GraphQL server.
 *
 * @example
 * ```ts
 * import { native } from "@cyphra/graphql";
 * import { createClient } from "./cyphra.gen.js";
 * import { api } from "./graphql.config.js";
 *
 * const db = createClient({ uri, user, password });
 * export const schema = native.makeSchema({ client: db, config: api });
 * ```
 *
 * @throws {NativeSchemaError} When the config names unknown models, fields or operations, or the
 * schema cannot be served (reserved field names, name collisions).
 * @experimental
 */
export function makeSchema(options: NativeMakeSchemaOptions): GraphQLSchema {
  const schema = schemaOf(options);
  const api = new ApiModel(schema, checkConfig(schema, options.config as GraphQLConfig));
  checkRuleWheres(api);
  const session = sessions(api, options.client as ClientSource);
  const runtime = { session, debug: options.debug ?? false };
  const built = new SchemaBuilder(
    api,
    rootResolvers(api, runtime),
    nodeResolver(api, runtime),
  ).build();
  sessionsBySchema.set(built, session);
  return built;
}

/** The request sessions of each schema `makeSchema` built (for {@link context}). */
const sessionsBySchema = new WeakMap<GraphQLSchema, (ctx: unknown) => Promise<Session>>();

/**
 * `ctx.cyphra`: the request's client with the API's rules applied (a custom resolver cannot read
 * around a rule by accident), and `$unsafe`, the client without them.
 */
export type RequestClient<C extends object> = C & {
  /** The client without the API's rules (what `client` gave for the request). */
  readonly $unsafe: C;
};

/**
 * A GraphQL context function (for GraphQL Yoga, Apollo Server, …) that builds the context with
 * `build` (e.g. {@link jwtContext}), then sets `ctx.cyphra`: the request's client with the API's
 * rules applied, for custom resolvers. The rules are evaluated once per request, with the context
 * `build` returned; the generated root fields share them. (Root fields also set `ctx.cyphra`
 * when the context has none, but only once one of them runs.)
 *
 * @example
 * ```ts
 * const schema = native.makeSchema({ client: db, config: api });
 * const yoga = createYoga({ schema, context: native.context(schema, native.jwtContext({ key })) });
 * // In any resolver: ctx.cyphra.post.findMany(…) (rules applied), ctx.cyphra.$unsafe (none).
 * ```
 *
 * @experimental
 */
export function context<Init = unknown, C extends object = Record<string, never>>(
  schema: GraphQLSchema,
  build?: (init: Init) => C | Promise<C>,
): (init: Init) => Promise<C & { cyphra?: RequestClient<object> }> {
  const session = sessionsBySchema.get(schema);
  if (!session) {
    throw new NativeSchemaError("native.context: not a schema built by native.makeSchema.");
  }
  return async (init) => {
    const ctx = (build ? await build(init) : {}) as C;
    await session(ctx);
    return ctx as C & { cyphra?: RequestClient<object> };
  };
}

/**
 * The API's SDL for a schema model and a config, without a client: sorted
 * (`lexicographicSortSchema` + `printSchema`), the contract to commit and check in CI
 * (`cyphra graphql print --check`).
 *
 * @experimental
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any type map and context
export function printSchema(schema: SchemaModel, config?: GraphQLConfig<any, any>): string {
  const api = new ApiModel(schema, checkConfig(schema, config as GraphQLConfig));
  return `${printGraphQLSchema(lexicographicSortSchema(new SchemaBuilder(api).build()))}\n`;
}
