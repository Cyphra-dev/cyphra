/**
 * `@neo4j/graphql` v7 compatible API: the same generated schema, served on the Cyphra runtime.
 *
 * @packageDocumentation
 */

import {
  GraphQLError,
  GraphQLSchema,
  isEnumType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isUnionType,
  Kind,
  validate,
  type DocumentNode,
  type GraphQLField,
  type GraphQLFieldResolver,
  type GraphQLResolveInfo,
} from "graphql";
import neo4j from "neo4j-driver";
import { resolveSchema, type SchemaDocument, type SchemaModel } from "@cyphra/schema";
import { convertGraphQLTypeDefs, type ImportIssue } from "../import/index.js";
import { SelectionCompiler } from "./cypher/select.js";
import { MutationCompiler } from "./cypher/mutate.js";
import {
  createExecutors,
  type Executors,
  type ExecutorOptions,
  type ReadExecutor,
  type SessionConfig,
  type WriteExecutor,
} from "./execute.js";
import {
  AUTH_OPERATIONS,
  collectTypeDefsIssues,
  issueAt,
  sortIssues,
  UnsupportedTypeDefsError,
  type TypeDefsIssue,
  type UserRootField,
  type V7Model,
} from "./model.js";
import { buildV7Schema } from "./sdl.js";
import {
  authContextFor,
  checkRootAuthentication,
  forbidden,
  type AuthContext,
} from "./auth/context.js";
import { JwtDecoder, type Features } from "./auth/jwt.js";
import { CDCSubscriptionsEngine } from "./subscriptions/engine.js";
import { attachSubscriptionResolvers } from "./subscriptions/resolvers.js";
import { AuthRules } from "./auth/rules.js";
import { CypherContext } from "./cypher/context.js";
import { containsForbidden } from "./cypher/select.js";
import { V7Engine, engineOption } from "./engine/index.js";

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
  /**
   * The application's resolvers, merged like `new Neo4jGraphQL({ typeDefs, resolvers })`: custom
   * `Query` / `Mutation` fields without `@cypher`, fields of types without `@node`,
   * `@customResolver` fields (called with the parent, which always has the `requires` selection),
   * or overrides of generated resolvers. An array is merged in order (later entries win).
   */
  resolvers?: Resolvers | readonly Resolvers[];
};

/**
 * Resolver map, as in `@graphql-tools/schema`: `{ TypeName: { field: resolver | { resolve } } }`,
 * with `__resolveType` on unions and `__isTypeOf` on object types.
 */
export type Resolvers = Record<string, Record<string, unknown>>;

type AnyRecord = Record<string, unknown>;

/**
 * v7's default field resolver: the value under the alias when the source has one (generated
 * results are keyed by response key), else under the field name; a function is called with
 * `(args, context, info)`. Neo4j integers become numbers on `Int`, `Float` and `ID` fields (v7
 * `numericalResolver` / `idResolver`), for values returned by the application's resolvers.
 */
function defaultFieldResolver(numeric: boolean): GraphQLFieldResolver<unknown, unknown> {
  return (source, args, ctx, info) => {
    if ((typeof source !== "object" || source === null) && typeof source !== "function") {
      return undefined;
    }
    const s = source as AnyRecord;
    const alias = info.fieldNodes[0]?.alias?.value;
    let value =
      alias !== undefined && Object.prototype.hasOwnProperty.call(s, alias)
        ? s[alias]
        : s[info.fieldName];
    if (typeof value === "function")
      value = (value as (...a: unknown[]) => unknown)(args, ctx, info);
    if (!numeric) return value;
    return Array.isArray(value) ? value.map(toNumber) : toNumber(value);
  };
}

function toNumber(value: unknown): unknown {
  return neo4j.isInt(value) ? value.toNumber() : value;
}

type Auth = { model: V7Model; decoder?: JwtDecoder; engine?: V7Engine };

/** The authorization context the root field wrapper computed (see {@link wrapRootField}). */
const REQUEST_AUTH = Symbol("cyphra.v7.auth");

