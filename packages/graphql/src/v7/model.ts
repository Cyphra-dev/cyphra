/**
 * The `@neo4j/graphql` v7 type definitions, read into the model the v7 API is generated from.
 *
 * Unlike `convertGraphQLTypeDefs` (which maps to a Cyphra schema and drops what Cyphra cannot
 * express), this keeps every detail that changes the generated API: `ID` vs `String`, list element
 * nullability, `@cypher` fields, `@timestamp`, `@default`, relationship property types.
 *
 * @packageDocumentation
 */

import {
  Kind,
  parse,
  valueFromASTUntyped,
  type ConstDirectiveNode,
  type ConstValueNode,
  type FieldDefinitionNode,
  type InputObjectTypeDefinitionNode,
  type ObjectTypeDefinitionNode,
  type SelectionSetNode,
  type TypeNode,
  type UnionTypeDefinitionNode,
} from "graphql";
import { entityPlural, upperFirst } from "./naming.js";

/** Scalar types supported by `@cyphra/graphql` today. */
export const SUPPORTED_SCALARS = [
  "ID",
  "String",
  "Int",
  "Float",
  "Boolean",
  "BigInt",
  "Date",
  "DateTime",
] as const;
export type ScalarName = (typeof SUPPORTED_SCALARS)[number];

/** v7 scalars `@cyphra/graphql` does not support yet. */
const UNSUPPORTED_SCALARS = new Set([
  "LocalDateTime",
  "Time",
  "LocalTime",
  "Duration",
  "Point",
  "CartesianPoint",
]);

export type TypeRef = {
  /** Named type: a scalar or an enum. */
  readonly name: string;
  readonly list: boolean;
  /** Outer `!`. */
  readonly required: boolean;
  /** `[T!]` (only for lists). */
  readonly elementRequired: boolean;
};

export type CypherAnnotation = { readonly statement: string; readonly columnName: string };

/** An argument of a `@cypher` field (scalar or enum, list or not), e.g. `tags(prefix: String = "x")`. */
export type FieldArgument = {
  readonly name: string;
  readonly type: TypeRef;
  readonly kind: "scalar" | "enum";
  readonly description?: string;
  /** The raw default value AST, printed in the SDL and applied by GraphQL. */
  readonly defaultAst?: ConstValueNode;
};

/** A `@cypher` field of a node type returning nodes (`[Person!]!` or `Person`). */
export type CypherNodeField = {
  readonly name: string;
  /** Node type of the returned nodes. */
  readonly target: string;
  readonly type: TypeRef;
  readonly cypher: CypherAnnotation;
  readonly args: readonly FieldArgument[];
  readonly description?: string;
  readonly deprecated?: string;
  readonly config: FieldConfig;
};

/** A `@cypher` field of `Query` or `Mutation`. */
export type CypherRootField = {
  readonly name: string;
  readonly type: TypeRef;
  /** `node` when the named type is a `@node` type. */
  readonly kind: "scalar" | "enum" | "node";
  readonly cypher: CypherAnnotation;
  readonly args: readonly FieldArgument[];
  readonly description?: string;
  readonly deprecated?: string;
  /** Field-level `@authentication`. */
  readonly authentication?: AuthenticationAnnotation;
};

/**
 * A `Query` / `Mutation` field without `@cypher`: served by the application's `resolvers`, like v7
 * custom resolvers (the schema-level, type-level and field `@authentication` still apply).
 */
export type UserRootField = {
  readonly name: string;
  /** The field as written in the type definitions (printed as-is, without library directives). */
  readonly definition: FieldDefinitionNode;
  /** Field-level `@authentication`. */
  readonly authentication?: AuthenticationAnnotation;
};

/** The custom fields of `Query` or `Mutation`, with the type-level `@authentication`. */
export type CypherRootType = {
  readonly fields: readonly CypherRootField[];
  /** Fields without `@cypher`, served by the application's resolvers. */
  readonly resolved: readonly UserRootField[];
  readonly authentication?: AuthenticationAnnotation;
};

/**
 * A field of a `@node` type served by the application's resolvers: `@customResolver`, or a field
 * returning a type without `@node` (v7 prints it on the object type only: never in filters,
 * sorts, inputs, aggregations or subscription payloads, and never in the generated Cypher).
 */
export type UserField = {
  readonly name: string;
  /** The field as written in the type definitions. */
  readonly definition: FieldDefinitionNode;
  /** `@customResolver(requires)`: the selection always fetched for the resolver's parent. */
  readonly requires?: SelectionSetNode;
  /**
   * `@selectable` / `@settable` / `@filterable` / `@sortable`. Like v7, only `onRead` matters: these
   * fields are never in filters, sorts, inputs or aggregations anyway.
   */
  readonly config: FieldConfig;
};

/** Types without `@node` (object, input and union types), served as written. */
export type UserTypeDefinition =
  ObjectTypeDefinitionNode | InputObjectTypeDefinitionNode | UnionTypeDefinitionNode;

/** One index of `@fulltext(indexes: [{ indexName, queryName, fields }])`. */
export type FulltextIndex = {
  readonly indexName: string;
  /** Root query field, e.g. `moviesByTitle`. */
  readonly queryName: string;
  readonly fields: readonly string[];
};

/**
 * v7 schema configuration of a field (`@selectable`, `@settable`, `@filterable`, `@sortable`),
 * resolved with v7's argument defaults: every flag is `true` without the directive, but an
 * applied directive defaults `onAggregate` / `byAggregate` to `false` (`@filterable` alone turns
 * aggregation filters off, like v7).
 */
export type FieldConfig = {
  /** `@selectable(onRead)`: the field is in the object type (and subscription payloads). */
  readonly onRead: boolean;
  /** `@selectable(onAggregate)`: the field is in aggregate selections. */
  readonly onAggregate: boolean;
  /** `@settable(onCreate)`: the field is in create inputs. */
  readonly onCreate: boolean;
  /** `@settable(onUpdate)`: the field is in update inputs. */
  readonly onUpdate: boolean;
  /** `@filterable(byValue)`: the field is in `where` inputs. */
  readonly byValue: boolean;
  /** `@filterable(byAggregate)`: the field is in aggregation filters. */
  readonly byAggregate: boolean;
  /** `@sortable(byValue)`: the field is in sort inputs. */
  readonly sortable: boolean;
};

export const DEFAULT_FIELD_CONFIG: FieldConfig = {
  onRead: true,
  onAggregate: true,
  onCreate: true,
  onUpdate: true,
  byValue: true,
  byAggregate: true,
  sortable: true,
};

/** `@query(read, connection, aggregate)` of a type (or the schema), resolved. */
export type QueryConfig = {
  /** The root list query (`movies`). */
  readonly read: boolean;
  /** The root connection query (`moviesConnection`) with `edges` / `totalCount` / `pageInfo`. */
  readonly connection: boolean;
  /** The `aggregate` field of the root connection (which exists when this or `connection` holds). */
  readonly aggregate: boolean;
};

/** `@mutation(operations)` of a type (or the schema): which root mutations exist. */
export type MutationConfig = {
  readonly create: boolean;
  readonly update: boolean;
  readonly delete: boolean;
};

/** `@limit(default, max)` of a type. */
export type LimitConfig = { readonly default?: number; readonly max?: number };

export type Attribute = {
  readonly name: string;
  /** Property key in Neo4j (`@alias(property)`), defaults to the field name. */
  readonly property: string;
  readonly type: TypeRef;
  readonly kind: "scalar" | "enum";
  readonly description?: string;
  /** `@id`: generated, not in create/update inputs. */
  readonly id: boolean;
  /** `@default(value)` as a JS value. */
  readonly defaultValue?: unknown;
  /** The raw `@default(value: …)` AST, printed as the input default. */
  readonly defaultAst?: ConstValueNode;
  /** `@timestamp(operations)`. */
  readonly timestamp?: readonly ("CREATE" | "UPDATE")[];
  readonly cypher?: CypherAnnotation;
  /** Arguments of a `@cypher` field (other fields have none). */
  readonly args: readonly FieldArgument[];
  /** User `@deprecated(reason)` on the field. */
  readonly deprecated?: string;
  /** Field-level `@authentication` / `@authorization`. */
  readonly auth?: AuthAnnotations;
  readonly config: FieldConfig;
};

export type Relationship = {
  readonly name: string;
  readonly source: string;
  /** A `@node` type or a union of `@node` types (see {@link unionMembers}). */
  readonly target: string;
  readonly type: string;
  readonly direction: "IN" | "OUT";
  /** Name of the `@relationshipProperties` type, if any. */
  readonly properties?: string;
  readonly list: boolean;
  readonly required: boolean;
  readonly elementRequired: boolean;
  readonly description?: string;
  readonly deprecated?: string;
  /**
   * Set on the per-member view of a relationship to a union ({@link unionMembers}): the union.
   * `target` is then the member, and the generated type names get the member name
   * (`UserFavoritesMovieConnectionWhere`, …).
   */
  readonly union?: string;
  /** `@selectable` / `@settable` / `@filterable` of the relationship field. */
  readonly config: FieldConfig;
};

