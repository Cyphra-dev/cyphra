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
  /** User `@deprecated(reason)` on the field. */
  readonly deprecated?: string;
};

export type Relationship = {
  readonly name: string;
  readonly source: string;
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
};

export type AuthRules = {
  /** Operations covered by `@authentication` (all operations when the directive has no args). */
  readonly authentication?: readonly string[];
  /** `@authorization` present on the type. */
  readonly authorization: boolean;
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
  readonly auth: AuthRules;
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

export type V7Model = {
  readonly nodes: readonly NodeType[];
  readonly properties: ReadonlyMap<string, PropertiesType>;
  readonly enums: ReadonlyMap<string, EnumType>;
  node(name: string): NodeType;
};

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
  if (f.arguments?.length) {
    throw new UnsupportedTypeDefsError(
      `${owner}.${f.name.value}: field arguments are not supported by @cyphra/graphql yet.`,
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
  const cypher = directive(dirs, "cypher");
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
    cypher: cypher
      ? {
          statement: stringArg(cypher, "statement") ?? "",
          columnName: stringArg(cypher, "columnName") ?? "",
        }
      : undefined,
    deprecated: deprecationReason(dirs),
  };
}

const ALL_OPERATIONS = [
  "READ",
  "AGGREGATE",
  "CREATE",
  "UPDATE",
  "DELETE",
  "CREATE_RELATIONSHIP",
  "DELETE_RELATIONSHIP",
  "SUBSCRIBE",
];

/**
 * Read v7 type definitions. Throws {@link UnsupportedTypeDefsError} for features `@cyphra/graphql`
 * does not serve yet (interfaces, unions, spatial and some temporal types, …), so the generated
 * API never silently differs from v7.
 */
export function readTypeDefs(typeDefs: string): V7Model {
  const doc = parse(typeDefs);
  const objects: ObjectTypeDefinitionNode[] = [];
  const enums = new Map<string, EnumType>();
  for (const def of doc.definitions) {
    switch (def.kind) {
      case Kind.OBJECT_TYPE_DEFINITION:
        objects.push(def);
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
          `${def.kind}${"name" in def && def.name ? ` ${def.name.value}` : ""}: not supported by @cyphra/graphql yet (only object types, enums and relationship properties).`,
        );
    }
  }
  const enumNames = new Set(enums.keys());

  const properties = new Map<string, PropertiesType>();
  const nodeDefs: ObjectTypeDefinitionNode[] = [];
  for (const o of objects) {
    const name = o.name.value;
    if (["Query", "Mutation", "Subscription"].includes(name)) {
      throw new UnsupportedTypeDefsError(
        `type ${name}: custom root fields are not supported by @cyphra/graphql yet.`,
      );
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
    if (directive(o.directives, "jwt")) continue;
    if (directive(o.directives, "relationshipProperties")) {
      properties.set(name, {
        name,
        attributes: (o.fields ?? []).map((f) => readAttribute(name, f, enumNames)),
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

  const nodes: NodeType[] = nodeDefs.map((o) => {
    const name = o.name.value;
    const attributes: Attribute[] = [];
    const relationships: Relationship[] = [];
    for (const f of o.fields ?? []) {
      const rel = directive(f.directives, "relationship");
      if (!rel) {
        attributes.push(readAttribute(name, f, enumNames));
        continue;
      }
      const t = typeRef(f.type);
      if (!nodeNames.has(t.name)) {
        throw new UnsupportedTypeDefsError(
          `${name}.${f.name.value}: relationships to ${t.name} are not supported by @cyphra/graphql yet (target must be a @node type).`,
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
    const authn = directive(o.directives, "authentication");
    return {
      name,
      description: o.description?.value,
      labels,
      plural,
      pascalPlural: upperFirst(plural),
      attributes,
      relationships,
      auth: {
        authentication: authn ? (listArg(authn, "operations") ?? ALL_OPERATIONS) : undefined,
        authorization: !!directive(o.directives, "authorization"),
      },
    };
  });

  const byName = new Map(nodes.map((n) => [n.name, n]));
  return {
    nodes,
    properties,
    enums,
    node(name: string): NodeType {
      const n = byName.get(name);
      if (!n) throw new Error(`Unknown node type ${name}`);
      return n;
    },
  };
}

/** Whether READ on this type needs authentication or authorization (#74, not implemented yet). */
export function readNeedsAuth(node: NodeType): boolean {
  return node.auth.authorization || (node.auth.authentication?.includes("READ") ?? false);
}