/** The request's authorization context: the one of the root field wrapper, or computed. */
function requestAuth(ctx: unknown, { model, decoder }: Auth): Promise<AuthContext> {
  const known =
    ctx && typeof ctx === "object" ? (ctx as AnyRecord)[REQUEST_AUTH as never] : undefined;
  return known ? Promise.resolve(known as AuthContext) : authContextFor(ctx, model, decoder);
}

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

/**
 * v7 opens the request's sessions with `context.sessionConfig` (`database`, `impersonatedUser`,
 * `auth`) spread over the defaults: the statement runs on that database, as that user.
 */
function sessionConfigOf(ctx: unknown): SessionConfig | undefined {
  const config = ctx && typeof ctx === "object" ? (ctx as AnyRecord).sessionConfig : undefined;
  if (config === undefined || config === null) return undefined;
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new GraphQLError("context.sessionConfig must be an object.");
  }
  return config as SessionConfig;
}

/** Throws `Forbidden` when the statement replaced a selection by the forbidden marker. */
function checked<T>(decode: (rows: readonly unknown[]) => T): (rows: readonly unknown[]) => T {
  return (rows) => {
    if (containsForbidden(rows)) throw forbidden();
    return decode(rows);
  };
}

function rootReadResolver(
  a: Auth,
  execute: ReadExecutor,
  nodeName: string,
  kind: "list" | "connection",
): GraphQLFieldResolver<unknown, unknown> {
  const { model } = a;
  return async (_source, args, ctx, info: GraphQLResolveInfo) => {
    const node = model.node(nodeName);
    const auth = await requestAuth(ctx, a);
    // On the shared engine when it serves the request exactly like the compiler.
    const plan = a.engine?.read(kind, node, args as AnyRecord, info, info.fieldNodes, ctx, auth);
    const client = plan && a.engine!.clients.for(sessionConfigOf(ctx));
    if (plan) a.engine!.ran(info.fieldName, client !== undefined);
    if (plan && client) {
      return plan(client);
    }
    const compiler = new SelectionCompiler(model, info, auth);
    const compiled =
      kind === "list"
        ? compiler.rootList(node, args as AnyRecord, info.fieldNodes)
        : compiler.rootConnection(node, args as AnyRecord, info.fieldNodes);
    return checked(compiled.decode)(
      await execute(compiled.cypher, withCypherParams(compiled.params, ctx), sessionConfigOf(ctx)),
    );
  };
}

/** `contents(where, limit, offset)`: the root query of a union. */
function rootUnionResolver(
  a: Auth,
  execute: ReadExecutor,
  unionName: string,
): GraphQLFieldResolver<unknown, unknown> {
  const { model } = a;
  return async (_source, args, ctx, info: GraphQLResolveInfo) => {
    const union = model.unions.get(unionName)!;
    const auth = await requestAuth(ctx, a);
    const compiled = new SelectionCompiler(model, info, auth).rootUnion(
      union,
      args as AnyRecord,
      info.fieldNodes,
    );
    return checked(compiled.decode)(
      await execute(compiled.cypher, withCypherParams(compiled.params, ctx), sessionConfigOf(ctx)),
    );
  };
}

function fulltextResolver(
  a: Auth,
  execute: ReadExecutor,
  nodeName: string,
  queryName: string,
): GraphQLFieldResolver<unknown, unknown> {
  const { model } = a;
  return async (_source, args, ctx, info: GraphQLResolveInfo) => {
    const node = model.node(nodeName);
    const index = node.fulltext.find((f) => f.queryName === queryName)!;
    const auth = await requestAuth(ctx, a);
    // On the shared engine when it serves the request exactly like the compiler.
    const plan = a.engine?.fulltext(
      node,
      index,
      args as AnyRecord,
      info,
      info.fieldNodes,
      ctx,
      auth,
    );
    const client = plan && a.engine!.clients.for(sessionConfigOf(ctx));
    if (plan) a.engine!.ran(info.fieldName, client !== undefined);
    if (plan && client) {
      return plan(client);
    }
    const compiled = new SelectionCompiler(model, info, auth).rootFulltext(
      node,
      index,
      args as AnyRecord,
      info.fieldNodes,
    );
    return checked(compiled.decode)(
      await execute(compiled.cypher, withCypherParams(compiled.params, ctx), sessionConfigOf(ctx)),
    );
  };
}

