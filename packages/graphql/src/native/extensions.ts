/**
 * Extension points of the native API: computed fields (`$extends({ result })` of the client),
 * Cypher-backed fields (the native `@cypher`), and `extend` (SDL plus resolvers merged into the
 * generated schema, with `ctx.cyphra.selection(info)` to load generated types in one statement).
 *
 * @packageDocumentation
 */

import {
  GraphQLInterfaceType,
  GraphQLObjectType,
  GraphQLUnionType,
  Kind,
  extendSchema,
  getNamedType,
  isAbstractType,
  isObjectType,
  parse,
  parseType,
  type DefinitionNode,
  type DocumentNode,
  type GraphQLFieldResolver,
  type GraphQLNamedType,
  type GraphQLResolveInfo,
  type GraphQLSchema,
  type TypeNode,
} from "graphql";
import { CYPHER_NODE, encodeCypherParam, type CypherFragment } from "@cyphra/runtime";
import type { ResolvedNodeModel, SchemaModel, ScalarTypeName } from "@cyphra/schema";
import type { ApiModel } from "./api.js";
import { NativeSchemaError, type ContextRule } from "./config.js";

type AnyRecord = Record<string, unknown>;
type AnyFn = (...args: never[]) => unknown;

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/**
 * A computed field of the client (`$extends({ result })`), exposed on the model's type: its
 * GraphQL type (`"String!"`), or `{ type, read?, description?, deprecated? }`. `read` is a
 * context-only rule: a denied field is `null` with a `FORBIDDEN` error.
 */
export type ComputedField<Ctx = unknown> =
  | string
  | {
      readonly type: string;
      readonly read?: ContextRule<Ctx>;
      readonly description?: string;
      readonly deprecated?: string;
    };

/** Stands for the node a Cypher-backed field is evaluated on: `` cypher`… (${node}) …` ``. */
export type CypherNode = typeof CYPHER_NODE;

/** An argument of a Cypher-backed field: its GraphQL input type, or `{ type, default?, description? }`. */
export type CypherFieldArg =
  string | { readonly type: string; readonly default?: unknown; readonly description?: string };

/**
 * A Cypher-backed field (the native `@cypher`): a Cypher expression evaluated on each node,
 * compiled into the parent's statement. Rules do not apply inside the expression (it is raw
 * Cypher); the nodes it returns, when it returns nodes, are filtered by their read rules.
 */
export type CypherField<Ctx = unknown> = {
  /**
   * Its GraphQL type: a scalar or an enum (`"Int!"`, `"[String!]!"`), or a model
   * (`"Movie"`, `"[Movie!]!"`: the expression returns nodes, or a list of nodes).
   */
  readonly type: string;
  /** Its arguments, typed as GraphQL input types (`{ since: "DateTime" }`). */
  readonly args?: { readonly [name: string]: CypherFieldArg };
  /**
   * The expression, built with the `cypher` tag: `node` is the node's variable, `args` the field's
   * arguments as Cypher parameters (encoded for their type: `Int` as a Cypher integer, `DateTime`
   * as a date-time), `ctx` the request's context. Every interpolated value is a parameter.
   */
  readonly cypher: {
    bivarianceHack(p: {
      readonly node: CypherNode;
      readonly args: Readonly<Record<string, unknown>>;
      readonly ctx: Ctx;
    }): CypherFragment;
  }["bivarianceHack"];
  /** Whether `where` takes it (default: `true` for a scalar without arguments). */
  readonly filter?: boolean;
  /** Whether `orderBy` takes it (default: `true` for a sortable scalar without arguments). */
  readonly sort?: boolean;
  /** A context-only read rule: a denied field is `null` with a `FORBIDDEN` error. */
  readonly read?: ContextRule<Ctx>;
  readonly description?: string;
  readonly deprecated?: string;
};