/** Operations `@authentication` / `@authorization` rules apply to. */
export const AUTH_OPERATIONS = [
  "READ",
  "AGGREGATE",
  "CREATE",
  "UPDATE",
  "DELETE",
  "CREATE_RELATIONSHIP",
  "DELETE_RELATIONSHIP",
  "SUBSCRIBE",
] as const;
export type AuthOperation = (typeof AUTH_OPERATIONS)[number];

/** Operations a `filter` rule can name (v7 `AuthorizationFilterOperation`): no CREATE / SUBSCRIBE. */
const FILTER_OPERATIONS: readonly AuthOperation[] = [
  "READ",
  "AGGREGATE",
  "UPDATE",
  "DELETE",
  "CREATE_RELATIONSHIP",
  "DELETE_RELATIONSHIP",
];
/** Operations a `validate` rule can name (v7 `AuthorizationValidateOperation`). */
const VALIDATE_OPERATIONS: readonly AuthOperation[] = [
  "READ",
  "AGGREGATE",
  "CREATE",
  "UPDATE",
  "DELETE",
  "CREATE_RELATIONSHIP",
  "DELETE_RELATIONSHIP",
];

type AnyRecord = Record<string, unknown>;

/** `@authentication(operations, jwt)`. */
export type AuthenticationAnnotation = {
  readonly operations: ReadonlySet<AuthOperation>;
  /** `jwt: { … }` filter the decoded JWT must match (checked in JS, before the statement runs). */
  readonly jwt?: AnyRecord;
};

/** One `filter` rule of `@authorization`. */
export type AuthorizationRule = {
  readonly operations: readonly AuthOperation[];
  /** Default `true`: the rule only holds for authenticated requests. */
  readonly requireAuthentication: boolean;
  /** `{ node, jwt, AND, OR, NOT }` with `$jwt.<claim>` / `$context.<path>` string references. */
  readonly where: AnyRecord;
};

/** One `validate` rule of `@authorization`. */
export type AuthorizationValidateRule = AuthorizationRule & {
  /** Default both: checked before and after the write. */
  readonly when: readonly ("BEFORE" | "AFTER")[];
};

export type AuthorizationAnnotation = {
  readonly filter: readonly AuthorizationRule[];
  readonly validate: readonly AuthorizationValidateRule[];
};

/** `@authentication` / `@authorization` of a type or of a field. */
export type AuthAnnotations = {
  readonly authentication?: AuthenticationAnnotation;
  readonly authorization?: AuthorizationAnnotation;
};

/** `@subscription(events)` and `@subscriptionsAuthorization` events. */
export const SUBSCRIPTION_EVENTS = ["CREATED", "UPDATED", "DELETED"] as const;
export type SubscriptionEvent = (typeof SUBSCRIPTION_EVENTS)[number];

/** One `filter` rule of `@subscriptionsAuthorization`. */
export type SubscriptionsAuthorizationRule = {
  readonly events: readonly SubscriptionEvent[];
  /** Default `true`: the rule only holds for authenticated subscribers. */
  readonly requireAuthentication: boolean;
  /** `{ node, jwt, AND, OR, NOT }` with `$jwt.<claim>` / `$context.<path>` string references. */
  readonly where: AnyRecord;
};

export type NodeType = {
  readonly name: string;
  readonly description?: string;
  /** Neo4j labels; the first is the main label. */
  readonly labels: readonly string[];
  /** Root list field, e.g. `movies`. */
  readonly plural: string;
  /** `Movies`. */
  readonly pascalPlural: string;
  readonly attributes: readonly Attribute[];
  readonly relationships: readonly Relationship[];
  /** `@cypher` fields returning nodes. */
  readonly cypherNodes: readonly CypherNodeField[];
  /** Fields served by the application's resolvers (`@customResolver`, non-`@node` types). */
  readonly userFields: readonly UserField[];
  /** `@fulltext` indexes. */
  readonly fulltext: readonly FulltextIndex[];
  readonly auth: AuthAnnotations;
  /** `@subscription(events)` of the type, when set (otherwise the schema-level one applies). */
  readonly subscription?: ReadonlySet<SubscriptionEvent>;
  /** `@subscriptionsAuthorization(filter)`: which events a subscriber receives. */
  readonly subscriptionsAuthorization?: readonly SubscriptionsAuthorizationRule[];
  /** `@query` of the type, or of the schema. */
  readonly query: QueryConfig;
  /** `@mutation` of the type, or of the schema. */
  readonly mutation: MutationConfig;
  readonly limit?: LimitConfig;
};

export type PropertiesType = {
  readonly name: string;
  readonly attributes: readonly Attribute[];
};

export type EnumType = {
  readonly name: string;
  readonly description?: string;
  readonly values: readonly { name: string; description?: string; deprecated?: string }[];
};

/** `union Content = Movie | Book` (members are `@node` types; a union adds no label, like v7). */
export type UnionType = {
  readonly name: string;
  readonly description?: string;
  readonly members: readonly string[];
  /** Root query field, e.g. `contents`. */
  readonly plural: string;
  /** `@query(read)` of the union, or of the schema: whether the root query exists. */
  readonly read: boolean;
};

export type V7Model = {
  readonly nodes: readonly NodeType[];
  readonly unions: ReadonlyMap<string, UnionType>;
  /** Schema-level `extend schema @authentication(…)`: applies to every operation on every type. */
  readonly authentication?: AuthenticationAnnotation;
  /**
   * `@jwtClaim(path)` of the `@jwt` type: field name → dotted path in the JWT payload. Like v7, the
   * mapping is applied to tokens the library verified, not to a decoded `jwt` passed in the context.
   */
  readonly jwtClaims: ReadonlyMap<string, string>;
  readonly properties: ReadonlyMap<string, PropertiesType>;
  readonly enums: ReadonlyMap<string, EnumType>;
  /** Object, input and union types without `@node`, passed through to the schema as written. */
  readonly userTypes: ReadonlyMap<string, UserTypeDefinition>;
  /** Custom fields of `type Query` / `type Mutation` (`@cypher` or served by resolvers). */
  readonly query: CypherRootType;
  readonly mutation: CypherRootType;
  /** Schema-level `extend schema @subscription(events)`. */
  readonly subscription?: ReadonlySet<SubscriptionEvent>;
  node(name: string): NodeType;
};

/** The events of `node` published on the `Subscription` type (v7 `isSubscribableOn…`). */
export function subscriptionEvents(model: V7Model, node: NodeType): ReadonlySet<SubscriptionEvent> {
  return node.subscription ?? model.subscription ?? new Set();
}

/** Whether `rel` targets a union (and is not already the view of one member). */
export function isUnionRelationship(model: V7Model, rel: Relationship): boolean {
  return rel.union === undefined && model.unions.has(rel.target);
}

/**
 * The per-member views of a relationship to a union (`User.favorites` to `Content = Movie | Book`:
 * one relationship to `Movie`, one to `Book`), in the union's member order. Each behaves like a
 * relationship to the member type, so filters, projections and nested writes reuse the node code.
 */
export function unionMembers(model: V7Model, rel: Relationship): Relationship[] {
  const u = model.unions.get(rel.target);
  if (!u || rel.union !== undefined) return [rel];
  return u.members.map((m) => ({ ...rel, target: m, union: u.name }));
}

/**
 * The members a union `where` selects (v7 `getConcreteEntities`): the members with a (truthy) key,
 * or every member when the object has no key at all.
 */
export function selectedMembers(
  members: readonly Relationship[],
  where: unknown,
): { rel: Relationship; where: unknown }[] {
  if (where === null || where === undefined || typeof where !== "object") {
    return members.map((rel) => ({ rel, where: undefined }));
  }
  const w = where as AnyRecord;
  if (Object.keys(w).length === 0) return members.map((rel) => ({ rel, where: undefined }));
  return members.filter((rel) => w[rel.target]).map((rel) => ({ rel, where: w[rel.target] }));
}

/** The type definitions use a feature `@cyphra/graphql` cannot serve yet. */
export class UnsupportedTypeDefsError extends Error {
  override name = "UnsupportedTypeDefsError";
}

function directive(
  dirs: readonly ConstDirectiveNode[] | undefined,
  name: string,
): ConstDirectiveNode | undefined {
  return dirs?.find((d) => d.name.value === name);
}

function arg(d: ConstDirectiveNode | undefined, name: string): ConstValueNode | undefined {
  return d?.arguments?.find((a) => a.name.value === name)?.value;
}