/** `Query` fields run in a read transaction, `Mutation` fields in a write transaction. */
function rootCypherResolver(
  a: Auth,
  executors: Executors,
  type: "Query" | "Mutation",
  fieldName: string,
): GraphQLFieldResolver<unknown, unknown> {
  const { model } = a;
  return async (_source, args, ctx, info: GraphQLResolveInfo) => {
    const field = (type === "Query" ? model.query : model.mutation).fields.find(
      (f) => f.name === fieldName,
    )!;
    const auth = await requestAuth(ctx, a);
    checkRootAuthentication(model, auth, type, field);
    // On the shared engine when it serves the request exactly like the compiler.
    const plan = a.engine?.cypher(type, field, args as AnyRecord, info, info.fieldNodes, ctx, auth);
    const client = plan && a.engine!.clients.for(sessionConfigOf(ctx));
    if (plan) a.engine!.ran(info.fieldName, client !== undefined);
    if (plan && client) {
      return plan(client);
    }
    const compiled = new SelectionCompiler(model, info, auth).rootCypher(
      field,
      args as AnyRecord,
      info.fieldNodes,
    );
    const params = withCypherParams(compiled.params, ctx);
    const session = sessionConfigOf(ctx);
    if (type === "Query")
      return checked(compiled.decode)(await executors.read(compiled.cypher, params, session));
    return executors.write(compiled.cypher, params, checked(compiled.decode), session);
  };
}

function rootMutationResolver(
  opts: Auth,
  execute: WriteExecutor,
  nodeName: string,
  kind: "create" | "update" | "delete",
): GraphQLFieldResolver<unknown, unknown> {
  const { model } = opts;
  return async (_source, args, ctx, info: GraphQLResolveInfo) => {
    const node = model.node(nodeName);
    const auth = await requestAuth(ctx, opts);
    // On the shared engine when it writes and answers exactly like the compiler.
    const plan = opts.engine?.write(
      kind,
      node,
      args as AnyRecord,
      info,
      info.fieldNodes,
      ctx,
      auth,
    );
    const client = plan && opts.engine!.clients.for(sessionConfigOf(ctx));
    if (plan) opts.engine!.ran(info.fieldName, client !== undefined);
    if (plan && client) {
      return plan(client);
    }
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
      sessionConfigOf(ctx),
    );
  };
}

/**
 * Compiles every `@authorization` rule once with an empty context, so a rule that does not fit the
 * type (unknown field, wrong operator, …) fails when the schema is built, not on a request.
 */
function checkRules(
  model: V7Model,
  document: DocumentNode,
  skip: ReadonlySet<string>,
): TypeDefsIssue[] {
  const issues: TypeDefsIssue[] = [];
  const auth: AuthContext = {
    isAuthenticated: false,
    jwt: undefined,
    claims: undefined,
    context: {},
  };
  for (const node of model.nodes) {
    // A type with another issue is partly read: its rules could refer to what is left out.
    if (skip.has(node.name)) continue;
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
        issues.push(
          issueAt(
            document,
            `${node.name}${attr ? `.${attr.name}` : ""}: invalid @authorization rule: ${(e as Error).message}`,
            node.name,
            attr?.name,
          ),
        );
      }
    }
  }
  return issues;
}