/** What `ctx.cyphra` is in custom resolvers: the request's client, rules applied. */
export type CyphraContextClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the delegates of any client
  readonly [delegate: string]: any;
  /**
   * The selection of the field being resolved (a generated type: a model, a list of a model) as
   * the client's `select`, with the request's field rules: spread it into the client call, and
   * return its result as is (`ctx.cyphra.user.findMany({ where, ...ctx.cyphra.selection(info) })`).
   */
  selection(info: GraphQLResolveInfo): { readonly select: Record<string, unknown> };
  /** The client without the API's rules. */
  readonly $unsafe: unknown;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- parents and args of any SDL */
type AnyResolver<Ctx> = GraphQLFieldResolver<
  any,
  Ctx & { readonly cyphra: CyphraContextClient },
  any
>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A resolver of `extend`: a function, or `{ resolve, needs? }` on a generated type. */
export type ExtensionResolver<Ctx = unknown> =
  | AnyResolver<Ctx>
  | {
      readonly resolve: AnyResolver<Ctx>;
      /**
       * On a field added to a generated type: the model's fields the resolver reads from its
       * parent, loaded with the node (`{ name: true }`); the `@id` field always is.
       */
      readonly needs?: Readonly<Record<string, boolean>>;
    };

/**
 * Custom SDL merged into the generated schema, and its resolvers: new types (non-node result
 * types), `extend type Query` / `Mutation` root fields, fields added to generated types.
 */
export type ExtendConfig<Ctx = unknown> = {
  readonly typeDefs: string | DocumentNode | readonly (string | DocumentNode)[];
  readonly resolvers?: {
    readonly [type: string]:
      { readonly [field: string]: ExtensionResolver<Ctx> | undefined } | undefined;
  };
};

// ---------------------------------------------------------------------------
// Resolved config
// ---------------------------------------------------------------------------

/** GraphQL scalars a computed or Cypher-backed field may return, and their Cyphra type. */
const SCALARS: Readonly<Record<string, ScalarTypeName>> = {
  String: "String",
  ID: "String",
  Int: "Int",
  Float: "Float",
  Boolean: "Boolean",
  DateTime: "DateTime",
  Date: "Date",
  LocalDateTime: "LocalDateTime",
  LocalTime: "LocalTime",
  Time: "Time",
  Duration: "Duration",
  BigInt: "BigInt",
  Json: "Json",
};

/** Scalar types `where` and `orderBy` take on a Cypher-backed field. */
const COMPARABLE = new Set<ScalarTypeName>([
  "String",
  "Int",
  "Float",
  "Boolean",
  "DateTime",
  "Date",
  "LocalDateTime",
  "LocalTime",
  "Time",
  "BigInt",
  "Enum",
]);

/** A parsed GraphQL type reference of a computed or Cypher-backed field (or argument). */
export type TypeRef = {
  readonly node: TypeNode;
  /** The named type (`Int`, an enum, a model). */
  readonly name: string;
  /** Its Cyphra scalar type (absent: a model). */
  readonly scalar?: ScalarTypeName;
  readonly enumValues?: readonly string[];
  /** A list (`[X]`). */
  readonly list: boolean;
  /** Non-null outside (`X!`, `[X]!`). */
  readonly nonNull: boolean;
};

export type ResolvedComputed = {
  readonly type: TypeRef;
  readonly read?: AnyFn;
  readonly description?: string;
  readonly deprecated?: string;
};

export type ResolvedCypherArg = {
  readonly type: TypeRef;
  readonly default?: unknown;
  readonly description?: string;
};

export type ResolvedCypherField = {
  readonly type: TypeRef;
  readonly args: ReadonlyMap<string, ResolvedCypherArg>;
  readonly cypher: (p: { node: CypherNode; args: AnyRecord; ctx: unknown }) => unknown;
  readonly filter: boolean;
  readonly sort: boolean;
  readonly read?: AnyFn;
  readonly description?: string;
  readonly deprecated?: string;
};

export type ResolvedExtend = {
  readonly document: DocumentNode;
  readonly resolvers: ReadonlyMap<string, ReadonlyMap<string, unknown>>;
};

