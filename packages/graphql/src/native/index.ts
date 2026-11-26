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
import { checkConfig, NativeSchemaError, type GraphQLConfig } from "./config.js";
import { rootResolvers, type ClientSource } from "./resolvers.js";
import { SchemaBuilder } from "./schema.js";

export {
  defineGraphQL,
  NativeSchemaError,
  READ_OPERATIONS,
  type FieldToggle,
  type GraphQLConfig,
  type Limits,
  type ModelConfig,
  type OperationToggles,
  type ReadOperation,
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
  /** The API's configuration (`defineGraphQL`). Default: every read operation, no writes. */
  readonly config?: GraphQLConfig;
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
  const resolver = rootResolvers(api, {
    client: options.client as ClientSource,
    debug: options.debug ?? false,
  });
  return new SchemaBuilder(api, resolver).build();
}

/**
 * The API's SDL for a schema model and a config, without a client: sorted
 * (`lexicographicSortSchema` + `printSchema`), the contract to commit and check in CI
 * (`cyphra graphql print --check`).
 *
 * @experimental
 */
export function printSchema(schema: SchemaModel, config?: GraphQLConfig): string {
  const api = new ApiModel(schema, checkConfig(schema, config));
  return `${printGraphQLSchema(lexicographicSortSchema(new SchemaBuilder(api).build()))}\n`;
}