/** Attaches resolvers: one Cypher statement (and transaction) per root field. */
function attachResolvers(schema: GraphQLSchema, auth: Auth, executors: Executors): void {
  const model = auth.model;
  const execute = executors.read;
  const query = schema.getQueryType()!.getFields();
  // Only generated root fields get a generated resolver: a field hidden by `@query` / `@mutation`
  // may be redefined by the application (served by its resolvers, never by the generated ones).
  const attach = (
    fields: Record<string, { resolve?: GraphQLFieldResolver<unknown, unknown> }> | undefined,
    generated: boolean,
    name: string,
    resolve: GraphQLFieldResolver<unknown, unknown>,
  ) => {
    const field = fields?.[name];
    if (field && generated) field.resolve = resolve;
  };
  for (const node of model.nodes) {
    attach(query, node.query.read, node.plural, rootReadResolver(auth, execute, node.name, "list"));
    attach(
      query,
      node.query.connection || node.query.aggregate,
      `${node.plural}Connection`,
      rootReadResolver(auth, execute, node.name, "connection"),
    );
    for (const ft of node.fulltext) {
      query[ft.queryName]!.resolve = fulltextResolver(auth, execute, node.name, ft.queryName);
    }
  }
  for (const i of model.interfaces.values()) {
    attach(query, i.query.read, i.plural, rootReadResolver(auth, execute, i.name, "list"));
    attach(
      query,
      i.query.connection || i.query.aggregate,
      `${i.plural}Connection`,
      rootReadResolver(auth, execute, i.name, "connection"),
    );
  }
  for (const u of model.unions.values()) {
    attach(query, u.read, u.plural, rootUnionResolver(auth, execute, u.name));
  }
  for (const f of model.query.fields) {
    query[f.name]!.resolve = rootCypherResolver(auth, executors, "Query", f.name);
  }
  const mutation = schema.getMutationType()?.getFields();
  for (const f of model.mutation.fields) {
    attach(mutation, true, f.name, rootCypherResolver(auth, executors, "Mutation", f.name));
  }
  for (const node of model.nodes) {
    for (const kind of ["create", "update", "delete"] as const) {
      attach(
        mutation,
        node.mutation[kind],
        `${kind}${node.pascalPlural}`,
        rootMutationResolver(auth, executors.write, node.name, kind),
      );
    }
  }
}

/** `resolvers` merged in order, like `mergeResolvers` (later entries win, field by field). */
function mergeResolvers(resolvers: MakeSchemaOptions["resolvers"]): Resolvers {
  const list = resolvers === undefined ? [] : Array.isArray(resolvers) ? resolvers : [resolvers];
  const merged: Resolvers = {};
  for (const r of list as Resolvers[]) {
    for (const [typeName, value] of Object.entries(r ?? {})) {
      if (typeof value !== "object" || value === null) {
        throw new Error(
          `"${typeName}" defined in resolvers, but has invalid value "${String(value)}". The resolver's value must be of type object.`,
        );
      }
      merged[typeName] = { ...merged[typeName], ...value };
    }
  }
  return merged;
}

/**
 * Adds the application's resolvers to the schema, as `addResolversToSchema` does in v7 (same
 * errors for types and fields that are not in the schema). They replace generated resolvers.
 */
function addUserResolvers(schema: GraphQLSchema, resolvers: Resolvers): void {
  for (const [typeName, value] of Object.entries(resolvers)) {
    const type = schema.getType(typeName);
    if (!type) throw new Error(`"${typeName}" defined in resolvers, but not in schema`);
    if (isScalarType(type) || isEnumType(type)) {
      throw new TypeError(
        `resolvers.${typeName}: resolvers for ${isScalarType(type) ? "scalar" : "enum"} types are not supported by @cyphra/graphql yet.`,
      );
    }
    if (isUnionType(type)) {
      for (const [key, fn] of Object.entries(value)) {
        if (!key.startsWith("__")) {
          throw new Error(
            `${typeName}.${key} was defined in resolvers, but ${typeName} is not an object or interface type`,
          );
        }
        (type as unknown as AnyRecord)[key.slice(2)] = fn;
      }
      continue;
    }
    if (!isObjectType(type) && !isInterfaceType(type)) continue;
    const fields = type.getFields();
    for (const [key, resolver] of Object.entries(value)) {
      if (key.startsWith("__")) {
        (type as unknown as AnyRecord)[key.slice(2)] = resolver;
        continue;
      }
      const field = fields[key];
      if (!field) throw new Error(`${typeName}.${key} defined in resolvers, but not in schema`);
      if (typeof resolver === "function") {
        field.resolve = (resolver as GraphQLFieldResolver<unknown, unknown>).bind(value);
      } else if (typeof resolver === "object" && resolver !== null) {
        Object.assign(field, resolver);
      } else {
        throw new Error(`Resolver ${typeName}.${key} must be object or function`);
      }
    }
  }
}