export type ResolvedExtensions = {
  readonly computed: ReadonlyMap<string, ReadonlyMap<string, ResolvedComputed>>;
  readonly cypherFields: ReadonlyMap<string, ReadonlyMap<string, ResolvedCypherField>>;
  readonly extend?: ResolvedExtend;
};

const FIELD_NAME = /^[A-Za-z][_0-9A-Za-z]*$/;

function checkKeys(where: string, obj: AnyRecord, allowed: readonly string[]): void {
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined && !allowed.includes(k)) {
      throw new NativeSchemaError(`${where}: unknown key "${k}" (expected ${allowed.join(", ")}).`);
    }
  }
}

/** Parse a type reference (`"[Int!]!"`) against the scalars, the enums and (`models`) the models. */
function typeRef(
  schema: SchemaModel,
  text: unknown,
  where: string,
  allow: { models: boolean; input: boolean },
): TypeRef {
  if (typeof text !== "string")
    throw new NativeSchemaError(`${where} must be a GraphQL type ("Int!").`);
  let node: TypeNode;
  try {
    node = parseType(text);
  } catch {
    throw new NativeSchemaError(`${where}: "${text}" is not a GraphQL type.`);
  }
  let nonNull = false;
  let list = false;
  let inner = node;
  if (inner.kind === Kind.NON_NULL_TYPE) {
    nonNull = true;
    inner = inner.type;
  }
  if (inner.kind === Kind.LIST_TYPE) {
    list = true;
    inner = inner.type;
    if (inner.kind === Kind.NON_NULL_TYPE) inner = inner.type;
    if (inner.kind !== Kind.NAMED_TYPE) {
      throw new NativeSchemaError(`${where}: "${text}": lists of lists are not supported.`);
    }
  }
  const name = (inner as { name: { value: string } }).name.value;
  const scalar = SCALARS[name];
  if (scalar) return { node, name, scalar, list, nonNull };
  const e = (schema.enums ?? []).find((x) => x.name === name);
  if (e) return { node, name, scalar: "Enum", enumValues: e.values, list, nonNull };
  const model = schema.nodes.find((n) => n.name === name);
  if (model && allow.models) return { node, name, list, nonNull };
  throw new NativeSchemaError(
    `${where}: "${name}" is not ${allow.models ? "a scalar, an enum or a model" : "a scalar or an enum"} (${allow.input ? "argument" : "field"} types: ${Object.keys(SCALARS).join(", ")}, the enums of schema.cyphra${allow.models ? ", the models" : ""}).`,
  );
}

/** The models of a config section, checked: known, not abstract, with an object of fields. */
function* sectionFields(
  schema: SchemaModel,
  section: unknown,
  label: string,
): Generator<{ model: ResolvedNodeModel; field: string; def: unknown; at: string }> {
  if (section === undefined) return;
  if (!isPlainObject(section)) throw new NativeSchemaError(`config.${label} must be an object.`);
  for (const [name, fields] of Object.entries(section)) {
    if (fields === undefined) continue;
    const model = schema.nodes.find((n) => n.name === name);
    if (!model) {
      throw new NativeSchemaError(
        `config.${label}: unknown model "${name}" (models: ${schema.nodes.map((n) => n.name).join(", ") || "none"}).`,
      );
    }
    if (model.abstract) {
      throw new NativeSchemaError(
        `config.${label}.${name}: ${name} is an interface or a union; declare ${label} fields on its implementations.`,
      );
    }
    if (!isPlainObject(fields))
      throw new NativeSchemaError(`config.${label}.${name} must be an object.`);
    for (const [field, def] of Object.entries(fields)) {
      if (def === undefined) continue;
      const at = `config.${label}.${name}.${field}`;
      if (!FIELD_NAME.test(field)) {
        throw new NativeSchemaError(
          `${at}: "${field}" is not a GraphQL field name (it cannot start with "_").`,
        );
      }
      if (model.fields.some((f) => f.name === field) || field === "id" || field === "rawId") {
        throw new NativeSchemaError(`${at}: ${name} already has a field "${field}".`);
      }
      yield { model, field, def, at };
    }
  }
}

function optionalString(v: unknown, at: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new NativeSchemaError(`${at} must be a string.`);
  return v;
}