function stringArg(d: ConstDirectiveNode | undefined, name: string): string | undefined {
  const v = arg(d, name);
  return v && (v.kind === Kind.STRING || v.kind === Kind.ENUM) ? v.value : undefined;
}

function listArg(d: ConstDirectiveNode | undefined, name: string): string[] | undefined {
  const v = arg(d, name);
  if (!v) return undefined;
  if (v.kind === Kind.LIST) {
    return v.values.flatMap((x) =>
      x.kind === Kind.STRING || x.kind === Kind.ENUM ? [x.value] : [],
    );
  }
  if (v.kind === Kind.STRING || v.kind === Kind.ENUM) return [v.value];
  return undefined;
}

function typeRef(t: TypeNode): TypeRef {
  let cur = t;
  let required = false;
  if (cur.kind === Kind.NON_NULL_TYPE) {
    required = true;
    cur = cur.type;
  }
  if (cur.kind === Kind.LIST_TYPE) {
    let inner = cur.type;
    let elementRequired = false;
    if (inner.kind === Kind.NON_NULL_TYPE) {
      elementRequired = true;
      inner = inner.type;
    }
    if (inner.kind !== Kind.NAMED_TYPE)
      throw new UnsupportedTypeDefsError("Nested lists are not supported.");
    return { name: inner.name.value, list: true, required, elementRequired };
  }
  return {
    name: (cur as { name: { value: string } }).name.value,
    list: false,
    required,
    elementRequired: false,
  };
}

/** The field-level configuration directives. */
const FIELD_CONFIG_DIRECTIVES = new Set(["selectable", "settable", "filterable", "sortable"]);

/** Directives accepted on attribute fields. */
const ACCEPTED_FIELD_DIRECTIVES = new Set([
  "authentication",
  "authorization",
  "id",
  "default",
  "timestamp",
  "cypher",
  "relationship",
  "alias",
  "deprecated",
  // Accepted and ignored on fields, like v7 (only the type-level directive filters events).
  "subscriptionsAuthorization",
  ...FIELD_CONFIG_DIRECTIVES,
]);
/**
 * Directives accepted on relationship fields. Like v7, `@selectable(onAggregate)` and `@sortable`
 * have no effect there (aggregations and sorting apply to the related type's own fields).
 */
const RELATIONSHIP_FIELD_DIRECTIVES = new Set([
  "relationship",
  "deprecated",
  ...FIELD_CONFIG_DIRECTIVES,
]);
const ACCEPTED_TYPE_DIRECTIVES = new Set([
  "node",
  "fulltext",
  "plural",
  "authentication",
  "authorization",
  "relationshipProperties",
  "jwt",
  "subscription",
  "subscriptionsAuthorization",
  "query",
  "mutation",
  "limit",
]);

/**
 * The Boolean arguments of a schema configuration directive, with v7's defaults for missing ones.
 * Every argument is `Boolean!` in v7 except `@query(connection)`.
 */
function booleanArgs<K extends string>(
  where: string,
  d: ConstDirectiveNode,
  defaults: Record<K, boolean | undefined>,
): Record<K, boolean | undefined> {
  const out = { ...defaults };
  for (const a of d.arguments ?? []) {
    const name = a.name.value;
    if (!(name in defaults)) {
      throw new UnsupportedTypeDefsError(
        `${where}: @${d.name.value}(${name}) is not an argument of @${d.name.value}.`,
      );
    }
    if (a.value.kind === Kind.NULL && name === "connection") {
      out[name as K] = undefined;
      continue;
    }
    if (a.value.kind !== Kind.BOOLEAN) {
      throw new UnsupportedTypeDefsError(`${where}: @${d.name.value}(${name}) must be a Boolean.`);
    }
    out[name as K] = a.value.value;
  }
  return out;
}

/** `@selectable` / `@settable` / `@filterable` / `@sortable` of a field, with v7's defaults. */
function readFieldConfig(
  where: string,
  dirs: readonly ConstDirectiveNode[] | undefined,
): FieldConfig {
  const one = (name: string) => {
    const found = (dirs ?? []).filter((d) => d.name.value === name);
    if (found.length > 1) {
      throw new UnsupportedTypeDefsError(`${where}: @${name} is set more than once.`);
    }
    return found[0];
  };
  const selectable = one("selectable");
  const settable = one("settable");
  const filterable = one("filterable");
  const sortable = one("sortable");
  const sel = selectable
    ? booleanArgs(where, selectable, { onRead: true, onAggregate: false })
    : { onRead: true, onAggregate: true };
  const set = settable
    ? booleanArgs(where, settable, { onCreate: true, onUpdate: true })
    : { onCreate: true, onUpdate: true };
  const fil = filterable
    ? booleanArgs(where, filterable, { byValue: true, byAggregate: false })
    : { byValue: true, byAggregate: true };
  const sort = sortable ? booleanArgs(where, sortable, { byValue: true }) : { byValue: true };
  return {
    onRead: sel.onRead !== false,
    onAggregate: sel.onAggregate !== false,
    onCreate: set.onCreate !== false,
    onUpdate: set.onUpdate !== false,
    byValue: fil.byValue !== false,
    byAggregate: fil.byAggregate !== false,
    sortable: sort.byValue !== false,
  };
}

/** `@query(read = true, connection = read, aggregate = false)`. */
function readQueryConfig(where: string, d: ConstDirectiveNode): QueryConfig {
  const a = booleanArgs(where, d, { read: true, connection: undefined, aggregate: false });
  const read = a.read !== false;
  return { read, connection: a.connection ?? read, aggregate: a.aggregate === true };
}

const MUTATION_OPERATIONS = ["CREATE", "UPDATE", "DELETE"] as const;

/** `@mutation(operations = [CREATE, UPDATE, DELETE])`. */
function readMutationConfig(where: string, d: ConstDirectiveNode): MutationConfig {
  for (const a of d.arguments ?? []) {
    if (a.name.value !== "operations") {
      throw new UnsupportedTypeDefsError(
        `${where}: @mutation(${a.name.value}) is not an argument of @mutation.`,
      );
    }
  }
  const v = arg(d, "operations");
  let ops: readonly string[] = MUTATION_OPERATIONS;
  if (v) {
    const values = v.kind === Kind.LIST ? v.values : [v];
    ops = values.map((x) => {
      if (x.kind !== Kind.ENUM || !(MUTATION_OPERATIONS as readonly string[]).includes(x.value)) {
        throw new UnsupportedTypeDefsError(
          `${where}: @mutation(operations) must list CREATE, UPDATE or DELETE.`,
        );
      }
      return x.value;
    });
  }
  return {
    create: ops.includes("CREATE"),
    update: ops.includes("UPDATE"),
    delete: ops.includes("DELETE"),
  };
}

const ALL_QUERIES: QueryConfig = { read: true, connection: true, aggregate: true };
const ALL_MUTATIONS: MutationConfig = { create: true, update: true, delete: true };

/** `@limit(default, max)`, validated like v7 (both positive, `max` at least `default`). */
function readLimit(where: string, d: ConstDirectiveNode | undefined): LimitConfig | undefined {
  if (!d) return undefined;
  const out: { default?: number; max?: number } = {};
  for (const a of d.arguments ?? []) {
    const name = a.name.value;
    if (name !== "default" && name !== "max") {
      throw new UnsupportedTypeDefsError(`${where}: @limit(${name}) is not an argument of @limit.`);
    }
    if (a.value.kind === Kind.NULL) continue;
    if (a.value.kind !== Kind.INT) {
      throw new UnsupportedTypeDefsError(`${where}: @limit ${name} must be a number`);
    }
    const value = Number(a.value.value);
    if (value <= 0) {
      throw new UnsupportedTypeDefsError(
        `${where}: @limit.${name} invalid value: ${value}. Must be greater than 0.`,
      );
    }
    out[name] = value;
  }
  if (out.default !== undefined && out.max !== undefined && out.max < out.default) {
    throw new UnsupportedTypeDefsError(
      `${where}: @limit.max invalid value: ${out.max}. Must be greater than limit.default: ${out.default}.`,
    );
  }
  return out;
}

function deprecationReason(dirs: readonly ConstDirectiveNode[] | undefined): string | undefined {
  const d = directive(dirs, "deprecated");
  if (!d) return undefined;
  return stringArg(d, "reason") ?? "No longer supported";
}