/**
 * v7 wraps every `Query` / `Mutation` resolver (generated or not): `context.executionContext`
 * defaults to the driver, and `context.jwt` to the payload of the verified `context.token`, so the
 * application's resolvers (and nested ones) can read them. Fields served by the application's
 * resolvers also get the schema-level, type-level and field `@authentication`.
 */
function wrapRootFields(schema: GraphQLSchema, auth: Auth, driver: unknown): void {
  for (const type of ["Query", "Mutation"] as const) {
    const root = type === "Query" ? schema.getQueryType() : schema.getMutationType();
    const custom = type === "Query" ? auth.model.query : auth.model.mutation;
    for (const field of Object.values(root?.getFields() ?? {})) {
      if (!field.resolve) continue;
      field.resolve = wrapRootField(
        field,
        auth,
        driver,
        type,
        custom.resolved.find((f) => f.name === field.name),
      );
    }
  }
}

function wrapRootField(
  field: GraphQLField<unknown, unknown>,
  auth: Auth,
  driver: unknown,
  type: "Query" | "Mutation",
  custom: UserRootField | undefined,
): GraphQLFieldResolver<unknown, unknown> {
  const resolve = field.resolve!;
  return async (source, args, ctx, info) => {
    if (!ctx || typeof ctx !== "object") return resolve(source, args, ctx, info);
    const context = ctx as AnyRecord;
    if (!context.executionContext && driver) context.executionContext = driver;
    const request = await authContextFor(context, auth.model, auth.decoder);
    if (!context.jwt) context.jwt = request.jwt;
    if (custom) checkRootAuthentication(auth.model, request, type, custom);
    return resolve(source, args, { ...context, [REQUEST_AUTH]: request }, info);
  };
}

/** v7 checks `@customResolver(requires)` against the type: the selection must be valid on it. */
function checkRequires(
  schema: GraphQLSchema,
  model: V7Model,
  document: DocumentNode,
): TypeDefsIssue[] {
  const issues: TypeDefsIssue[] = [];
  for (const node of model.nodes) {
    for (const f of node.userFields) {
      if (!f.requires) continue;
      const type = schema.getType(node.name);
      if (!isObjectType(type)) continue;
      const errors = validate(
        new GraphQLSchema({ query: type, types: Object.values(schema.getTypeMap()) }),
        {
          kind: Kind.DOCUMENT,
          definitions: [
            {
              kind: Kind.OPERATION_DEFINITION,
              operation: "query" as never,
              selectionSet: f.requires,
            },
          ],
        },
      );
      if (errors.length) {
        issues.push(
          issueAt(
            document,
            `Invalid selection set provided to @customResolver on ${node.name}:\n${errors.join("\n")}`,
            node.name,
            f.name,
          ),
        );
      }
    }
  }
  return issues;
}

/** v7 warns about `@customResolver` fields the resolvers do not serve. */
function warnMissingCustomResolvers(model: V7Model, resolvers: Resolvers): void {
  for (const node of model.nodes) {
    for (const f of node.userFields) {
      const custom = f.definition.directives?.some((d) => d.name.value === "customResolver");
      if (custom && !resolvers[node.name]?.[f.name]) {
        console.warn(`Custom resolver for ${f.name} has not been provided`);
      }
    }
  }
}