function optionalFn(v: unknown, at: string): AnyFn | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "function")
    throw new NativeSchemaError(`${at} must be a function ({ ctx }) => boolean.`);
  return v as AnyFn;
}

/**
 * Check `config.computed`, `config.cypherFields` and `config.extend`: known, concrete models, field
 * names free on the model (and not a named traversal), type references GraphQL and the schema
 * know, valid SDL.
 */
export function checkExtensions(
  schema: SchemaModel,
  config: AnyRecord,
  taken: (model: string, field: string) => boolean,
): ResolvedExtensions {
  const computed = new Map<string, Map<string, ResolvedComputed>>();
  const cypherFields = new Map<string, Map<string, ResolvedCypherField>>();
  const claim = (model: string, field: string, at: string) => {
    if (
      taken(model, field) ||
      computed.get(model)?.has(field) ||
      cypherFields.get(model)?.has(field)
    ) {
      throw new NativeSchemaError(`${at}: ${model} already has a field "${field}".`);
    }
  };

  for (const { model, field, def, at } of sectionFields(schema, config.computed, "computed")) {
    claim(model.name, field, at);
    const spec = typeof def === "string" ? { type: def } : def;
    if (!isPlainObject(spec))
      throw new NativeSchemaError(`${at} must be a GraphQL type or { type, read? }.`);
    checkKeys(at, spec, ["type", "read", "description", "deprecated"]);
    const resolved: ResolvedComputed = {
      type: typeRef(schema, spec.type, `${at}.type`, { models: false, input: false }),
      ...(spec.read !== undefined ? { read: optionalFn(spec.read, `${at}.read`) } : {}),
      ...(spec.description !== undefined
        ? { description: optionalString(spec.description, `${at}.description`) }
        : {}),
      ...(spec.deprecated !== undefined
        ? { deprecated: optionalString(spec.deprecated, `${at}.deprecated`) }
        : {}),
    };
    if (!computed.has(model.name)) computed.set(model.name, new Map());
    computed.get(model.name)!.set(field, resolved);
  }

  for (const { model, field, def, at } of sectionFields(
    schema,
    config.cypherFields,
    "cypherFields",
  )) {
    claim(model.name, field, at);
    if (!isPlainObject(def))
      throw new NativeSchemaError(`${at} must be an object ({ type, cypher }).`);
    checkKeys(at, def, [
      "type",
      "args",
      "cypher",
      "filter",
      "sort",
      "read",
      "description",
      "deprecated",
    ]);
    if (typeof def.cypher !== "function") {
      throw new NativeSchemaError(
        `${at}.cypher must be a function ({ node, args, ctx }) => cypher\`…\`.`,
      );
    }
    const type = typeRef(schema, def.type, `${at}.type`, { models: true, input: false });
    const args = new Map<string, ResolvedCypherArg>();
    if (def.args !== undefined) {
      if (!isPlainObject(def.args)) throw new NativeSchemaError(`${at}.args must be an object.`);
      for (const [name, a] of Object.entries(def.args)) {
        if (a === undefined) continue;
        const aat = `${at}.args.${name}`;
        if (!FIELD_NAME.test(name))
          throw new NativeSchemaError(`${aat}: not a GraphQL argument name.`);
        const spec = typeof a === "string" ? { type: a } : a;
        if (!isPlainObject(spec))
          throw new NativeSchemaError(`${aat} must be a GraphQL type or { type, default? }.`);
        checkKeys(aat, spec, ["type", "default", "description"]);
        args.set(name, {
          type: typeRef(schema, spec.type, `${aat}.type`, { models: false, input: true }),
          ...(spec.default !== undefined ? { default: spec.default } : {}),
          ...(spec.description !== undefined
            ? { description: optionalString(spec.description, `${aat}.description`) }
            : {}),
        });
      }
    }
    const comparable = type.scalar !== undefined && !type.list && COMPARABLE.has(type.scalar);
    const usable = comparable && args.size === 0;
    for (const k of ["filter", "sort"] as const) {
      if (def[k] === undefined) continue;
      if (typeof def[k] !== "boolean") throw new NativeSchemaError(`${at}.${k} must be a boolean.`);
      if (def[k] && !usable) {
        throw new NativeSchemaError(
          `${at}.${k}: only a Cypher-backed field returning one ${[...COMPARABLE].join(", ")} value, without arguments, can be ${k === "filter" ? "filtered" : "sorted"} on.`,
        );
      }
    }
    const resolved: ResolvedCypherField = {
      type,
      args,
      cypher: def.cypher as ResolvedCypherField["cypher"],
      filter: usable && def.filter !== false,
      sort: usable && def.sort !== false && type.scalar !== "Boolean",
      ...(def.read !== undefined ? { read: optionalFn(def.read, `${at}.read`) } : {}),
      ...(def.description !== undefined
        ? { description: optionalString(def.description, `${at}.description`) }
        : {}),
      ...(def.deprecated !== undefined
        ? { deprecated: optionalString(def.deprecated, `${at}.deprecated`) }
        : {}),
    };
    if (!cypherFields.has(model.name)) cypherFields.set(model.name, new Map());
    cypherFields.get(model.name)!.set(field, resolved);
  }

  return {
    computed,
    cypherFields,
    ...(config.extend !== undefined ? { extend: checkExtend(config.extend) } : {}),
  };
}