function readAttribute(
  owner: string,
  f: FieldDefinitionNode,
  enums: ReadonlySet<string>,
): Attribute {
  for (const d of f.directives ?? []) {
    if (!ACCEPTED_FIELD_DIRECTIVES.has(d.name.value)) {
      throw new UnsupportedTypeDefsError(
        `${owner}.${f.name.value}: @${d.name.value} is not supported by @cyphra/graphql yet.`,
      );
    }
  }
  const cypher = readCypher(`${owner}.${f.name.value}`, directive(f.directives, "cypher"));
  if (f.arguments?.length && !cypher) {
    throw new UnsupportedTypeDefsError(
      `${owner}.${f.name.value}: field arguments are only supported on @cypher fields.`,
    );
  }
  const type = typeRef(f.type);
  const isEnum = enums.has(type.name);
  if (!isEnum && !(SUPPORTED_SCALARS as readonly string[]).includes(type.name)) {
    if (UNSUPPORTED_SCALARS.has(type.name)) {
      throw new UnsupportedTypeDefsError(
        `${owner}.${f.name.value}: ${type.name} is not supported by @cyphra/graphql yet.`,
      );
    }
    throw new UnsupportedTypeDefsError(
      `${owner}.${f.name.value}: type ${type.name} is not a supported scalar or enum (fields returning objects need @relationship).`,
    );
  }
  const dirs = f.directives;
  const def = directive(dirs, "default");
  const defaultAst = arg(def, "value");
  const ts = directive(dirs, "timestamp");
  const alias = directive(dirs, "alias");
  return {
    name: f.name.value,
    property: stringArg(alias, "property") ?? f.name.value,
    type,
    kind: isEnum ? "enum" : "scalar",
    description: f.description?.value,
    id: !!directive(dirs, "id"),
    defaultAst,
    defaultValue: defaultAst ? valueFromASTUntyped(defaultAst) : undefined,
    timestamp: ts
      ? ((listArg(ts, "operations") ?? ["CREATE", "UPDATE"]) as ("CREATE" | "UPDATE")[])
      : undefined,
    cypher,
    args: readArguments(`${owner}.${f.name.value}`, f, enums),
    deprecated: deprecationReason(dirs),
    auth: readAuthAnnotations(`${owner}.${f.name.value}`, dirs),
    config: readFieldConfig(`${owner}.${f.name.value}`, dirs),
  };
}

function readCypher(
  where: string,
  d: ConstDirectiveNode | undefined,
): CypherAnnotation | undefined {
  if (!d) return undefined;
  for (const a of d.arguments ?? []) {
    if (!["statement", "columnName"].includes(a.name.value)) {
      throw new UnsupportedTypeDefsError(`${where}: @cypher(${a.name.value}) is not supported.`);
    }
  }
  const statement = stringArg(d, "statement");
  const columnName = stringArg(d, "columnName");
  if (!statement || !columnName) {
    throw new UnsupportedTypeDefsError(`${where}: @cypher needs a statement and a columnName.`);
  }
  return { statement, columnName };
}

/** Arguments of a `@cypher` field: scalars and enums (lists of them too). */
function readArguments(
  where: string,
  f: FieldDefinitionNode,
  enums: ReadonlySet<string>,
): FieldArgument[] {
  return (f.arguments ?? []).map((a) => {
    if (a.directives?.length) {
      throw new UnsupportedTypeDefsError(
        `${where}(${a.name.value}): directives on arguments are not supported.`,
      );
    }
    const type = typeRef(a.type);
    const isEnum = enums.has(type.name);
    if (!isEnum && !(SUPPORTED_SCALARS as readonly string[]).includes(type.name)) {
      throw new UnsupportedTypeDefsError(
        `${where}(${a.name.value}): arguments of type ${type.name} are not supported by @cyphra/graphql yet (scalars and enums only).`,
      );
    }
    return {
      name: a.name.value,
      type,
      kind: isEnum ? "enum" : "scalar",
      description: a.description?.value,
      defaultAst: a.defaultValue,
    };
  });
}

