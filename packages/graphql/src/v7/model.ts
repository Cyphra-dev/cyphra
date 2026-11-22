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
  type ObjectTypeDefinitionNode,
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

/** The custom fields of `Query` or `Mutation`, with the type-level `@authentication`. */
export type CypherRootType = {
  readonly fields: readonly CypherRootField[];
  readonly authentication?: AuthenticationAnnotation;
};

/** One index of `@fulltext(indexes: [{ indexName, queryName, fields }])`. */
export type FulltextIndex = {
  readonly indexName: string;
  /** Root query field, e.g. `moviesByTitle`. */
  readonly queryName: string;
  readonly fields: readonly string[];
};

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
  /** `@fulltext` indexes. */
  readonly fulltext: readonly FulltextIndex[];
  readonly auth: AuthAnnotations;
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
  /** `@cypher` fields of `type Query` / `type Mutation`. */
  readonly query: CypherRootType;
  readonly mutation: CypherRootType;
  node(name: string): NodeType;
};

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

/** Directives without an effect on the read API that are accepted as-is. */
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
  "coalesce",
  "unique",
]);
const ACCEPTED_TYPE_DIRECTIVES = new Set([
  "node",
  "fulltext",
  "plural",
  "authentication",
  "authorization",
  "relationshipProperties",
  "jwt",
]);

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

const CYPHER_FIELD_DIRECTIVES = new Set(["cypher", "deprecated"]);

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
  };
}

/** `type Query` / `type Mutation`: every field must be a `@cypher` field. */
function readRootType(
  o: ObjectTypeDefinitionNode | undefined,
  enums: ReadonlySet<string>,
  nodes: ReadonlySet<string>,
  unions: ReadonlyMap<string, UnionType>,
): CypherRootType {
  if (!o) return { fields: [] };
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
  const fields = (o.fields ?? []).map((f): CypherRootField => {
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
      throw new UnsupportedTypeDefsError(
        `${where}: custom ${type} fields need @cypher (custom resolvers are not supported by @cyphra/graphql).`,
      );
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
    return {
      name: f.name.value,
      type: t,
      kind,
      cypher,
      args: readArguments(where, f, enums),
      description: f.description?.value,
      deprecated: deprecationReason(f.directives),
      authentication: readAuthentication(where, directive(f.directives, "authentication")),
    };
  });
  return { fields, authentication };
}

/** `union U = A | B`: members must be `@node` types; no directives. */
function readUnions(
  defs: readonly UnionTypeDefinitionNode[],
  nodes: ReadonlySet<string>,
): Map<string, UnionType> {
  const unions = new Map<string, UnionType>();
  for (const def of defs) {
    const name = def.name.value;
    if (unions.has(name))
      throw new UnsupportedTypeDefsError(`union ${name}: defined more than once.`);
    for (const d of def.directives ?? []) {
      throw new UnsupportedTypeDefsError(
        `union ${name}: @${d.name.value} is not supported by @cyphra/graphql yet.`,
      );
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

/**
 * Read v7 type definitions. Throws {@link UnsupportedTypeDefsError} for features `@cyphra/graphql`
 * does not serve yet (interfaces, spatial and some temporal types, …), so the generated
 * API never silently differs from v7.
 */
export function readTypeDefs(typeDefs: string): V7Model {
  const doc = parse(typeDefs);
  const objects: ObjectTypeDefinitionNode[] = [];
  const unionDefs: UnionTypeDefinitionNode[] = [];
  const enums = new Map<string, EnumType>();
  let schemaAuthentication: AuthenticationAnnotation | undefined;
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
      case Kind.ENUM_TYPE_DEFINITION:
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
          `${def.kind}${"name" in def && def.name ? ` ${def.name.value}` : ""}: not supported by @cyphra/graphql yet (only object types, unions, enums and relationship properties).`,
        );
    }
  }
  const enumNames = new Set(enums.keys());

  const properties = new Map<string, PropertiesType>();
  const nodeDefs: ObjectTypeDefinitionNode[] = [];
  const rootDefs = new Map<string, ObjectTypeDefinitionNode>();
  let jwtClaims: Map<string, string> | undefined;
  for (const o of objects) {
    const name = o.name.value;
    if (name === "Subscription") {
      throw new UnsupportedTypeDefsError(
        "type Subscription: subscriptions are not supported by @cyphra/graphql yet.",
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
    if (directive(o.directives, "jwt")) {
      if (jwtClaims)
        throw new UnsupportedTypeDefsError(`type ${name}: only one @jwt type is allowed.`);
      jwtClaims = readJwtClaims(o);
      continue;
    }
    if (directive(o.directives, "relationshipProperties")) {
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
      throw new UnsupportedTypeDefsError(
        `type ${name}: object types without @node are not supported by @cyphra/graphql yet.`,
      );
    }
    nodeDefs.push(o);
  }
  const nodeNames = new Set(nodeDefs.map((o) => o.name.value));
  const unions = readUnions(unionDefs, nodeNames);

  const nodes: NodeType[] = nodeDefs.map((o) => {
    const name = o.name.value;
    const attributes: Attribute[] = [];
    const relationships: Relationship[] = [];
    const cypherNodes: CypherNodeField[] = [];
    for (const f of o.fields ?? []) {
      const rel = directive(f.directives, "relationship");
      const cypher = directive(f.directives, "cypher");
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
      });
    }
    const nodeDir = directive(o.directives, "node");
    const labels = listArg(nodeDir, "labels") ?? [name];
    const pluralDir = directive(o.directives, "plural");
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
      fulltext: readFulltext(name, directive(o.directives, "fulltext"), attributes),
      auth: readAuthAnnotations(`type ${name}`, o.directives) ?? {},
    };
  });

  const byName0 = new Map(nodes.map((n) => [n.name, n]));
  const root = (type: "Query" | "Mutation"): CypherRootType =>
    readRootType(rootDefs.get(type), enumNames, nodeNames, unions);
  const query = root("Query");
  const mutation = root("Mutation");
  const generated = new Set<string>();
  for (const n of byName0.values()) {
    generated.add(n.plural);
    generated.add(`${n.plural}Connection`);
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
    if (generated.has(u.plural)) {
      throw new UnsupportedTypeDefsError(
        `union ${u.name}: its root query ${u.plural} conflicts with another generated Query field.`,
      );
    }
    generated.add(u.plural);
  }
  for (const f of query.fields) {
    if (generated.has(f.name)) {
      throw new UnsupportedTypeDefsError(
        `Query.${f.name}: conflicts with a generated Query field.`,
      );
    }
  }
  const generatedMutations = new Set(
    [...byName0.values()].flatMap((n) =>
      ["create", "update", "delete"].map((k) => `${k}${n.pascalPlural}`),
    ),
  );
  for (const f of mutation.fields) {
    if (generatedMutations.has(f.name)) {
      throw new UnsupportedTypeDefsError(
        `Mutation.${f.name}: conflicts with a generated Mutation field.`,
      );
    }
  }

  const byName = new Map(nodes.map((n) => [n.name, n]));
  return {
    nodes,
    unions,
    authentication: schemaAuthentication,
    jwtClaims: jwtClaims ?? new Map(),
    properties,
    enums,
    query,
    mutation,
    node(name: string): NodeType {
      const n = byName.get(name);
      if (!n) throw new Error(`Unknown node type ${name}`);
      return n;
    },
  };
}