function checkExtend(extend: unknown): ResolvedExtend {
  if (!isPlainObject(extend))
    throw new NativeSchemaError("config.extend must be an object ({ typeDefs, resolvers }).");
  checkKeys("config.extend", extend, ["typeDefs", "resolvers"]);
  const parts = Array.isArray(extend.typeDefs) ? extend.typeDefs : [extend.typeDefs];
  if (parts.length === 0 || extend.typeDefs === undefined) {
    throw new NativeSchemaError(
      "config.extend.typeDefs must be SDL (a string or a parsed document).",
    );
  }
  const definitions: DefinitionNode[] = [];
  for (const [i, p] of parts.entries()) {
    let doc: DocumentNode;
    if (typeof p === "string") {
      try {
        doc = parse(p);
      } catch (e) {
        throw new NativeSchemaError(
          `config.extend.typeDefs${parts.length > 1 ? `[${i}]` : ""}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } else if (isPlainObject(p) && p.kind === Kind.DOCUMENT) doc = p as unknown as DocumentNode;
    else
      throw new NativeSchemaError(
        "config.extend.typeDefs must be SDL (a string or a parsed document).",
      );
    for (const d of doc.definitions) {
      if (d.kind === Kind.OPERATION_DEFINITION || d.kind === Kind.FRAGMENT_DEFINITION) {
        throw new NativeSchemaError(
          "config.extend.typeDefs takes type definitions, not operations.",
        );
      }
      definitions.push(d);
    }
  }
  const resolvers = new Map<string, Map<string, unknown>>();
  if (extend.resolvers !== undefined) {
    if (!isPlainObject(extend.resolvers))
      throw new NativeSchemaError("config.extend.resolvers must be an object.");
    for (const [type, fields] of Object.entries(extend.resolvers)) {
      if (fields === undefined) continue;
      if (!isPlainObject(fields)) {
        throw new NativeSchemaError(
          `config.extend.resolvers.${type} must be an object of field resolvers.`,
        );
      }
      const m = new Map<string, unknown>();
      for (const [f, r] of Object.entries(fields)) {
        if (r === undefined) continue;
        const at = `config.extend.resolvers.${type}.${f}`;
        if (typeof r !== "function") {
          if (!isPlainObject(r) || typeof r.resolve !== "function") {
            throw new NativeSchemaError(`${at} must be a function or { resolve, needs? }.`);
          }
          checkKeys(at, r, ["resolve", "needs"]);
          if (r.needs !== undefined && !isPlainObject(r.needs)) {
            throw new NativeSchemaError(`${at}.needs must be an object ({ field: true }).`);
          }
        }
        m.set(f, r);
      }
      resolvers.set(type, m);
    }
  }
  return { document: { kind: Kind.DOCUMENT, definitions }, resolvers };
}

/** The client's encoding of a Cypher-backed field's argument values, by their declared types. */
export function cypherArgs(def: ResolvedCypherField, values: AnyRecord): AnyRecord {
  const out: AnyRecord = {};
  for (const [name, a] of def.args) {
    const v = values[name];
    out[name] =
      v === undefined || v === null
        ? null
        : encodeCypherParam(a.type.scalar!, v, {
            list: a.type.list,
            ...(a.type.enumValues ? { enumValues: a.type.enumValues } : {}),
            where: name,
          });
  }
  return out;
}

// ---------------------------------------------------------------------------
// extend: merging SDL and resolvers
// ---------------------------------------------------------------------------

const ROOTS = ["Query", "Mutation", "Subscription"] as const;

/**
 * The extension document as `extendSchema` takes it: `extend type Mutation` when the generated
 * API has no mutation (all writes off) becomes `type Mutation`, set as the mutation root.
 */
function rootsFor(schema: GraphQLSchema, doc: DocumentNode): DocumentNode {
  const defined = new Set(
    doc.definitions.flatMap((d) => (d.kind === Kind.OBJECT_TYPE_DEFINITION ? [d.name.value] : [])),
  );
  const definitions: DefinitionNode[] = [];
  const added: string[] = [];
  for (const d of doc.definitions) {
    if (
      d.kind === Kind.OBJECT_TYPE_EXTENSION &&
      (ROOTS as readonly string[]).includes(d.name.value) &&
      !schema.getType(d.name.value) &&
      !defined.has(d.name.value)
    ) {
      defined.add(d.name.value);
      added.push(d.name.value);
      definitions.push({ ...d, kind: Kind.OBJECT_TYPE_DEFINITION });
      continue;
    }
    definitions.push(d);
  }
  for (const d of definitions) {
    if (
      d.kind === Kind.OBJECT_TYPE_DEFINITION &&
      d.name.value !== "Query" &&
      (ROOTS as readonly string[]).includes(d.name.value) &&
      !added.includes(d.name.value) &&
      !schema.getType(d.name.value)
    ) {
      added.push(d.name.value);
    }
  }
  const ops = added
    .filter((n) => n !== "Query")
    .filter((n) => !(n === "Mutation" ? schema.getMutationType() : schema.getSubscriptionType()));
  if (ops.length > 0) {
    definitions.push({
      kind: Kind.SCHEMA_EXTENSION,
      operationTypes: ops.map((n) => ({
        kind: Kind.OPERATION_TYPE_DEFINITION,
        operation: n === "Mutation" ? ("mutation" as never) : ("subscription" as never),
        type: { kind: Kind.NAMED_TYPE, name: { kind: Kind.NAME, value: n } },
      })),
    });
  }
  return { kind: Kind.DOCUMENT, definitions };
}

/** Field names each type of the extension document declares (definitions and extensions). */
function declaredFields(doc: DocumentNode): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const d of doc.definitions) {
    if (
      d.kind !== Kind.OBJECT_TYPE_DEFINITION &&
      d.kind !== Kind.OBJECT_TYPE_EXTENSION &&
      d.kind !== Kind.INTERFACE_TYPE_DEFINITION &&
      d.kind !== Kind.INTERFACE_TYPE_EXTENSION
    )
      continue;
    const set = out.get(d.name.value) ?? new Set<string>();
    for (const f of d.fields ?? []) set.add(f.name.value);
    out.set(d.name.value, set);
  }
  return out;
}

/** How the extension's resolvers are run (by `makeSchema`; absent for `printSchema`). */
export type ExtensionRuntime = {
  /** Wrap a resolver of `type.field`: sessions, parents, result shaping, error mapping. */
  readonly wrap: (
    resolve: GraphQLFieldResolver<unknown, unknown>,
    field: { type: string; field: string; model?: ResolvedNodeModel },
  ) => GraphQLFieldResolver<unknown, unknown>;
};

/**
 * Merge `extend` into the generated schema: the SDL is validated against it (a field colliding
 * with a generated one is an error), then each resolver is attached to its field. A field added to
 * a generated type needs a resolver.
 */
export function applyExtend(
  api: ApiModel,
  schema: GraphQLSchema,
  extend: ResolvedExtend,
  runtime?: ExtensionRuntime,
): GraphQLSchema {
  let extended: GraphQLSchema;
  try {
    extended = extendSchema(schema, rootsFor(schema, extend.document));
  } catch (e) {
    throw new NativeSchemaError(
      `config.extend.typeDefs: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const declared = declaredFields(extend.document);
  const generatedModel = (name: string) => {
    const m = api.nodes.get(name);
    return m && schema.getType(name) ? m : undefined;
  };
  for (const [type, fields] of declared) {
    const model = generatedModel(type);
    if (!model) continue;
    for (const f of fields) {
      if (!extend.resolvers.get(type)?.has(f)) {
        throw new NativeSchemaError(
          `config.extend: ${type}.${f} is added to a generated type and needs a resolver (config.extend.resolvers.${type}.${f}).`,
        );
      }
    }
  }
  for (const [type, fields] of extend.resolvers) {
    const t = extended.getType(type);
    if (!t)
      throw new NativeSchemaError(
        `config.extend.resolvers.${type}: no type "${type}" in the schema.`,
      );
    if (!(t instanceof GraphQLObjectType) && !(t instanceof GraphQLInterfaceType)) {
      throw new NativeSchemaError(
        `config.extend.resolvers.${type}: ${type} is not an object type.`,
      );
    }
    const defs = t.getFields();
    for (const [f] of fields) {
      if (!defs[f])
        throw new NativeSchemaError(
          `config.extend.resolvers.${type}.${f}: ${type} has no field "${f}".`,
        );
      if (!declared.get(type)?.has(f)) {
        throw new NativeSchemaError(
          `config.extend.resolvers.${type}.${f}: ${type}.${f} is generated; only fields of config.extend.typeDefs take resolvers.`,
        );
      }
    }
  }
  // Attach (wrapped) resolvers. Fields of the extension returning generated types get a wrapper
  // too (it shapes what they return), resolver or not.
  for (const [type, fields] of declared) {
    const t = extended.getType(type);
    if (!(t instanceof GraphQLObjectType)) continue;
    const defs = t.getFields();
    for (const f of fields) {
      const def = defs[f]!;
      const r = extend.resolvers.get(type)?.get(f);
      const fn = (
        typeof r === "function" ? r : (r as { resolve?: unknown } | undefined)?.resolve
      ) as GraphQLFieldResolver<unknown, unknown> | undefined;
      if (!runtime) continue;
      const base: GraphQLFieldResolver<unknown, unknown> =
        fn ?? ((src) => (isPlainObject(src) ? (src as AnyRecord)[f] : undefined));
      const model = generatedModel(type);
      def.resolve = runtime.wrap(base, { type, field: f, ...(model ? { model } : {}) });
    }
  }
  return extended;
}

/** The `needs` of a resolver of a field added to a generated type. */
export function resolverNeeds(
  extend: ResolvedExtend | undefined,
  type: string,
  field: string,
): string[] {
  const r = extend?.resolvers.get(type)?.get(field);
  if (!isPlainObject(r) || !isPlainObject(r.needs)) return [];
  return Object.entries(r.needs)
    .filter(([, v]) => v)
    .map(([k]) => k);
}

/** The generated model a GraphQL output type stands for (a model's object, interface or union). */
export function modelOfType(
  api: ApiModel,
  schema: GraphQLSchema,
  type: unknown,
): ResolvedNodeModel | undefined {
  const named = getNamedType(type as never) as GraphQLNamedType | undefined;
  if (!named) return undefined;
  const model = api.nodes.get(named.name);
  if (!model) return undefined;
  if (!(isObjectType(named) || isAbstractType(named) || named instanceof GraphQLUnionType))
    return undefined;
  return schema.getType(named.name) === named ? model : undefined;
}