/** v7's default resolvers on every field without one. */
function addDefaultFieldResolvers(schema: GraphQLSchema): void {
  const plain = defaultFieldResolver(false);
  const numeric = defaultFieldResolver(true);
  for (const type of Object.values(schema.getTypeMap())) {
    if ((!isObjectType(type) && !isInterfaceType(type)) || type.name.startsWith("__")) continue;
    for (const field of Object.values(type.getFields())) {
      if (field.resolve) continue;
      let t = field.type;
      while ("ofType" in t) t = t.ofType;
      field.resolve = ["Int", "Float", "ID"].includes(t.name) ? numeric : plain;
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
 * filterable like v7), `@fulltext` queries (on indexes the application creates) and unions
 * (relationships to a union, with member-keyed filters and nested writes, and the root union query),
 * interfaces (root queries, relationships to interfaces, `@declareRelationship`, nested writes),
 * subscriptions (`@subscription`, `@subscriptionsAuthorization`) on Neo4j Change Data Capture
 * with `features.subscriptions`, and the schema configuration directives (`@query`, `@mutation`,
 * `@selectable`, `@settable`, `@filterable`, `@sortable`, `@limit`). A directive or argument it does
 * not implement throws {@link UnsupportedTypeDefsError}: it is never ignored.
 *
 * @example
 * ```ts
 * import { compat } from "@cyphra/graphql";
 * const schema = compat.v7.makeSchema({ typeDefs, driver });
 * ```
 */
export function makeSchema(options: MakeSchemaOptions): GraphQLSchema {
  const { model, schema, issues } = analyzeTypeDefs(options.typeDefs);
  if (!schema || issues.length) throw UnsupportedTypeDefsError.fromIssues(issues);
  const resolvers = mergeResolvers(options.resolvers);
  warnMissingCustomResolvers(model, resolvers);
  const feature = options.features?.authorization;
  const decoder = feature ? new JwtDecoder(feature) : undefined;
  const engine = subscriptionsEngine(options);
  attachResolvers(
    schema,
    { model, decoder, engine: v7Engine(model, options) },
    createExecutors(options),
  );
  if (engine) {
    engine.attach(model);
    warnUnfilteredAuthorization(model);
  }
  attachSubscriptionResolvers(schema, model, decoder, engine);
  addUserResolvers(schema, resolvers);
  wrapRootFields(schema, { model, decoder }, options.driver);
  addDefaultFieldResolvers(schema);
  return schema;
}

/**
 * Reads the type definitions and builds their schema (without resolvers), collecting every issue:
 * those of the type definitions, then the `@authorization` rules of the types without one, then
 * (when there is no issue so far) the `@customResolver(requires)` selections.
 */
function analyzeTypeDefs(typeDefs: string): {
  model: V7Model;
  schema?: GraphQLSchema;
  issues: TypeDefsIssue[];
} {
  const { model, issues, document } = collectTypeDefsIssues(typeDefs);
  const withIssue = new Set(issues.flatMap((i) => (i.location.type ? [i.location.type] : [])));
  const all = sortIssues([...issues, ...checkRules(model, document, withIssue)]);
  if (all.length) return { model, issues: all };
  const schema = buildV7Schema(model);
  return { model, schema, issues: checkRequires(schema, model, document) };
}

/** One type definitions file for {@link checkTypeDefs}. */
export type TypeDefsSource = {
  /** File name (or any source name), set as `location.source` of its issues. */
  readonly name: string;
  readonly body: string;
};

/** Options of {@link checkTypeDefs}. */
export type CheckTypeDefsOptions = {
  /** Source name set as `location.source` of the issues when `typeDefs` is a string. */
  readonly source?: string;
};

/**
 * Every unsupported construct or invalid usage of the type definitions, as
 * {@link makeSchema} would report them in its {@link UnsupportedTypeDefsError} (with a `SYNTAX`
 * issue when they do not parse): an empty list means `makeSchema` accepts them. Nothing is
 * executed and no database is needed: use it to evaluate a migration from `@neo4j/graphql` 7 in
 * one run (`cyphra graphql check` on the command line).
 *
 * Several files are checked together (types can refer to types of other files); each issue's
 * `location` then names its file and the line in it.
 *
 * @example
 * ```ts
 * import { compat } from "@cyphra/graphql";
 * for (const issue of compat.v7.checkTypeDefs(typeDefs)) {
 *   console.log(issue.code, issue.message, issue.location.line);
 * }
 * ```
 */
export function checkTypeDefs(
  typeDefs: string | readonly TypeDefsSource[],
  opts: CheckTypeDefsOptions = {},
): TypeDefsIssue[] {
  const sources: readonly TypeDefsSource[] =
    typeof typeDefs === "string" ? [{ name: opts.source ?? "", body: typeDefs }] : typeDefs;
  // Line where each source starts in the joined type definitions.
  const starts: number[] = [];
  let line = 1;
  for (const s of sources) {
    starts.push(line);
    line += s.body.split("\n").length;
  }
  const relocate = (issue: TypeDefsIssue): TypeDefsIssue => {
    const at = issue.location.line;
    if (at === undefined) return issue;
    let i = starts.length - 1;
    while (i > 0 && starts[i]! > at) i--;
    const name = sources[i]?.name;
    return {
      ...issue,
      location: {
        ...issue.location,
        ...(name ? { source: name } : {}),
        line: at - starts[i]! + 1,
      },
    };
  };
  let issues: TypeDefsIssue[];
  try {
    issues = analyzeTypeDefs(sources.map((s) => s.body).join("\n")).issues;
  } catch (e) {
    if (!(e instanceof GraphQLError)) throw e;
    const pos = e.locations?.[0];
    issues = [
      {
        code: "SYNTAX",
        message: e.message,
        location: pos ? { line: pos.line, column: pos.column } : {},
      },
    ];
  }
  return issues.map(relocate);
}

/** The shared-engine side of the schema, unless the internal engine option turns it off. */
function v7Engine(model: V7Model, options: MakeSchemaOptions): V7Engine | undefined {
  const option = engineOption(options);
  return option === false ? undefined : new V7Engine(model, options, option);
}

/** The CDC engine of `features.subscriptions`, created from `driver` / `client` unless given. */
function subscriptionsEngine(options: MakeSchemaOptions): CDCSubscriptionsEngine | undefined {
  const feature = options.features?.subscriptions;
  if (!feature) return undefined;
  if (options.client && options.client.dialect !== "neo4j") {
    throw new TypeError(
      `features.subscriptions: GraphQL subscriptions use Neo4j Change Data Capture, which dialect "${options.client.dialect}" does not have.`,
    );
  }
  if (feature instanceof CDCSubscriptionsEngine) return feature;
  return new CDCSubscriptionsEngine({
    driver: options.driver,
    client: options.client,
    database: options.database,
    ...(feature === true ? {} : feature),
  });
}

/** v7 warns that `@authorization` does not apply to events (`@subscriptionsAuthorization` does). */
function warnUnfilteredAuthorization(model: V7Model): void {
  const unfiltered = model.nodes.some(
    (n) =>
      (n.auth.authorization || n.attributes.some((a) => a.auth?.authorization)) &&
      !n.subscriptionsAuthorization,
  );
  if (unfiltered) {
    console.warn(
      "'@subscriptionsAuthorization' not found on a type/field which has '@authorization' - subscriptions events are not subject to the authorization rules specified in '@authorization' directives.",
    );
  }
}

/**
 * The GraphQL `contextValue` for a request, as v7 reads it: `token` is the `Authorization` header
 * (`Bearer <jwt>`, verified with `features.authorization`), `jwt` a payload the server already
 * verified (trusted as-is, takes precedence over `token`), `sessionConfig` the session options of
 * the request's statements (`database`, `impersonatedUser`, `auth`; needs `driver`). Other keys are
 * kept for `$context.<path>` references in rules.
 */
export function contextFor(
  opts: {
    jwt?: Record<string, unknown>;
    token?: string;
    sessionConfig?: SessionConfig;
    [key: string]: unknown;
  } = {},
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

export {
  formatIssueLocation,
  readTypeDefs,
  UnsupportedTypeDefsError,
  type TypeDefsIssue,
  type TypeDefsIssueCode,
  type TypeDefsIssueLocation,
  type V7Model,
} from "./model.js";
export type { SessionConfig } from "./execute.js";
export type { AuthorizationFeature, Features, JwtKey, SubscriptionsFeature } from "./auth/jwt.js";
export {
  CDCSubscriptionsEngine,
  /** The v7 class name: `new Neo4jGraphQLSubscriptionsCDCEngine({ driver, pollTime })`. */
  CDCSubscriptionsEngine as Neo4jGraphQLSubscriptionsCDCEngine,
  type CDCEngineOptions,
} from "./subscriptions/engine.js";
export { buildV7Schema } from "./sdl.js";
export { cursorToOffset, offsetToCursor } from "./cypher/select.js";