function isRecord(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function operationList(
  where: string,
  value: unknown,
  allowed: readonly AuthOperation[],
): AuthOperation[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return list.map((op) => {
    if (typeof op !== "string" || !allowed.includes(op as AuthOperation)) {
      throw new UnsupportedTypeDefsError(`${where}: invalid operation ${String(op)}.`);
    }
    return op as AuthOperation;
  });
}

const RULE_WHERE_KEYS = new Set(["node", "jwt", "AND", "OR", "NOT"]);

/** Checks the shape of a rule `where` (`{ node, jwt, AND, OR, NOT }`); values are compiled later. */
function checkRuleWhere(where: string, value: unknown): AnyRecord {
  if (!isRecord(value))
    throw new UnsupportedTypeDefsError(`${where}: \`where\` must be an object.`);
  for (const [k, v] of Object.entries(value)) {
    if (!RULE_WHERE_KEYS.has(k)) {
      throw new UnsupportedTypeDefsError(`${where}: unknown key ${k} in \`where\`.`);
    }
    if (k === "AND" || k === "OR") {
      if (!Array.isArray(v)) throw new UnsupportedTypeDefsError(`${where}: ${k} must be a list.`);
      v.forEach((x) => checkRuleWhere(where, x));
    } else if (k === "NOT") {
      checkRuleWhere(where, v);
    } else if (!isRecord(v)) {
      throw new UnsupportedTypeDefsError(`${where}: \`${k}\` must be an object.`);
    }
  }
  return value;
}

function readRules(
  where: string,
  value: unknown,
  allowed: readonly AuthOperation[],
): {
  operations: AuthOperation[];
  requireAuthentication: boolean;
  where: AnyRecord;
  raw: AnyRecord;
}[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((rule, i) => {
    const at = `${where}[${i}]`;
    if (!isRecord(rule)) throw new UnsupportedTypeDefsError(`${at}: a rule must be an object.`);
    for (const k of Object.keys(rule)) {
      if (!["operations", "requireAuthentication", "where", "when"].includes(k)) {
        throw new UnsupportedTypeDefsError(`${at}: unknown rule argument ${k}.`);
      }
    }
    if (
      rule.requireAuthentication !== undefined &&
      typeof rule.requireAuthentication !== "boolean"
    ) {
      throw new UnsupportedTypeDefsError(`${at}: requireAuthentication must be a Boolean.`);
    }
    return {
      operations: operationList(at, rule.operations, allowed) ?? [...allowed],
      requireAuthentication: rule.requireAuthentication !== false,
      where: checkRuleWhere(at, rule.where),
      raw: rule,
    };
  });
}

function readAuthentication(
  where: string,
  d: ConstDirectiveNode | undefined,
): AuthenticationAnnotation | undefined {
  if (!d) return undefined;
  for (const a of d.arguments ?? []) {
    if (!["operations", "jwt"].includes(a.name.value)) {
      throw new UnsupportedTypeDefsError(
        `${where}: @authentication(${a.name.value}) is not supported.`,
      );
    }
  }
  const opsArg = arg(d, "operations");
  const jwtArg = arg(d, "jwt");
  const jwt = jwtArg ? valueFromASTUntyped(jwtArg) : undefined;
  if (jwt !== undefined && jwt !== null && !isRecord(jwt)) {
    throw new UnsupportedTypeDefsError(`${where}: @authentication(jwt) must be an object.`);
  }
  const operations =
    operationList(
      `${where} @authentication`,
      opsArg ? valueFromASTUntyped(opsArg) : undefined,
      AUTH_OPERATIONS,
    ) ?? AUTH_OPERATIONS;
  return { operations: new Set(operations), jwt: (jwt as AnyRecord | null) ?? undefined };
}

function readAuthorization(
  where: string,
  d: ConstDirectiveNode | undefined,
): AuthorizationAnnotation | undefined {
  if (!d) return undefined;
  for (const a of d.arguments ?? []) {
    if (!["filter", "validate"].includes(a.name.value)) {
      throw new UnsupportedTypeDefsError(
        `${where}: @authorization(${a.name.value}) is not supported.`,
      );
    }
  }
  const filterArg = arg(d, "filter");
  const validateArg = arg(d, "validate");
  const filter = readRules(
    `${where} @authorization(filter)`,
    filterArg ? valueFromASTUntyped(filterArg) : undefined,
    FILTER_OPERATIONS,
  ).map((r) => {
    if (r.raw.when !== undefined) {
      throw new UnsupportedTypeDefsError(
        `${where} @authorization(filter): \`when\` only applies to validate rules.`,
      );
    }
    return {
      operations: r.operations,
      requireAuthentication: r.requireAuthentication,
      where: r.where,
    };
  });
  const validate = readRules(
    `${where} @authorization(validate)`,
    validateArg ? valueFromASTUntyped(validateArg) : undefined,
    VALIDATE_OPERATIONS,
  ).map((r) => {
    const when = r.raw.when === undefined || r.raw.when === null ? ["BEFORE", "AFTER"] : r.raw.when;
    const list = Array.isArray(when) ? when : [when];
    for (const w of list) {
      if (w !== "BEFORE" && w !== "AFTER") {
        throw new UnsupportedTypeDefsError(
          `${where} @authorization(validate): invalid when ${String(w)}.`,
        );
      }
    }
    return {
      operations: r.operations,
      requireAuthentication: r.requireAuthentication,
      where: r.where,
      when: list as ("BEFORE" | "AFTER")[],
    };
  });
  return { filter, validate };
}

/** `@subscription(events: [CREATED, UPDATED, DELETED])` (the default is every event). */
function readSubscription(
  where: string,
  d: ConstDirectiveNode | undefined,
): ReadonlySet<SubscriptionEvent> | undefined {
  if (!d) return undefined;
  for (const a of d.arguments ?? []) {
    if (a.name.value !== "events") {
      throw new UnsupportedTypeDefsError(
        `${where}: @subscription(${a.name.value}) is not supported.`,
      );
    }
  }
  const eventsArg = arg(d, "events");
  const raw = eventsArg ? valueFromASTUntyped(eventsArg) : undefined;
  if (raw === undefined) return new Set(SUBSCRIPTION_EVENTS);
  const list = Array.isArray(raw) ? raw : [raw];
  for (const e of list) {
    if (!(SUBSCRIPTION_EVENTS as readonly unknown[]).includes(e)) {
      throw new UnsupportedTypeDefsError(`${where} @subscription: invalid event ${String(e)}.`);
    }
  }
  return new Set(list as SubscriptionEvent[]);
}

const SUBSCRIPTIONS_AUTHORIZATION_WHERE_KEYS = new Set(["AND", "OR", "NOT", "node", "jwt"]);

function checkSubscriptionsAuthorizationWhere(
  where: string,
  value: unknown,
  fields: ReadonlySet<string>,
): AnyRecord {
  if (!isRecord(value)) {
    throw new UnsupportedTypeDefsError(`${where}: \`where\` must be an object.`);
  }
  for (const [k, v] of Object.entries(value)) {
    if (!SUBSCRIPTIONS_AUTHORIZATION_WHERE_KEYS.has(k)) {
      throw new UnsupportedTypeDefsError(`${where}: unknown key ${k} in where.`);
    }
    if (k === "AND" || k === "OR") {
      if (!Array.isArray(v)) throw new UnsupportedTypeDefsError(`${where}: ${k} must be a list.`);
      for (const w of v) checkSubscriptionsAuthorizationWhere(where, w, fields);
    } else if (k === "NOT") {
      checkSubscriptionsAuthorizationWhere(where, v, fields);
    } else if (k === "node") {
      checkNodeKeys(where, v, fields);
    } else if (!isRecord(v)) {
      throw new UnsupportedTypeDefsError(`${where}: jwt must be an object.`);
    }
  }
  return value;
}

/** The keys of a `node` filter must be filterable fields (`title`, `title_EQ`, …) or AND/OR/NOT. */
function checkNodeKeys(where: string, value: unknown, fields: ReadonlySet<string>): void {
  if (!isRecord(value)) throw new UnsupportedTypeDefsError(`${where}: node must be an object.`);
  for (const [k, v] of Object.entries(value)) {
    if (k === "AND" || k === "OR") {
      if (!Array.isArray(v)) throw new UnsupportedTypeDefsError(`${where}: ${k} must be a list.`);
      for (const w of v) checkNodeKeys(where, w, fields);
      continue;
    }
    if (k === "NOT") {
      checkNodeKeys(where, v, fields);
      continue;
    }
    const field =
      /^(.+?)(?:_(?:EQ|IN|INCLUDES|CONTAINS|STARTS_WITH|ENDS_WITH|LT|LTE|GT|GTE))?$/.exec(k)?.[1];
    if (!field || !fields.has(field)) {
      throw new UnsupportedTypeDefsError(
        `${where}: ${k} is not a field that events can be filtered on.`,
      );
    }
  }
}

/** `@subscriptionsAuthorization(filter: [{ events, requireAuthentication, where }])`. */
function readSubscriptionsAuthorization(
  where: string,
  d: ConstDirectiveNode | undefined,
  attributes: readonly Attribute[],
): SubscriptionsAuthorizationRule[] | undefined {
  if (!d) return undefined;
  for (const a of d.arguments ?? []) {
    if (a.name.value !== "filter") {
      throw new UnsupportedTypeDefsError(
        `${where}: @subscriptionsAuthorization(${a.name.value}) is not supported.`,
      );
    }
  }
  const at = `${where} @subscriptionsAuthorization`;
  const filterArg = arg(d, "filter");
  const raw = filterArg ? valueFromASTUntyped(filterArg) : undefined;
  if (raw === undefined || raw === null)
    throw new UnsupportedTypeDefsError(`${at}: filter is required.`);
  const fields = new Set(attributes.filter((a) => !a.cypher).map((a) => a.name));
  return (Array.isArray(raw) ? raw : [raw]).map((rule) => {
    if (!isRecord(rule)) throw new UnsupportedTypeDefsError(`${at}: each rule must be an object.`);
    for (const k of Object.keys(rule)) {
      if (!["events", "requireAuthentication", "where"].includes(k)) {
        throw new UnsupportedTypeDefsError(`${at}: unknown rule argument ${k}.`);
      }
    }
    const events =
      rule.events === undefined || rule.events === null ? [...SUBSCRIPTION_EVENTS] : rule.events;
    const list = Array.isArray(events) ? events : [events];
    for (const e of list) {
      if (!(SUBSCRIPTION_EVENTS as readonly unknown[]).includes(e)) {
        throw new UnsupportedTypeDefsError(`${at}: invalid event ${String(e)}.`);
      }
    }
    return {
      events: list as SubscriptionEvent[],
      requireAuthentication: rule.requireAuthentication !== false,
      where:
        rule.where === undefined
          ? {}
          : checkSubscriptionsAuthorizationWhere(at, rule.where, fields),
    };
  });
}

function readAuthAnnotations(
  where: string,
  dirs: readonly ConstDirectiveNode[] | undefined,
): AuthAnnotations | undefined {
  const authentication = readAuthentication(where, directive(dirs, "authentication"));
  const authorization = readAuthorization(where, directive(dirs, "authorization"));
  return authentication || authorization ? { authentication, authorization } : undefined;
}

/** `type JWT @jwt { roles: [String!]! @jwtClaim(path: "app.roles") }`: field name → payload path. */
function readJwtClaims(o: ObjectTypeDefinitionNode): Map<string, string> {
  const claims = new Map<string, string>();
  for (const f of o.fields ?? []) {
    for (const d of f.directives ?? []) {
      if (d.name.value !== "jwtClaim") {
        throw new UnsupportedTypeDefsError(
          `${o.name.value}.${f.name.value}: @${d.name.value} is not supported on the @jwt type.`,
        );
      }
    }
    const path = stringArg(directive(f.directives, "jwtClaim"), "path");
    if (path) claims.set(f.name.value, path);
  }
  return claims;
}

const CYPHER_FIELD_DIRECTIVES = new Set(["cypher", "deprecated", ...FIELD_CONFIG_DIRECTIVES]);

/** A `@cypher` field of a node type returning nodes. */
function readCypherNodeField(
  owner: string,
  f: FieldDefinitionNode,
  enums: ReadonlySet<string>,
): CypherNodeField {
  const where = `${owner}.${f.name.value}`;
  for (const d of f.directives ?? []) {
    if (!CYPHER_FIELD_DIRECTIVES.has(d.name.value)) {
      throw new UnsupportedTypeDefsError(
        `${where}: @${d.name.value} on a @cypher field returning nodes is not supported by @cyphra/graphql yet.`,
      );
    }
  }
  const type = typeRef(f.type);
  return {
    name: f.name.value,
    target: type.name,
    type,
    cypher: readCypher(where, directive(f.directives, "cypher"))!,
    args: readArguments(where, f, enums),
    description: f.description?.value,
    deprecated: deprecationReason(f.directives),
    config: readFieldConfig(where, f.directives),
  };
}

/** `type Query` / `type Mutation`: every field must be a `@cypher` field. */
function readRootType(
  o: ObjectTypeDefinitionNode | undefined,
  enums: ReadonlySet<string>,
  nodes: ReadonlySet<string>,
  unions: ReadonlyMap<string, UnionType>,
): CypherRootType {
  if (!o) return { fields: [], resolved: [] };
  const type = o.name.value;
  let authentication: AuthenticationAnnotation | undefined;
  for (const d of o.directives ?? []) {
    if (d.name.value !== "authentication") {
      throw new UnsupportedTypeDefsError(
        `type ${type}: @${d.name.value} is not supported by @cyphra/graphql yet.`,
      );
    }
    authentication = readAuthentication(`type ${type}`, d);
  }
  const resolved: UserRootField[] = [];
  const fields = (o.fields ?? []).flatMap((f): CypherRootField[] => {
    const where = `${type}.${f.name.value}`;
    for (const d of f.directives ?? []) {
      if (!["cypher", "deprecated", "authentication"].includes(d.name.value)) {
        throw new UnsupportedTypeDefsError(
          `${where}: @${d.name.value} is not supported on ${type} fields by @cyphra/graphql yet.`,
        );
      }
    }
    const cypher = readCypher(where, directive(f.directives, "cypher"));
    if (!cypher) {
      // v7: a root field without @cypher is served by the application's resolvers.
      resolved.push({
        name: f.name.value,
        definition: f,
        authentication: readAuthentication(where, directive(f.directives, "authentication")),
      });
      return [];
    }
    const t = typeRef(f.type);
    if (unions.has(t.name)) {
      throw new UnsupportedTypeDefsError(
        `${where}: @cypher fields returning unions are not supported by @cyphra/graphql yet.`,
      );
    }
    const kind = nodes.has(t.name) ? "node" : enums.has(t.name) ? "enum" : "scalar";
    if (kind === "scalar" && !(SUPPORTED_SCALARS as readonly string[]).includes(t.name)) {
      throw new UnsupportedTypeDefsError(
        `${where}: type ${t.name} is not supported by @cyphra/graphql yet (@node types, scalars and enums only).`,
      );
    }
    return [
      {
        name: f.name.value,
        type: t,
        kind,
        cypher,
        args: readArguments(where, f, enums),
        description: f.description?.value,
        deprecated: deprecationReason(f.directives),
        authentication: readAuthentication(where, directive(f.directives, "authentication")),
      },
    ];
  });
  return { fields, resolved, authentication };
}

/** `union U = A | B`: members must be `@node` types; no directives. */
function readUnions(
  defs: readonly UnionTypeDefinitionNode[],
  nodes: ReadonlySet<string>,
  schemaQuery: QueryConfig | undefined,
): Map<string, UnionType> {
  const unions = new Map<string, UnionType>();
  for (const def of defs) {
    const name = def.name.value;
    if (unions.has(name))
      throw new UnsupportedTypeDefsError(`union ${name}: defined more than once.`);
    let query: QueryConfig | undefined;
    for (const d of def.directives ?? []) {
      if (d.name.value !== "query" || query) {
        throw new UnsupportedTypeDefsError(
          `union ${name}: @${d.name.value} is not supported by @cyphra/graphql yet.`,
        );
      }
      query = readQueryConfig(`union ${name}`, d);
    }
    const members = (def.types ?? []).map((t) => t.name.value);
    if (!members.length) throw new UnsupportedTypeDefsError(`union ${name}: it has no member.`);
    for (const m of members) {
      if (!nodes.has(m)) {
        throw new UnsupportedTypeDefsError(`union ${name}: member ${m} must be a @node type.`);
      }
    }
    unions.set(name, {
      name,
      description: def.description?.value,
      members,
      plural: entityPlural(name),
      read: (query ?? schemaQuery)?.read ?? true,
    });
  }
  return unions;
}

/** `@fulltext(indexes: [{ indexName, queryName, fields }])`. */
function readFulltext(
  owner: string,
  d: ConstDirectiveNode | undefined,
  attributes: readonly Attribute[],
): FulltextIndex[] {
  if (!d) return [];
  const where = `type ${owner} @fulltext`;
  const value = arg(d, "indexes");
  const indexes = value ? (valueFromASTUntyped(value) as unknown) : undefined;
  if (!Array.isArray(indexes))
    throw new UnsupportedTypeDefsError(`${where}: indexes must be a list.`);
  return indexes.map((ix: unknown, i) => {
    if (!isRecord(ix))
      throw new UnsupportedTypeDefsError(`${where}: indexes[${i}] must be an object.`);
    for (const k of Object.keys(ix)) {
      if (!["indexName", "queryName", "fields"].includes(k)) {
        throw new UnsupportedTypeDefsError(`${where}: unknown index argument ${k}.`);
      }
    }
    const { indexName, queryName, fields } = ix;
    if (typeof indexName !== "string" || typeof queryName !== "string" || !Array.isArray(fields)) {
      throw new UnsupportedTypeDefsError(
        `${where}: indexes[${i}] needs indexName, queryName and fields.`,
      );
    }
    for (const field of fields) {
      const a = attributes.find((x) => x.name === field);
      if (!a || a.cypher || (a.type.name !== "String" && a.type.name !== "ID")) {
        throw new UnsupportedTypeDefsError(
          `${where}: field ${String(field)} must be a String or ID field of ${owner}.`,
        );
      }
    }
    return { indexName, queryName, fields: fields as string[] };
  });
}

/** A field of a `@node` type served by the application's resolvers. */
function readUserField(
  owner: string,
  f: FieldDefinitionNode,
  custom: ConstDirectiveNode | undefined,
): UserField {
  const where = `${owner}.${f.name.value}`;
  for (const d of f.directives ?? []) {
    if (!["customResolver", "deprecated", ...FIELD_CONFIG_DIRECTIVES].includes(d.name.value)) {
      throw new UnsupportedTypeDefsError(
        `${where}: @${d.name.value} on a field served by resolvers is not supported by @cyphra/graphql yet.`,
      );
    }
  }
  // v7: `@customResolver` cannot be combined with the field configuration directives.
  if (custom) {
    for (const d of f.directives ?? []) {
      const other =
        d.name.value === "customResolver"
          ? f.directives!.find((x) => FIELD_CONFIG_DIRECTIVES.has(x.name.value))?.name.value
          : FIELD_CONFIG_DIRECTIVES.has(d.name.value)
            ? "customResolver"
            : undefined;
      if (other) {
        throw new UnsupportedTypeDefsError(
          `${where}: Invalid directive usage: Directive @${d.name.value} cannot be used in combination with @${other}`,
        );
      }
    }
  }
  for (const a of custom?.arguments ?? []) {
    if (a.name.value !== "requires") {
      throw new UnsupportedTypeDefsError(
        `${where}: @customResolver(${a.name.value}) is not supported.`,
      );
    }
  }
  const value = arg(custom, "requires");
  if (value && value.kind !== Kind.STRING) {
    throw new UnsupportedTypeDefsError("@customResolver requires expects a string");
  }
  let requires: SelectionSetNode | undefined;
  if (value) {
    try {
      const doc = parse(`{ ${value.value} }`);
      requires = (doc.definitions[0] as { selectionSet: SelectionSetNode }).selectionSet;
    } catch (e) {
      throw new UnsupportedTypeDefsError(
        `Invalid selection set provided to @customResolver on ${owner}:\n${(e as Error).message}`,
      );
    }
  }
  return {
    name: f.name.value,
    definition: f,
    requires,
    config: readFieldConfig(where, f.directives),
  };
}

/**
 * Object, input and union types without `@node` (v7 passes them through to the schema). A union is
 * one when none of its members is a `@node` type; a union mixing both is not supported.
 */
function readUserTypes(
  objects: readonly ObjectTypeDefinitionNode[],
  inputs: readonly InputObjectTypeDefinitionNode[],
  unions: readonly UnionTypeDefinitionNode[],
  nodes: ReadonlySet<string>,
): Map<string, UserTypeDefinition> {
  const out = new Map<string, UserTypeDefinition>();
  const add = (def: UserTypeDefinition, kind: string) => {
    const name = def.name.value;
    if (out.has(name))
      throw new UnsupportedTypeDefsError(`${kind} ${name}: defined more than once.`);
    for (const d of def.directives ?? []) {
      throw new UnsupportedTypeDefsError(
        `${kind} ${name}: @${d.name.value} is not supported by @cyphra/graphql yet.`,
      );
    }
    out.set(name, def);
  };
  for (const o of objects) {
    for (const f of o.fields ?? []) {
      for (const d of f.directives ?? []) {
        if (d.name.value !== "deprecated") {
          throw new UnsupportedTypeDefsError(
            `${o.name.value}.${f.name.value}: @${d.name.value} on a type without @node is not supported by @cyphra/graphql yet.`,
          );
        }
      }
    }
    add(o, "type");
  }
  for (const i of inputs) add(i, "input");
  const plain = new Set(objects.map((o) => o.name.value));
  for (const u of unions) {
    const members = (u.types ?? []).map((t) => t.name.value);
    if (!members.length || !members.every((m) => plain.has(m))) {
      if (members.some((m) => plain.has(m)) && members.some((m) => nodes.has(m))) {
        throw new UnsupportedTypeDefsError(
          `union ${u.name.value}: unions mixing @node types and types without @node are not supported by @cyphra/graphql yet.`,
        );
      }
      continue;
    }
    add(u, "union");
  }
  return out;
}

function namedTypeOf(t: TypeNode): string {
  return t.kind === Kind.NAMED_TYPE ? t.name.value : namedTypeOf(t.type);
}

/**
 * The types fields served by resolvers (and types without `@node`) refer to must be in the schema:
 * scalars, enums, `@node` types, unions and the types without `@node` of the type definitions
 * (input positions take scalars, enums and input types only).
 */
function checkUserTypeReferences(opts: {
  scalarsAndEnums: ReadonlySet<string>;
  outputs: ReadonlySet<string>;
  userTypes: ReadonlyMap<string, UserTypeDefinition>;
  nodes: readonly NodeType[];
  roots: Record<"Query" | "Mutation", CypherRootType>;
}): void {
  const { scalarsAndEnums, outputs, userTypes } = opts;
  const isInput = (n: string) =>
    scalarsAndEnums.has(n) || userTypes.get(n)?.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION;
  const isOutput = (n: string) =>
    scalarsAndEnums.has(n) ||
    outputs.has(n) ||
    (userTypes.has(n) && userTypes.get(n)!.kind !== Kind.INPUT_OBJECT_TYPE_DEFINITION);
  const fail = (where: string, name: string, input: boolean): never => {
    throw new UnsupportedTypeDefsError(
      `${where}: type ${name} is not supported by @cyphra/graphql yet (${input ? "scalars, enums and input types" : "scalars, enums, @node types, unions and object types"} of the type definitions only).`,
    );
  };
  const checkField = (owner: string, f: FieldDefinitionNode) => {
    const where = `${owner}.${f.name.value}`;
    const out = namedTypeOf(f.type);
    if (!isOutput(out)) fail(where, out, false);
    for (const a of f.arguments ?? []) {
      const t = namedTypeOf(a.type);
      if (!isInput(t)) fail(`${where}(${a.name.value})`, t, true);
    }
  };
  for (const def of userTypes.values()) {
    const name = def.name.value;
    if (def.kind === Kind.OBJECT_TYPE_DEFINITION) {
      for (const f of def.fields ?? []) checkField(name, f);
    } else if (def.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION) {
      for (const f of def.fields ?? []) {
        const t = namedTypeOf(f.type);
        if (!isInput(t)) fail(`${name}.${f.name.value}`, t, true);
      }
    }
  }
  for (const n of opts.nodes) for (const f of n.userFields) checkField(n.name, f.definition);
  for (const [type, root] of Object.entries(opts.roots)) {
    for (const f of root.resolved) checkField(type, f.definition);
  }
}

/**
 * Read v7 type definitions. Throws {@link UnsupportedTypeDefsError} for features `@cyphra/graphql`
 * does not serve yet (interfaces, spatial and some temporal types, …), so the generated
 * API never silently differs from v7.
 */
export function readTypeDefs(typeDefs: string): V7Model {
  const doc = parse(typeDefs);
  const objects: ObjectTypeDefinitionNode[] = [];
  const unionDefs: UnionTypeDefinitionNode[] = [];
  const inputDefs: InputObjectTypeDefinitionNode[] = [];
  const enums = new Map<string, EnumType>();
  let schemaAuthentication: AuthenticationAnnotation | undefined;
  let schemaSubscription: ReadonlySet<SubscriptionEvent> | undefined;
  let schemaQuery: QueryConfig | undefined;
  let schemaMutation: MutationConfig | undefined;
  for (const def of doc.definitions) {
    switch (def.kind) {
      case Kind.SCHEMA_EXTENSION:
      case Kind.SCHEMA_DEFINITION: {
        if (def.operationTypes?.length) {
          throw new UnsupportedTypeDefsError(
            "schema: custom root operation types are not supported by @cyphra/graphql yet.",
          );
        }
        for (const d of def.directives ?? []) {
          if (d.name.value === "subscription") {
            if (schemaSubscription) {
              throw new UnsupportedTypeDefsError("schema: @subscription is set more than once.");
            }
            schemaSubscription = readSubscription("schema", d);
            continue;
          }
          if (d.name.value === "query") {
            if (schemaQuery)
              throw new UnsupportedTypeDefsError("schema: @query is set more than once.");
            schemaQuery = readQueryConfig("schema", d);
            continue;
          }
          if (d.name.value === "mutation") {
            if (schemaMutation) {
              throw new UnsupportedTypeDefsError("schema: @mutation is set more than once.");
            }
            schemaMutation = readMutationConfig("schema", d);
            continue;
          }
          if (d.name.value !== "authentication") {
            throw new UnsupportedTypeDefsError(
              `schema: @${d.name.value} is not supported by @cyphra/graphql yet.`,
            );
          }
          if (schemaAuthentication) {
            throw new UnsupportedTypeDefsError("schema: @authentication is set more than once.");
          }
          schemaAuthentication = readAuthentication("schema", d);
        }
        break;
      }
      case Kind.OBJECT_TYPE_DEFINITION:
        objects.push(def);
        break;
      case Kind.UNION_TYPE_DEFINITION:
        unionDefs.push(def);
        break;
      case Kind.INPUT_OBJECT_TYPE_DEFINITION:
        inputDefs.push(def);
        break;
      case Kind.ENUM_TYPE_DEFINITION:
        for (const d of def.directives ?? []) {
          throw new UnsupportedTypeDefsError(
            `enum ${def.name.value}: @${d.name.value} is not supported by @cyphra/graphql yet.`,
          );
        }
        for (const v of def.values ?? []) {
          for (const d of v.directives ?? []) {
            if (d.name.value !== "deprecated") {
              throw new UnsupportedTypeDefsError(
                `enum ${def.name.value}.${v.name.value}: @${d.name.value} is not supported by @cyphra/graphql yet.`,
              );
            }
          }
        }
        enums.set(def.name.value, {
          name: def.name.value,
          description: def.description?.value,
          values: (def.values ?? []).map((v) => ({
            name: v.name.value,
            description: v.description?.value,
            deprecated: deprecationReason(v.directives),
          })),
        });
        break;
      case Kind.SCALAR_TYPE_DEFINITION:
        if (!(SUPPORTED_SCALARS as readonly string[]).includes(def.name.value)) {
          throw new UnsupportedTypeDefsError(
            `scalar ${def.name.value}: custom scalars are not supported by @cyphra/graphql yet.`,
          );
        }
        break;
      case Kind.DIRECTIVE_DEFINITION:
        break;
      default:
        throw new UnsupportedTypeDefsError(
          `${def.kind}${"name" in def && def.name ? ` ${def.name.value}` : ""}: not supported by @cyphra/graphql yet (only object, input, union and enum types).`,
        );
    }
  }
  const enumNames = new Set(enums.keys());

  const properties = new Map<string, PropertiesType>();
  const nodeDefs: ObjectTypeDefinitionNode[] = [];
  const plainDefs: ObjectTypeDefinitionNode[] = [];
  const rootDefs = new Map<string, ObjectTypeDefinitionNode>();
  let jwtClaims: Map<string, string> | undefined;
  for (const o of objects) {
    const name = o.name.value;
    if (name === "Subscription") {
      throw new UnsupportedTypeDefsError(
        "type Subscription: custom subscription fields are not supported by @cyphra/graphql yet (the generated ones come from @subscription).",
      );
    }
    if (name === "Query" || name === "Mutation") {
      if (rootDefs.has(name)) {
        throw new UnsupportedTypeDefsError(`type ${name}: defined more than once.`);
      }
      rootDefs.set(name, o);
      continue;
    }
    if (o.interfaces?.length) {
      throw new UnsupportedTypeDefsError(
        `type ${name}: interfaces are not supported by @cyphra/graphql yet.`,
      );
    }
    for (const d of o.directives ?? []) {
      if (!ACCEPTED_TYPE_DIRECTIVES.has(d.name.value)) {
        throw new UnsupportedTypeDefsError(
          `type ${name}: @${d.name.value} is not supported by @cyphra/graphql yet.`,
        );
      }
    }
    const only = (own: string) => {
      for (const d of o.directives ?? []) {
        if (d.name.value !== own) {
          throw new UnsupportedTypeDefsError(
            `type ${name}: @${d.name.value} cannot be used on a @${own} type.`,
          );
        }
      }
    };
    if (directive(o.directives, "jwt")) {
      only("jwt");
      if (jwtClaims)
        throw new UnsupportedTypeDefsError(`type ${name}: only one @jwt type is allowed.`);
      jwtClaims = readJwtClaims(o);
      continue;
    }
    if (directive(o.directives, "relationshipProperties")) {
      only("relationshipProperties");
      properties.set(name, {
        name,
        attributes: (o.fields ?? []).map((f) => {
          const a = readAttribute(name, f, enumNames);
          if (a.auth) {
            throw new UnsupportedTypeDefsError(
              `${name}.${f.name.value}: @authentication / @authorization on relationship properties are not supported.`,
            );
          }
          return a;
        }),
      });
      continue;
    }
    if (!directive(o.directives, "node")) {
      // v7: an object type without @node is a plain type, served by the application's resolvers.
      plainDefs.push(o);
      continue;
    }
    nodeDefs.push(o);
  }
  // v7: `@query` / `@mutation` go either on the schema or on types, not both.
  for (const [config, name] of [
    [schemaQuery, "query"],
    [schemaMutation, "mutation"],
  ] as const) {
    if (!config) continue;
    if ([...nodeDefs, ...unionDefs].some((t) => directive(t.directives, name))) {
      throw new UnsupportedTypeDefsError(
        `Invalid directive usage: Directive @${name} can only be used in one location: either schema or type.`,
      );
    }
  }
  const nodeNames = new Set(nodeDefs.map((o) => o.name.value));
  const userTypes = readUserTypes(plainDefs, inputDefs, unionDefs, nodeNames);
  const unions = readUnions(
    unionDefs.filter((u) => !userTypes.has(u.name.value)),
    nodeNames,
    schemaQuery,
  );
  const isUserOutput = (t: string) =>
    userTypes.get(t)?.kind !== Kind.INPUT_OBJECT_TYPE_DEFINITION && userTypes.has(t);

  const nodes: NodeType[] = nodeDefs.map((o) => {
    const name = o.name.value;
    const attributes: Attribute[] = [];
    const relationships: Relationship[] = [];
    const cypherNodes: CypherNodeField[] = [];
    const userFields: UserField[] = [];
    for (const f of o.fields ?? []) {
      const rel = directive(f.directives, "relationship");
      const cypher = directive(f.directives, "cypher");
      const custom = directive(f.directives, "customResolver");
      if (custom || (!rel && !cypher && isUserOutput(typeRef(f.type).name))) {
        userFields.push(readUserField(name, f, custom));
        continue;
      }
      if (!rel && unions.has(typeRef(f.type).name)) {
        throw new UnsupportedTypeDefsError(
          `${name}.${f.name.value}: fields returning the union ${typeRef(f.type).name} need @relationship (@cypher fields returning unions are not supported by @cyphra/graphql yet).`,
        );
      }
      if (cypher && !rel && nodeNames.has(typeRef(f.type).name)) {
        cypherNodes.push(readCypherNodeField(name, f, enumNames));
        continue;
      }
      if (!rel) {
        attributes.push(readAttribute(name, f, enumNames));
        continue;
      }
      for (const d of f.directives ?? []) {
        if (d.name.value === "authentication" || d.name.value === "authorization") {
          throw new UnsupportedTypeDefsError(
            `${name}.${f.name.value}: @${d.name.value} on a relationship field is not supported (put the rules on the related type).`,
          );
        }
        if (!RELATIONSHIP_FIELD_DIRECTIVES.has(d.name.value)) {
          throw new UnsupportedTypeDefsError(
            `${name}.${f.name.value}: @${d.name.value} on a relationship field is not supported by @cyphra/graphql yet.`,
          );
        }
      }
      const t = typeRef(f.type);
      if (!nodeNames.has(t.name) && !unions.has(t.name)) {
        throw new UnsupportedTypeDefsError(
          `${name}.${f.name.value}: relationships to ${t.name} are not supported by @cyphra/graphql yet (target must be a @node type or a union of them).`,
        );
      }
      for (const a of rel.arguments ?? []) {
        if (!["type", "direction", "properties"].includes(a.name.value)) {
          throw new UnsupportedTypeDefsError(
            `${name}.${f.name.value}: @relationship(${a.name.value}) is not supported by @cyphra/graphql yet.`,
          );
        }
      }
      if (!t.list && t.required) {
        // v7 rejects these type definitions (a to-one relationship cannot guarantee a node).
        throw new UnsupportedTypeDefsError(
          `${name}.${f.name.value}: Non-list relationship property "${f.name.value}" cannot have non-nullable type.`,
        );
      }
      const config = readFieldConfig(`${name}.${f.name.value}`, f.directives);
      if (!t.list && !config.onRead) {
        // v7 generates a connection type without fields for it: an invalid schema.
        throw new UnsupportedTypeDefsError(
          `${name}.${f.name.value}: @selectable(onRead: false) on a to-one relationship is not supported (@neo4j/graphql 7 generates an invalid schema for it).`,
        );
      }
      const props = stringArg(rel, "properties");
      if (props && !properties.has(props)) {
        throw new UnsupportedTypeDefsError(
          `${name}.${f.name.value}: properties type ${props} must be a @relationshipProperties type.`,
        );
      }
      relationships.push({
        name: f.name.value,
        source: name,
        target: t.name,
        type: stringArg(rel, "type") ?? "",
        direction: stringArg(rel, "direction") === "IN" ? "IN" : "OUT",
        properties: props,
        list: t.list,
        required: t.required,
        elementRequired: t.elementRequired,
        description: f.description?.value,
        deprecated: deprecationReason(f.directives),
        config,
      });
    }
    const nodeDir = directive(o.directives, "node");
    const labels = listArg(nodeDir, "labels") ?? [name];
    const pluralDir = directive(o.directives, "plural");
    const typeQuery = directive(o.directives, "query");
    const typeMutation = directive(o.directives, "mutation");
    const plural = entityPlural(name, stringArg(pluralDir, "value"));
    return {
      name,
      description: o.description?.value,
      labels,
      plural,
      pascalPlural: upperFirst(plural),
      attributes,
      relationships,
      cypherNodes,
      userFields,
      fulltext: readFulltext(name, directive(o.directives, "fulltext"), attributes),
      auth: readAuthAnnotations(`type ${name}`, o.directives) ?? {},
      subscription: readSubscription(`type ${name}`, directive(o.directives, "subscription")),
      subscriptionsAuthorization: readSubscriptionsAuthorization(
        `type ${name}`,
        directive(o.directives, "subscriptionsAuthorization"),
        attributes,
      ),
      query: typeQuery ? readQueryConfig(`type ${name}`, typeQuery) : (schemaQuery ?? ALL_QUERIES),
      mutation: typeMutation
        ? readMutationConfig(`type ${name}`, typeMutation)
        : (schemaMutation ?? ALL_MUTATIONS),
      limit: readLimit(`type ${name}`, directive(o.directives, "limit")),
    };
  });

  const byName0 = new Map(nodes.map((n) => [n.name, n]));
  const root = (type: "Query" | "Mutation"): CypherRootType =>
    readRootType(rootDefs.get(type), enumNames, nodeNames, unions);
  const query = root("Query");
  const mutation = root("Mutation");
  const generated = new Set<string>();
  for (const n of byName0.values()) {
    // Root fields hidden by `@query` can be defined by the application instead (as in v7).
    if (n.query.read) generated.add(n.plural);
    if (n.query.connection || n.query.aggregate) generated.add(`${n.plural}Connection`);
    for (const ft of n.fulltext) {
      if (generated.has(ft.queryName)) {
        throw new UnsupportedTypeDefsError(
          `type ${n.name} @fulltext: queryName ${ft.queryName} is already a Query field.`,
        );
      }
      generated.add(ft.queryName);
    }
  }
  for (const u of unions.values()) {
    if (!u.read) continue;
    if (generated.has(u.plural)) {
      throw new UnsupportedTypeDefsError(
        `union ${u.name}: its root query ${u.plural} conflicts with another generated Query field.`,
      );
    }
    generated.add(u.plural);
  }
  for (const f of [...query.fields, ...query.resolved]) {
    if (generated.has(f.name)) {
      throw new UnsupportedTypeDefsError(
        `Query.${f.name}: conflicts with a generated Query field.`,
      );
    }
  }
  const generatedMutations = new Set(
    [...byName0.values()].flatMap((n) =>
      (["create", "update", "delete"] as const)
        .filter((k) => n.mutation[k])
        .map((k) => `${k}${n.pascalPlural}`),
    ),
  );
  for (const f of [...mutation.fields, ...mutation.resolved]) {
    if (generatedMutations.has(f.name)) {
      throw new UnsupportedTypeDefsError(
        `Mutation.${f.name}: conflicts with a generated Mutation field.`,
      );
    }
  }
  checkUserTypeReferences({
    scalarsAndEnums: new Set([...SUPPORTED_SCALARS, ...enumNames]),
    outputs: new Set([...nodeNames, ...unions.keys()]),
    userTypes,
    nodes,
    roots: { Query: query, Mutation: mutation },
  });

  const byName = new Map(nodes.map((n) => [n.name, n]));
  return {
    nodes,
    unions,
    authentication: schemaAuthentication,
    jwtClaims: jwtClaims ?? new Map(),
    properties,
    enums,
    userTypes,
    query,
    mutation,
    subscription: schemaSubscription,
    node(name: string): NodeType {
      const n = byName.get(name);
      if (!n) throw new Error(`Unknown node type ${name}`);
      return n;
    },
  };
}
