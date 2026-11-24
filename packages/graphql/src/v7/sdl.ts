/**
 * Generates the GraphQL schema `@neo4j/graphql` v7 builds from type definitions: root queries and
 * mutations, connection and edge types, every `where` / `sort` / `create` / `update` / `connect` /
 * `disconnect` / `delete` input, aggregate selection types, and the deprecated `field_OPERATOR`
 * fields v7 still prints. Names, descriptions and deprecation reasons are the v7 ones, so the
 * printed SDL is identical. Types, fields, arguments, input fields and enum values also come in the
 * order v7 generates them (see {@link inV7TypeOrder}), so `printSchema` output is byte-identical
 * without sorting: applications that commit the printed schema see no diff when they switch.
 *
 * Only types reachable from `Query` / `Mutation` / `Subscription` end up in the schema (as with v7).
 *
 * @packageDocumentation
 */

import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLDeprecatedDirective,
  GraphQLUnionType,
  getDirectiveValues,
  isEnumType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isUnionType,
  Kind,
  valueFromAST,
  type FieldDefinitionNode,
  type InputValueDefinitionNode,
  type TypeNode,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigArgumentMap,
  type GraphQLFieldConfigMap,
  type GraphQLInputFieldConfig,
  type GraphQLInputFieldConfigMap,
  type GraphQLInputType,
  type GraphQLNamedType,
  type GraphQLOutputType,
  type GraphQLScalarType,
  type GraphQLType,
} from "graphql";
import {
  declaredRelationship,
  implementationRelationships,
  isInterface,
  isUnionRelationship,
  subscriptionEvents,
  SUBSCRIPTION_EVENTS,
  unionMembers,
  type Attribute,
  type CypherNodeField,
  type CypherRootField,
  type FieldArgument,
  type InterfaceType,
  type NodeType,
  type PropertiesType,
  type Relationship,
  type TypeRef,
  type UnionType,
  type UserField,
  type UserTypeDefinition,
  type V7Model,
} from "./model.js";
import { pluralize, subscriptionNames, upperFirst } from "./naming.js";
import { GraphQLBigInt, GraphQLDate, GraphQLDateTime } from "./scalars.js";

const SCALARS: Record<string, GraphQLScalarType> = {
  ID: GraphQLID,
  String: GraphQLString,
  Int: GraphQLInt,
  Float: GraphQLFloat,
  Boolean: GraphQLBoolean,
  BigInt: GraphQLBigInt,
  Date: GraphQLDate,
  DateTime: GraphQLDateTime,
};

const NUMERIC_OR_TEMPORAL = new Set(["Int", "Float", "BigInt", "Date", "DateTime"]);
/** Scalars that get an aggregate selection (`min` / `max` / …) and aggregation filters. */
const AGGREGABLE = new Set(["String", "Int", "Float", "BigInt", "DateTime"]);

const nn = <T extends GraphQLType>(t: T) => new GraphQLNonNull(t);
const list = <T extends GraphQLType>(t: T) => new GraphQLList(t);

type Quantifier = "all" | "none" | "single" | "some";
const QUANTIFIERS: Quantifier[] = ["all", "none", "single", "some"];
const QUANTIFIER_WORD: Record<Quantifier, string> = {
  all: "all",
  none: "none",
  single: "one",
  some: "some",
};

function aggregableType(a: Attribute): boolean {
  return !a.type.list && !a.cypher && a.kind === "scalar" && AGGREGABLE.has(a.type.name);
}

/** In aggregate selections (`@selectable(onAggregate)`). */
export function isAggregable(a: Attribute): boolean {
  return aggregableType(a) && a.config.onAggregate;
}

/** In aggregation filters (`@filterable(byAggregate)`). */
export function isAggregationFilterable(a: Attribute): boolean {
  return aggregableType(a) && a.config.byAggregate;
}

/** In sort inputs (`@sortable`): not lists, not `@cypher` fields with arguments. */
function isSortable(a: Attribute): boolean {
  return !a.type.list && !a.args.length && a.config.sortable;
}

/** v7 adds `_emptyInput` to node create / update inputs that would have no field. */
function nonEmpty(fields: GraphQLInputFieldConfigMap): GraphQLInputFieldConfigMap {
  if (Object.keys(fields).length) return fields;
  return {
    _emptyInput: {
      type: GraphQLBoolean,
      description:
        "Appears because this input type would be empty otherwise because this type is composed of just generated and/or relationship properties. See https://neo4j.com/docs/graphql-manual/current/troubleshooting/faqs/",
    },
  };
}

/** Builds (once) and caches every named type of the generated schema. */
class TypeRegistry {
  private readonly types = new Map<string, GraphQLNamedType>();

  constructor(readonly model: V7Model) {}

  get<T extends GraphQLNamedType>(name: string, create: () => T): T {
    let t = this.types.get(name);
    if (!t) {
      t = create();
      this.types.set(name, t);
    }
    return t as T;
  }

  input(
    name: string,
    fields: () => GraphQLInputFieldConfigMap,
    description?: string,
  ): GraphQLInputObjectType {
    return this.get(name, () => new GraphQLInputObjectType({ name, description, fields }));
  }

  object(
    name: string,
    fields: () => GraphQLFieldConfigMap<unknown, unknown>,
    description?: string,
  ): GraphQLObjectType {
    return this.get(name, () => new GraphQLObjectType({ name, description, fields }));
  }

  // -------------------------------------------------------------------------
  // Shared types
  // -------------------------------------------------------------------------

  namedType(name: string): GraphQLScalarType | GraphQLEnumType {
    const scalar = SCALARS[name];
    if (scalar) return scalar;
    const e = this.model.enums.get(name);
    if (!e) throw new Error(`Unknown type ${name}`);
    return this.get(
      name,
      () =>
        new GraphQLEnumType({
          name,
          description: e.description,
          values: Object.fromEntries(
            e.values.map((v) => [
              v.name,
              { value: v.name, description: v.description, deprecationReason: v.deprecated },
            ]),
          ),
        }),
    );
  }

  /** The declared output type of an attribute, e.g. `[String!]!`. */
  attributeType(t: TypeRef): GraphQLOutputType & GraphQLInputType {
    const named = this.namedType(t.name);
    if (t.list) {
      const inner = list(t.elementRequired ? nn(named) : named);
      return t.required ? nn(inner) : inner;
    }
    return t.required ? nn(named) : named;
  }

  sortDirection(): GraphQLEnumType {
    return this.get(
      "SortDirection",
      () =>
        new GraphQLEnumType({
          name: "SortDirection",
          description: "An enum for sorting in either ascending or descending order.",
          values: {
            ASC: { value: "ASC", description: "Sort by field values in ascending order." },
            DESC: { value: "DESC", description: "Sort by field values in descending order." },
          },
        }),
    );
  }

  pageInfo(): GraphQLObjectType {
    return this.object(
      "PageInfo",
      () => ({
        hasNextPage: { type: nn(GraphQLBoolean) },
        hasPreviousPage: { type: nn(GraphQLBoolean) },
        startCursor: { type: GraphQLString },
        endCursor: { type: GraphQLString },
      }),
      "Pagination information (Relay)",
    );
  }

  createInfo(): GraphQLObjectType {
    return this.object(
      "CreateInfo",
      () => ({
        nodesCreated: { type: nn(GraphQLInt) },
        relationshipsCreated: { type: nn(GraphQLInt) },
      }),
      "Information about the number of nodes and relationships created during a create mutation",
    );
  }

  deleteInfo(): GraphQLObjectType {
    return this.object(
      "DeleteInfo",
      () => ({
        nodesDeleted: { type: nn(GraphQLInt) },
        relationshipsDeleted: { type: nn(GraphQLInt) },
      }),
      "Information about the number of nodes and relationships deleted during a delete mutation",
    );
  }

  updateInfo(): GraphQLObjectType {
    return this.object(
      "UpdateInfo",
      () => ({
        nodesCreated: { type: nn(GraphQLInt) },
        nodesDeleted: { type: nn(GraphQLInt) },
        relationshipsCreated: { type: nn(GraphQLInt) },
        relationshipsDeleted: { type: nn(GraphQLInt) },
      }),
      "Information about the number of nodes and relationships created and deleted during an update mutation",
    );
  }

  count(): GraphQLObjectType {
    return this.object("Count", () => ({ nodes: { type: nn(GraphQLInt) } }));
  }

  countConnection(): GraphQLObjectType {
    return this.object("CountConnection", () => ({
      nodes: { type: nn(GraphQLInt) },
      edges: { type: nn(GraphQLInt) },
    }));
  }

  /** `IntScalarFilters`, `StringListFilters`, `OrderStatusEnumScalarFilters`, … */
  scalarFilters(a: { type: TypeRef; kind: "scalar" | "enum" }): GraphQLInputObjectType {
    const t = a.type.name;
    const named = this.namedType(t);
    if (a.kind === "enum") {
      if (a.type.list) {
        return this.input(
          `${t}ListEnumScalarFilters`,
          () => ({ eq: { type: list(nn(named)) }, includes: { type: named } }),
          `${t} filters`,
        );
      }
      return this.input(
        `${t}EnumScalarFilters`,
        () => ({ eq: { type: named }, in: { type: list(nn(named)) } }),
        `${t} filters`,
      );
    }
    if (a.type.list) {
      if (t === "Boolean") {
        return this.input(
          "BooleanListFilters",
          () => ({ eq: { type: list(nn(named)) } }),
          "Boolean list filters",
        );
      }
      return this.input(
        `${t}ListFilters`,
        () => ({ eq: { type: list(nn(named)) }, includes: { type: named } }),
        `${t} list filters`,
      );
    }
    if (t === "Boolean") {
      return this.input("BooleanScalarFilters", () => ({ eq: { type: named } }), "Boolean filters");
    }
    if (t === "String" || t === "ID") {
      return this.input(
        `${t}ScalarFilters`,
        () => ({
          eq: { type: named },
          in: { type: list(nn(named)) },
          contains: { type: named },
          endsWith: { type: named },
          startsWith: { type: named },
        }),
        `${t} filters`,
      );
    }
    return this.input(
      `${t}ScalarFilters`,
      () => ({
        eq: { type: named },
        gt: { type: named },
        gte: { type: named },
        in: { type: list(nn(named)) },
        lt: { type: named },
        lte: { type: named },
      }),
      `${t} filters`,
    );
  }

  intFilters(): GraphQLInputObjectType {
    return this.scalarFilters({ type: scalarRef("Int"), kind: "scalar" });
  }

  floatFilters(): GraphQLInputObjectType {
    return this.scalarFilters({ type: scalarRef("Float"), kind: "scalar" });
  }

  /** `IntScalarMutations`, `ListStringMutations`, `OrderStatusEnumScalarMutations`, … */
  scalarMutations(a: Attribute): GraphQLInputObjectType {
    const t = a.type.name;
    const named = this.namedType(t);
    if (a.type.list) {
      return this.input(
        a.kind === "enum" ? `List${t}EnumScalarMutations` : `List${t}Mutations`,
        () => ({
          set: { type: list(nn(named)) },
          push: { type: list(nn(named)) },
          pop: { type: GraphQLInt },
        }),
        `Mutations for a list for ${t}`,
      );
    }
    if (a.kind === "enum") {
      return this.input(
        `${t}EnumScalarMutations`,
        () => ({ set: { type: named } }),
        `${t} mutations`,
      );
    }
    switch (t) {
      case "Int":
      case "BigInt":
        return this.input(
          `${t}ScalarMutations`,
          () => ({ set: { type: named }, add: { type: named }, subtract: { type: named } }),
          `${t} mutations`,
        );
      case "Float":
        return this.input(
          "FloatScalarMutations",
          () => ({
            set: { type: named },
            add: { type: named },
            subtract: { type: named },
            multiply: { type: named },
            divide: { type: named },
          }),
          "Float mutations",
        );
      default:
        return this.input(
          `${t}ScalarMutations`,
          () => ({ set: { type: named } }),
          `${t} mutations`,
        );
    }
  }

  /** `IntAggregateSelection`, `StringAggregateSelection`, … */
  aggregateSelection(t: string): GraphQLObjectType {
    const named = this.namedType(t);
    switch (t) {
      case "String":
        return this.object("StringAggregateSelection", () => ({
          shortest: { type: GraphQLString },
          longest: { type: GraphQLString },
        }));
      case "Int":
        return this.object("IntAggregateSelection", () => ({
          max: { type: GraphQLInt },
          min: { type: GraphQLInt },
          average: { type: GraphQLFloat },
          sum: { type: GraphQLInt },
        }));
      case "Float":
      case "BigInt":
        return this.object(`${t}AggregateSelection`, () => ({
          max: { type: named },
          min: { type: named },
          average: { type: named },
          sum: { type: named },
        }));
      default:
        return this.object(`${t}AggregateSelection`, () => ({
          min: { type: named },
          max: { type: named },
        }));
    }
  }

  /** `IntScalarAggregationFilters`, … */
  aggregationFilters(t: string): GraphQLInputObjectType {
    switch (t) {
      case "String":
        return this.input(
          "StringScalarAggregationFilters",
          () => ({
            averageLength: { type: this.floatFilters() },
            shortestLength: { type: this.intFilters() },
            longestLength: { type: this.intFilters() },
          }),
          "Filters for an aggregation of a string field",
        );
      case "Int":
        return this.input(
          "IntScalarAggregationFilters",
          () => ({
            average: { type: this.floatFilters() },
            max: { type: this.intFilters() },
            min: { type: this.intFilters() },
            sum: { type: this.intFilters() },
          }),
          "Filters for an aggregation of an int field",
        );
      case "Float":
        return this.input(
          "FloatScalarAggregationFilters",
          () => ({
            average: { type: this.floatFilters() },
            max: { type: this.floatFilters() },
            min: { type: this.floatFilters() },
            sum: { type: this.floatFilters() },
          }),
          "Filters for an aggregation of a float field",
        );
      case "BigInt": {
        const f = () => this.scalarFilters({ type: scalarRef("BigInt"), kind: "scalar" });
        return this.input(
          "BigIntScalarAggregationFilters",
          () => ({
            average: { type: f() },
            max: { type: f() },
            min: { type: f() },
            sum: { type: f() },
          }),
          "Filters for an aggregation of an BigInt field",
        );
      }
      default: {
        const f = () => this.scalarFilters({ type: scalarRef(t), kind: "scalar" });
        return this.input(
          `${t}ScalarAggregationFilters`,
          () => ({ max: { type: f() }, min: { type: f() } }),
          `Filters for an aggregation of an ${t} input field`,
        );
      }
    }
  }

  connectionAggregationCountFilter(): GraphQLInputObjectType {
    return this.input("ConnectionAggregationCountFilterInput", () => ({
      nodes: { type: this.intFilters() },
      edges: { type: this.intFilters() },
    }));
  }

  // -------------------------------------------------------------------------
  // Attribute-level field maps (shared by nodes and relationship properties)
  // -------------------------------------------------------------------------

  /** `where` fields of attributes, with the deprecated `field_OPERATOR` variants. */
  attributeWhereFields(attributes: readonly Attribute[]): GraphQLInputFieldConfigMap {
    const out: GraphQLInputFieldConfigMap = {};
    for (const a of attributes) this.attributeWhereField(a, out);
    return out;
  }

  /** The `where` fields of one attribute (none for `@cypher` fields with arguments). */
  private attributeWhereField(a: Attribute, out: GraphQLInputFieldConfigMap): void {
    // v7: `@cypher` fields with arguments cannot be filtered on.
    if (a.args.length || !a.config.byValue) return;
    out[a.name] = { type: this.scalarFilters(a), deprecationReason: a.deprecated };
    const named = this.namedType(a.type.name);
    const dep = (op: string) =>
      a.deprecated ?? `Please use the relevant generic filter ${a.name}: { ${op}: ... }`;
    out[`${a.name}_EQ`] = {
      type: a.type.list ? list(a.type.elementRequired ? nn(named) : named) : named,
      deprecationReason: dep("eq"),
    };
    if (a.kind === "scalar" && a.type.name === "Boolean") return;
    if (a.type.list) {
      out[`${a.name}_INCLUDES`] = { type: named, deprecationReason: dep("includes") };
      return;
    }
    out[`${a.name}_IN`] = {
      type: list(a.type.required ? nn(named) : named),
      deprecationReason: dep("in"),
    };
    if (a.kind === "scalar" && NUMERIC_OR_TEMPORAL.has(a.type.name)) {
      for (const op of ["LT", "LTE", "GT", "GTE"]) {
        out[`${a.name}_${op}`] = { type: named, deprecationReason: dep(op.toLowerCase()) };
      }
      return;
    }
    if (a.kind === "scalar" && (a.type.name === "String" || a.type.name === "ID")) {
      out[`${a.name}_CONTAINS`] = { type: named, deprecationReason: dep("contains") };
      out[`${a.name}_STARTS_WITH`] = { type: named, deprecationReason: dep("startsWith") };
      out[`${a.name}_ENDS_WITH`] = { type: named, deprecationReason: dep("endsWith") };
    }
  }

  /** Aggregation `where` fields (`name: StringScalarAggregationFilters`, `name_AVERAGE_LENGTH_GT`…). */
  aggregationWhereFields(
    self: () => GraphQLInputObjectType,
    attributes: readonly Attribute[],
  ): GraphQLInputFieldConfigMap {
    // v7 order: `AND`, `OR`, `NOT`, then per attribute the deprecated `field_OP_CMP` fields
    // (comparator by comparator) and the generic `field` filter.
    const out: GraphQLInputFieldConfigMap = {
      AND: { type: list(nn(self())) },
      OR: { type: list(nn(self())) },
      NOT: { type: self() },
    };
    for (const a of attributes) {
      if (!isAggregationFilterable(a)) continue;
      const t = a.type.name;
      const named = this.namedType(t);
      const ops: [string, string, GraphQLInputType][] =
        t === "String"
          ? [
              ["AVERAGE_LENGTH", "averageLength", GraphQLFloat],
              ["LONGEST_LENGTH", "longestLength", GraphQLInt],
              ["SHORTEST_LENGTH", "shortestLength", GraphQLInt],
            ]
          : t === "Int"
            ? [
                ["MIN", "min", GraphQLInt],
                ["MAX", "max", GraphQLInt],
                ["SUM", "sum", GraphQLInt],
                ["AVERAGE", "average", GraphQLFloat],
              ]
            : t === "Float" || t === "BigInt"
              ? [
                  ["MIN", "min", named],
                  ["MAX", "max", named],
                  ["SUM", "sum", named],
                  ["AVERAGE", "average", named],
                ]
              : [
                  ["MIN", "min", named],
                  ["MAX", "max", named],
                ];
      for (const [cmp, op] of [
        ["EQUAL", "eq"],
        ["GT", "gt"],
        ["GTE", "gte"],
        ["LT", "lt"],
        ["LTE", "lte"],
      ] as const) {
        for (const [legacy, generic, type] of ops) {
          out[`${a.name}_${legacy}_${cmp}`] = {
            type,
            deprecationReason: `Please use the relevant generic filter '${a.name}: { ${generic}: { ${op}: ... } } }' instead.`,
          };
        }
      }
      out[a.name] = { type: this.aggregationFilters(t) };
    }
    return out;
  }

  /** Create input fields of attributes (`@id`, `@cypher` and `@timestamp(CREATE)` excluded). */
  attributeCreateFields(attributes: readonly Attribute[]): GraphQLInputFieldConfigMap {
    const out: GraphQLInputFieldConfigMap = {};
    for (const a of attributes) {
      if (a.id || a.cypher || a.timestamp?.includes("CREATE") || !a.config.onCreate) continue;
      const type = this.attributeType(a.type);
      const field: GraphQLInputFieldConfig = { type, deprecationReason: a.deprecated };
      if (a.defaultAst) field.defaultValue = valueFromAST(a.defaultAst, type);
      out[a.name] = field;
    }
    return out;
  }

  /** Update input fields of attributes, with the deprecated `field_SET` / `_INCREMENT` / … */
  attributeUpdateFields(attributes: readonly Attribute[]): GraphQLInputFieldConfigMap {
    const out: GraphQLInputFieldConfigMap = {};
    for (const a of attributes) {
      if (a.id || a.cypher || a.timestamp?.includes("UPDATE") || !a.config.onUpdate) continue;
      const named = this.namedType(a.type.name);
      out[a.name] = { type: this.scalarMutations(a), deprecationReason: a.deprecated };
      const generic = (op: string) =>
        a.deprecated ?? `Please use the generic mutation '${a.name}: { ${op}: ... } }' instead.`;
      const relevant = (op: string) =>
        a.deprecated ??
        `Please use the relevant generic mutation '${a.name}: { ${op}: ... } }' instead.`;
      if (a.type.list) {
        out[`${a.name}_SET`] = { type: list(nn(named)), deprecationReason: generic("set") };
        out[`${a.name}_POP`] = { type: GraphQLInt, deprecationReason: generic("pop") };
        out[`${a.name}_PUSH`] = { type: list(nn(named)), deprecationReason: generic("push") };
        continue;
      }
      out[`${a.name}_SET`] = { type: named, deprecationReason: generic("set") };
      if (a.kind !== "scalar") continue;
      if (a.type.name === "Int" || a.type.name === "BigInt") {
        out[`${a.name}_INCREMENT`] = { type: named, deprecationReason: relevant("increment") };
        out[`${a.name}_DECREMENT`] = { type: named, deprecationReason: relevant("decrement") };
      } else if (a.type.name === "Float") {
        for (const op of ["add", "subtract", "multiply", "divide"]) {
          out[`${a.name}_${op.toUpperCase()}`] = { type: named, deprecationReason: relevant(op) };
        }
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Relationship properties
  // -------------------------------------------------------------------------

  propertiesObject(p: PropertiesType): GraphQLObjectType {
    const users = this.model.nodes.flatMap((n) =>
      n.relationships.filter((r) => r.properties === p.name).map((r) => `* ${n.name}.${r.name}`),
    );
    return this.object(
      p.name,
      () => attributeOutputFields(this, p.attributes),
      `The edge properties for the following fields:\n${users.join("\n")}`,
    );
  }

  propertiesWhere(p: PropertiesType): GraphQLInputObjectType {
    const self = (): GraphQLInputObjectType => this.propertiesWhere(p);
    return this.input(`${p.name}Where`, () => ({
      ...this.attributeWhereFields(p.attributes),
      OR: { type: list(nn(self())) },
      AND: { type: list(nn(self())) },
      NOT: { type: self() },
    }));
  }

  /**
   * `ActedInSort`: v7 lists every property here, `@sortable(byValue: false)` ones included (and
   * sorts on them).
   */
  propertiesSort(p: PropertiesType): GraphQLInputObjectType | undefined {
    const sortable = p.attributes.filter((a) => !a.args.length);
    if (!sortable.length) return undefined;
    return this.input(`${p.name}Sort`, () =>
      Object.fromEntries(sortable.map((a) => [a.name, { type: this.sortDirection() }])),
    );
  }

  propertiesCreate(p: PropertiesType): GraphQLInputObjectType {
    return this.input(`${p.name}CreateInput`, () => this.attributeCreateFields(p.attributes));
  }

  /** `ActedInCreateInput!` when some property is required on create. */
  propertiesCreateRef(p: PropertiesType): GraphQLInputType {
    const t = this.propertiesCreate(p);
    const required = p.attributes.some(
      (a) =>
        !a.id &&
        !a.cypher &&
        !a.timestamp?.includes("CREATE") &&
        a.config.onCreate &&
        a.type.required &&
        a.defaultAst === undefined,
    );
    return required ? nn(t) : t;
  }

  propertiesUpdate(p: PropertiesType): GraphQLInputObjectType {
    return this.input(`${p.name}UpdateInput`, () => this.attributeUpdateFields(p.attributes));
  }

  propertiesAggregationWhere(p: PropertiesType): GraphQLInputObjectType {
    const self = (): GraphQLInputObjectType => this.propertiesAggregationWhere(p);
    return this.input(`${p.name}AggregationWhereInput`, () =>
      this.aggregationWhereFields(self, p.attributes),
    );
  }

  // -------------------------------------------------------------------------
  // Nodes
  // -------------------------------------------------------------------------

  /** The object type of a `@node` type (the interface type of an interface). */
  node(n: NodeType): GraphQLObjectType {
    if (isInterface(n)) return this.interfaceType(n) as unknown as GraphQLObjectType;
    return this.get(
      n.name,
      () =>
        new GraphQLObjectType({
          name: n.name,
          description: n.description,
          fields: () => this.nodeFields(n),
          interfaces: () =>
            (n.interfaces ?? [])
              .filter((i) => this.model.interfaces.has(i))
              .map((i) => this.interfaceType(this.model.interfaces.get(i)!)),
        }),
    );
  }

  /** `interface LearningActivity`: v7 prints it without its description. */
  interfaceType(i: InterfaceType): GraphQLInterfaceType {
    return this.get(
      i.name,
      () => new GraphQLInterfaceType({ name: i.name, fields: () => this.nodeFields(i) }),
    );
  }

  /** `LearningActivityImplementation`: the implementations (the `typename` filter). */
  implementationEnum(i: InterfaceType): GraphQLEnumType {
    const name = `${i.name}Implementation`;
    return this.get(
      name,
      () =>
        new GraphQLEnumType({
          name,
          values: Object.fromEntries(i.implementations.map((m) => [m, { value: m }])),
        }),
    );
  }

  private nodeFields(n: NodeType): GraphQLFieldConfigMap<unknown, unknown> {
    // v7 order: attributes, `@cypher` fields and fields served by resolvers in definition order,
    // then each relationship and its connection.
    const fields: GraphQLFieldConfigMap<unknown, unknown> = {};
    for (const f of inDefinitionOrder<Attribute | UserField | CypherNodeField>(n, [
      ...n.attributes,
      ...n.userFields,
      ...n.cypherNodes,
    ])) {
      if (!f.config.onRead) continue;
      if ("definition" in f) {
        fields[f.name] = this.fieldFromAST(f.definition);
      } else if ("target" in f) {
        fields[f.name] = {
          type: this.nodeRefType(f.type, f.target),
          description: f.description,
          deprecationReason: f.deprecated,
          args: argumentConfigs(this, f.args),
        };
      } else {
        Object.assign(fields, attributeOutputFields(this, [f]));
      }
    }
    for (const r of n.relationships) {
      // v7: without `@selectable(onRead)`, a list relationship keeps its connection field
      // for the `aggregate` selection (not for unions, which have none).
      const connectionOnly = !r.config.onRead;
      if (connectionOnly && isUnionRelationship(this.model, r)) continue;
      if (!r.list) {
        // v7: a to-one relationship and its connection take no arguments.
        fields[r.name] = {
          type: relationshipType(this, r),
          description: r.description,
          deprecationReason: r.deprecated,
        };
        fields[`${r.name}Connection`] = {
          type: nn(this.relConnection(r)),
          deprecationReason: r.deprecated,
        };
        continue;
      }
      if (isUnionRelationship(this.model, r)) {
        const u = this.model.unions.get(r.target)!;
        fields[r.name] = {
          type: relationshipType(this, r),
          description: r.description,
          deprecationReason: r.deprecated,
          args: {
            where: { type: this.unionWhere(u) },
            limit: { type: GraphQLInt },
            offset: { type: GraphQLInt },
          },
        };
        fields[`${r.name}Connection`] = {
          type: nn(this.relConnection(r)),
          deprecationReason: r.deprecated,
          args: {
            where: { type: this.relConnectionWhere(r) },
            first: { type: GraphQLInt },
            after: { type: GraphQLString },
            ...sortArg(this.relConnectionSort(r)),
          },
        };
        continue;
      }
      const target = this.model.node(r.target);
      if (!connectionOnly) {
        fields[r.name] = {
          type: relationshipType(this, r),
          description: r.description,
          deprecationReason: r.deprecated,
          args: {
            where: { type: this.nodeWhere(target) },
            limit: { type: GraphQLInt },
            offset: { type: GraphQLInt },
            ...sortArg(this.nodeSort(target)),
          },
        };
      }
      fields[`${r.name}Connection`] = {
        type: nn(this.relConnection(r)),
        deprecationReason: r.deprecated,
        args: {
          where: { type: this.relConnectionWhere(r) },
          first: { type: GraphQLInt },
          after: { type: GraphQLString },
          ...sortArg(this.relConnectionSort(r)),
        },
      };
    }
    return fields;
  }

  // -------------------------------------------------------------------------
  // Subscriptions (CDC events)
  // -------------------------------------------------------------------------

  eventType(): GraphQLEnumType {
    return this.get(
      "EventType",
      () =>
        new GraphQLEnumType({
          name: "EventType",
          values: Object.fromEntries(
            ["CREATE", "DELETE", "UPDATE", "CREATE_RELATIONSHIP", "DELETE_RELATIONSHIP"].map(
              (v) => [v, { value: v }],
            ),
          ),
        }),
    );
  }

  /** `MovieEventPayload`: the scalar and enum fields (`@cypher` ones included, like v7). */
  eventPayload(n: NodeType): GraphQLObjectType {
    return this.object(subscriptionNames(n.name).payload, () =>
      attributeOutputFields(this, n.attributes),
    );
  }

  /** `MovieSubscriptionWhere`: property filters only (no relationship or `@cypher` filters). */
  subscriptionWhere(n: NodeType): GraphQLInputObjectType {
    return this.input(subscriptionNames(n.name).where, () => {
      const self = this.subscriptionWhere(n);
      return {
        ...this.attributeWhereFields(n.attributes.filter((a) => !a.cypher)),
        OR: { type: list(nn(self)) },
        AND: { type: list(nn(self)) },
        NOT: { type: self },
      };
    });
  }

  /** `MovieCreatedEvent` / `MovieUpdatedEvent` / `MovieDeletedEvent`. */
  subscriptionEvent(n: NodeType, event: (typeof SUBSCRIPTION_EVENTS)[number]): GraphQLObjectType {
    const names = subscriptionNames(n.name)[event];
    return this.object(names.type, () => {
      const fields: GraphQLFieldConfigMap<unknown, unknown> = {
        event: { type: nn(this.eventType()) },
        timestamp: { type: nn(GraphQLFloat) },
      };
      if (n.attributes.length) {
        const payload = nn(this.eventPayload(n));
        if (event === "UPDATED") fields.previousState = { type: payload };
        fields[names.payload] = { type: payload };
      }
      return fields;
    });
  }

  /** `MovieSort`, or nothing when no field is sortable (v7 then omits every `sort` argument). */
  nodeSort(n: NodeType): GraphQLInputObjectType | undefined {
    if (!n.attributes.some(isSortable)) return undefined;
    return this.input(
      `${n.name}Sort`,
      () =>
        Object.fromEntries(
          n.attributes.filter(isSortable).map((a) => [a.name, { type: this.sortDirection() }]),
        ),
      `Fields to sort ${n.pascalPlural} by. The order in which sorts are applied is not guaranteed when specifying many fields in one ${n.name}Sort object.`,
    );
  }

  nodeWhere(n: NodeType): GraphQLInputObjectType {
    return this.input(`${n.name}Where`, () => {
      const self = this.nodeWhere(n);
      // v7 order: attribute and `@cypher` filters in definition order, `OR` / `AND` / `NOT`,
      // `typename`, then the relationship filters.
      const out: GraphQLInputFieldConfigMap = {};
      for (const f of inDefinitionOrder<Attribute | CypherNodeField>(n, [
        ...n.attributes,
        ...n.cypherNodes,
      ])) {
        if (!("target" in f)) {
          this.attributeWhereField(f, out);
          continue;
        }
        const c = f;
        if (c.args.length || !c.config.byValue) continue;
        const target = this.model.node(c.target);
        if (!c.type.list) {
          out[c.name] = { type: this.nodeWhere(target) };
          continue;
        }
        // v7 prints the `_ALL` / … variants of `@cypher` fields without description or deprecation.
        for (const q of QUANTIFIERS)
          out[`${c.name}_${q.toUpperCase()}`] = { type: this.nodeWhere(target) };
        out[c.name] = { type: this.relationshipFilters(target) };
      }
      out.OR = { type: list(nn(self)) };
      out.AND = { type: list(nn(self)) };
      out.NOT = { type: self };
      if (isInterface(n)) out.typename = { type: list(nn(this.implementationEnum(n))) };
      const sourcePlural = pluralize(n.name);
      for (const r of n.relationships) {
        const union = isUnionRelationship(this.model, r)
          ? this.model.unions.get(r.target)!
          : undefined;
        const target = union ?? this.model.node(r.target);
        const targetWhere = union ? this.unionWhere(union) : this.nodeWhere(target as NodeType);
        const connWhere = this.relConnectionWhere(r);
        if (!r.list) {
          // v7: `lab: LabWhere` and `labConnection: SessionLabConnectionWhere`, nothing else.
          out[r.name] = { type: targetWhere };
          out[`${r.name}Connection`] = { type: connWhere };
          continue;
        }
        const connPlural = pluralize(this.connName(r));
        const byValue = r.config.byValue;
        // v7: no aggregation filters on unions.
        const byAggregate = r.config.byAggregate && !union;
        if (!byValue && !byAggregate) continue;
        // v7 order: `rel`, `rel_ALL` … `rel_SOME`, `relConnection_ALL` … `relConnection_SOME`,
        // `relConnection`, `relAggregate`.
        if (byValue) {
          out[r.name] = {
            type: union
              ? this.unionRelationshipFilters(union)
              : this.relationshipFilters(target as NodeType),
          };
          for (const q of QUANTIFIERS) {
            const spacing = q === "single" || q === "some" ? "  " : " ";
            out[`${r.name}_${q.toUpperCase()}`] = {
              type: targetWhere,
              description: `Return ${sourcePlural} where ${QUANTIFIER_WORD[q]} of the related ${pluralize(target.name)} match this filter`,
              deprecationReason: `Please use the relevant generic filter '${r.name}: {${spacing}${q}: ... }' instead.`,
            };
          }
          for (const q of QUANTIFIERS) {
            out[`${r.name}Connection_${q.toUpperCase()}`] = {
              type: connWhere,
              description: `Return ${sourcePlural} where ${QUANTIFIER_WORD[q]} of the related ${connPlural} match this filter`,
              deprecationReason: `Please use the relevant generic filter '${r.name}Connection: { ${q}: { node: ... } } }' instead.`,
            };
          }
        }
        out[`${r.name}Connection`] = { type: this.relConnectionFilters(r) };
        if (byAggregate) {
          out[`${r.name}Aggregate`] = {
            type: this.relAggregateInput(r),
            deprecationReason: `Aggregate filters are moved inside the ${r.name}Connection filter, please use { ${r.name}Connection: { aggregate: {...} } } instead`,
          };
        }
      }
      return out;
    });
  }

  relationshipFilters(target: NodeType): GraphQLInputObjectType {
    return this.quantifierFilters(target.name, () => this.nodeWhere(target));
  }

  unionRelationshipFilters(u: UnionType): GraphQLInputObjectType {
    return this.quantifierFilters(u.name, () => this.unionWhere(u));
  }

  /** `MovieRelationshipFilters` / `ContentRelationshipFilters`: `all` / `none` / `single` / `some`. */
  private quantifierFilters(
    target: string,
    whereType: () => GraphQLInputObjectType,
  ): GraphQLInputObjectType {
    return this.input(`${target}RelationshipFilters`, () => {
      const where = whereType();
      return Object.fromEntries(
        QUANTIFIERS.map((q) => [
          q,
          {
            type: where,
            description: `Filter type where ${QUANTIFIER_WORD[q]} of the related ${pluralize(target)} match this filter`,
          },
        ]),
      );
    });
  }

  // -------------------------------------------------------------------------
  // Types and fields served by the application's resolvers (passed through as written)
  // -------------------------------------------------------------------------

  /** A named type a field served by resolvers refers to (see `checkUserTypeReferences`). */
  private namedFromAST(name: string): GraphQLNamedType {
    if (SCALARS[name] || this.model.enums.has(name)) return this.namedType(name);
    const union = this.model.unions.get(name);
    if (union) return this.union(union);
    const user = this.model.userTypes.get(name);
    if (user) return this.userType(user);
    return this.node(this.model.node(name));
  }

  private typeFromAST(t: TypeNode): GraphQLType {
    if (t.kind === Kind.NON_NULL_TYPE) return nn(this.typeFromAST(t.type) as GraphQLOutputType);
    if (t.kind === Kind.LIST_TYPE) return list(this.typeFromAST(t.type));
    return this.namedFromAST(t.name.value);
  }

  outputTypeFromAST(t: TypeNode): GraphQLOutputType {
    return this.typeFromAST(t) as GraphQLOutputType;
  }

  inputTypeFromAST(t: TypeNode): GraphQLInputType {
    return this.typeFromAST(t) as GraphQLInputType;
  }

  private inputValue(def: InputValueDefinitionNode): GraphQLInputFieldConfig {
    const type = this.inputTypeFromAST(def.type);
    return {
      type,
      description: def.description?.value,
      defaultValue: def.defaultValue ? valueFromAST(def.defaultValue, type) : undefined,
      deprecationReason: deprecationOf(def),
    };
  }

  /** A field as written in the type definitions, with its arguments (no library directive). */
  fieldFromAST(def: FieldDefinitionNode): GraphQLFieldConfig<unknown, unknown> {
    const args = def.arguments?.length
      ? Object.fromEntries(def.arguments.map((a) => [a.name.value, this.inputValue(a)]))
      : undefined;
    return {
      type: this.outputTypeFromAST(def.type),
      description: def.description?.value,
      deprecationReason: deprecationOf(def),
      args,
    };
  }

  /** An object, input or union type without `@node`, as written. */
  userType(def: UserTypeDefinition): GraphQLNamedType {
    const name = def.name.value;
    const description = def.description?.value;
    switch (def.kind) {
      case Kind.OBJECT_TYPE_DEFINITION:
        return this.object(
          name,
          () =>
            Object.fromEntries((def.fields ?? []).map((f) => [f.name.value, this.fieldFromAST(f)])),
          description,
        );
      case Kind.INPUT_OBJECT_TYPE_DEFINITION:
        return this.input(
          name,
          () =>
            Object.fromEntries((def.fields ?? []).map((f) => [f.name.value, this.inputValue(f)])),
          description,
        );
      default:
        return this.get(
          name,
          () =>
            new GraphQLUnionType({
              name,
              description,
              types: () =>
                (def.types ?? []).map((t) => this.namedFromAST(t.name.value) as GraphQLObjectType),
            }),
        );
    }
  }

  /** `union Content = Book | Movie`; `__resolveType` reads the `__typename` of the decoded value. */
  union(u: UnionType): GraphQLUnionType {
    return this.get(
      u.name,
      () =>
        new GraphQLUnionType({
          name: u.name,
          description: u.description,
          types: () => u.members.map((m) => this.node(this.model.node(m))),
        }),
    );
  }

  /** `ContentWhere`: one optional `${Member}Where` per member. */
  unionWhere(u: UnionType): GraphQLInputObjectType {
    return this.input(`${u.name}Where`, () =>
      Object.fromEntries(u.members.map((m) => [m, { type: this.nodeWhere(this.model.node(m)) }])),
    );
  }

  /** `Movie`, `[Movie!]!`, … for a field returning nodes. */
  nodeRefType(t: TypeRef, target: string): GraphQLOutputType {
    const named = this.node(this.model.node(target));
    if (t.list) {
      const inner = list(t.elementRequired ? nn(named) : named);
      return t.required ? nn(inner) : inner;
    }
    return t.required ? nn(named) : named;
  }

  /** The type of a `Query` / `Mutation` `@cypher` field. */
  rootFieldType(f: CypherRootField): GraphQLOutputType {
    return f.kind === "node" ? this.nodeRefType(f.type, f.type.name) : this.attributeType(f.type);
  }

  floatWhere(): GraphQLInputObjectType {
    return this.input(
      "FloatWhere",
      () => ({ min: { type: GraphQLFloat }, max: { type: GraphQLFloat } }),
      "The input for filtering a float",
    );
  }

  fulltextEdge(n: NodeType): GraphQLObjectType {
    return this.object(`${n.name}IndexEdge`, () => ({
      cursor: { type: nn(GraphQLString) },
      node: { type: nn(this.node(n)) },
      score: { type: nn(GraphQLFloat) },
    }));
  }

  fulltextConnection(n: NodeType): GraphQLObjectType {
    return this.object(`${n.pascalPlural}IndexConnection`, () => ({
      totalCount: { type: nn(GraphQLInt) },
      pageInfo: { type: nn(this.pageInfo()) },
      edges: { type: nn(list(nn(this.fulltextEdge(n)))) },
    }));
  }

  fulltextSort(n: NodeType): GraphQLInputObjectType {
    return this.input(
      `${n.name}IndexSort`,
      () => {
        const sort = this.nodeSort(n);
        return {
          score: { type: this.sortDirection() },
          ...(sort ? { node: { type: sort } } : {}),
        };
      },
      `The input for sorting a Fulltext query on an index of ${n.name}`,
    );
  }

  fulltextWhere(n: NodeType): GraphQLInputObjectType {
    return this.input(
      `${n.name}IndexWhere`,
      () => ({ score: { type: this.floatWhere() }, node: { type: this.nodeWhere(n) } }),
      `The input for filtering a full-text query on an index of ${n.name}`,
    );
  }

  /** `moviesByTitle(phrase, where, sort, first, after)`. */
  fulltextField(n: NodeType): GraphQLFieldConfig<unknown, unknown> {
    return {
      type: nn(this.fulltextConnection(n)),
      args: {
        phrase: { type: nn(GraphQLString) },
        where: { type: this.fulltextWhere(n) },
        sort: { type: list(nn(this.fulltextSort(n))) },
        first: { type: GraphQLInt },
        after: { type: GraphQLString },
      },
    };
  }

  nodeAggregate(n: NodeType): GraphQLObjectType {
    return this.object(`${n.name}Aggregate`, () => {
      const fields: GraphQLFieldConfigMap<unknown, unknown> = { count: { type: nn(this.count()) } };
      if (n.attributes.some(isAggregable)) fields.node = { type: nn(this.nodeAggregateNode(n)) };
      return fields;
    });
  }

  nodeAggregateNode(n: NodeType): GraphQLObjectType {
    return this.object(`${n.name}AggregateNode`, () =>
      aggregateSelectionFields(this, n.attributes),
    );
  }

  nodeEdge(n: NodeType): GraphQLObjectType {
    return this.object(`${n.name}Edge`, () => ({
      cursor: { type: nn(GraphQLString) },
      node: { type: nn(this.node(n)) },
    }));
  }

  /** `MoviesConnection`: `edges` / `totalCount` / `pageInfo` and `aggregate` per `@query`. */
  rootConnection(n: NodeType): GraphQLObjectType {
    return this.object(`${n.pascalPlural}Connection`, () => ({
      ...(n.query.connection
        ? {
            edges: { type: nn(list(nn(this.nodeEdge(n)))) },
            totalCount: { type: nn(GraphQLInt) },
            pageInfo: { type: nn(this.pageInfo()) },
          }
        : {}),
      ...(n.query.aggregate ? { aggregate: { type: nn(this.nodeAggregate(n)) } } : {}),
    }));
  }

  nodeCreate(n: NodeType): GraphQLInputObjectType {
    if (isInterface(n)) {
      // `LearningActivityCreateInput { Lab: LabCreateInput, … }`.
      return this.input(`${n.name}CreateInput`, () =>
        Object.fromEntries(
          n.implementations.map((m) => [m, { type: this.nodeCreate(this.model.node(m)) }]),
        ),
      );
    }
    return this.input(`${n.name}CreateInput`, () => {
      const out = this.attributeCreateFields(n.attributes);
      for (const r of n.relationships) {
        if (!r.config.onCreate) continue;
        out[r.name] = {
          type: isUnionRelationship(this.model, r)
            ? this.unionInput(
                r,
                "CreateInput",
                (m) => (r.list ? this.relFieldInput(m) : this.relSingleFieldInput(m)),
                false,
              )
            : r.list
              ? this.relFieldInput(r)
              : this.relSingleFieldInput(r),
        };
      }
      return nonEmpty(out);
    });
  }

  nodeUpdate(n: NodeType): GraphQLInputObjectType {
    return this.input(`${n.name}UpdateInput`, () => {
      const out = this.attributeUpdateFields(n.attributes);
      // v7: to-one relationships cannot be updated, connected or disconnected.
      for (const r of n.relationships.filter((x) => x.list && x.config.onUpdate)) {
        out[r.name] = {
          type: isUnionRelationship(this.model, r)
            ? this.unionInput(r, "UpdateInput", (m) => this.relUpdateFieldInput(m))
            : list(nn(this.relUpdateFieldInput(r))),
        };
      }
      return nonEmpty(out);
    });
  }

  nodeConnectWhere(n: NodeType): GraphQLInputObjectType {
    return this.input(`${n.name}ConnectWhere`, () => ({ node: { type: nn(this.nodeWhere(n)) } }));
  }

  nodeConnect(n: NodeType): GraphQLInputObjectType | undefined {
    const rels = n.relationships.filter((r) => r.list);
    if (!rels.length) return undefined;
    return this.input(`${n.name}ConnectInput`, () =>
      Object.fromEntries(
        rels.map((r) => [
          r.name,
          {
            type: isUnionRelationship(this.model, r)
              ? this.unionInput(r, "ConnectInput", (m) => this.relConnectFieldInput(m))
              : list(nn(this.relConnectFieldInput(r))),
          },
        ]),
      ),
    );
  }

  nodeDisconnect(n: NodeType): GraphQLInputObjectType | undefined {
    const rels = n.relationships.filter((r) => r.list);
    if (!rels.length) return undefined;
    return this.input(`${n.name}DisconnectInput`, () =>
      Object.fromEntries(
        rels.map((r) => [
          r.name,
          {
            type: isUnionRelationship(this.model, r)
              ? this.unionInput(r, "DisconnectInput", (m) => this.relDisconnectFieldInput(m))
              : list(nn(this.relDisconnectFieldInput(r))),
          },
        ]),
      ),
    );
  }

  nodeDelete(n: NodeType): GraphQLInputObjectType | undefined {
    if (!n.relationships.length) return undefined;
    return this.input(`${n.name}DeleteInput`, () =>
      Object.fromEntries(
        n.relationships.map((r) => [
          r.name,
          {
            type: isUnionRelationship(this.model, r)
              ? this.unionInput(r, "DeleteInput", (m) => this.relDeleteFieldInput(m), r.list)
              : r.list
                ? list(nn(this.relDeleteFieldInput(r)))
                : this.relDeleteFieldInput(r),
          },
        ]),
      ),
    );
  }

  mutationResponse(n: NodeType, kind: "Create" | "Update"): GraphQLObjectType {
    return this.object(`${kind}${n.pascalPlural}MutationResponse`, () => ({
      info: { type: nn(kind === "Create" ? this.createInfo() : this.updateInfo()) },
      [n.plural]: { type: nn(list(nn(this.node(n)))) },
    }));
  }

  // -------------------------------------------------------------------------
  // Relationships (`${Source}${Field}…` types)
  // -------------------------------------------------------------------------

  private props(r: Relationship): PropertiesType | undefined {
    return r.properties ? this.model.properties.get(r.properties) : undefined;
  }

  /**
   * `UserFavoritesCreateInput { Book: UserFavoritesBookFieldInput, … }` and the other member-keyed
   * inputs of a relationship to a union (lists of the member input unless `asList` is false).
   */
  unionInput(
    r: Relationship,
    suffix: string,
    member: (m: Relationship) => GraphQLInputObjectType,
    asList = true,
  ): GraphQLInputObjectType {
    return this.input(`${prefix(r)}${suffix}`, () =>
      Object.fromEntries(
        unionMembers(this.model, r).map((m) => [
          m.target,
          { type: asList ? list(nn(member(m))) : member(m) },
        ]),
      ),
    );
  }

  /**
   * The relationship naming the connection, edge, `where` / `sort` and nested delete / disconnect
   * types: the interface's for a relationship an interface declares (v7 shares them).
   */
  private named(r: Relationship): Relationship {
    return declaredRelationship(this.model, r) ?? r;
  }

  /** `MovieActorsConnection` (`LearningActivityTracksConnection` for declared relationships). */
  connName(r: Relationship): string {
    return relConnectionName(this.named(r));
  }

  private fromInterface(r: Relationship): boolean {
    return this.model.interfaces.has(r.source);
  }

  /**
   * The properties types of a relationship an interface declares, with the implementations using
   * each (definition order), for the `edge` inputs keyed by properties type.
   */
  private propertiesByType(r: Relationship): { props: PropertiesType; users: string[] }[] {
    const out: { props: PropertiesType; users: string[] }[] = [];
    for (const { node, rel } of implementationRelationships(this.model, r)) {
      const p = this.props(rel);
      if (!p) continue;
      const entry = out.find((e) => e.props === p);
      if (entry) entry.users.push(node.name);
      else out.push({ props: p, users: [node.name] });
    }
    return out;
  }

  /**
   * `LearningActivityTracksEdgeWhere { ContainsProperties: ContainsPropertiesWhere }` and the other
   * edge inputs of a relationship an interface declares, or `undefined` when no key applies.
   */
  private keyedEdge(
    r: Relationship,
    suffix: string,
    member: (p: PropertiesType) => GraphQLInputType | undefined,
  ): GraphQLInputObjectType | undefined {
    const entries = this.propertiesByType(r).flatMap(({ props, users }) => {
      const type = member(props);
      return type ? [{ props, users, type }] : [];
    });
    if (!entries.length) return undefined;
    return this.input(`${prefix(r)}Edge${suffix}`, () =>
      Object.fromEntries(
        entries.map(({ props, users, type }) => [
          props.name,
          {
            type,
            description: `Relationship properties when source node is of type:\n${users.map((u) => `* ${u}`).join("\n")}`,
          },
        ]),
      ),
    );
  }

  /** The `edge` create input of a relationship (keyed by properties type through an interface). */
  private edgeCreateRef(r: Relationship): GraphQLInputType | undefined {
    if (this.fromInterface(r)) {
      const keyed = this.keyedEdge(r, "CreateInput", (p) => this.propertiesCreateRef(p));
      if (!keyed) return undefined;
      const required = Object.values(keyed.getFields()).some(
        (f) => f.type instanceof GraphQLNonNull,
      );
      return required ? nn(keyed) : keyed;
    }
    const p = this.props(r);
    return p ? this.propertiesCreateRef(p) : undefined;
  }

  private edgeUpdate(r: Relationship): GraphQLInputType | undefined {
    if (this.fromInterface(r))
      return this.keyedEdge(r, "UpdateInput", (p) => this.propertiesUpdate(p));
    const p = this.props(r);
    return p ? this.propertiesUpdate(p) : undefined;
  }

  relConnection(r: Relationship): GraphQLObjectType {
    const named = this.named(r);
    if (named !== r) return this.relConnection(named);
    const union = isUnionRelationship(this.model, r);
    return this.object(relConnectionName(r), () => ({
      // v7: `@selectable(onRead: false)` leaves only the aggregate.
      ...(r.config.onRead
        ? {
            edges: { type: nn(list(nn(this.relRelationship(r)))) },
            totalCount: { type: nn(GraphQLInt) },
            pageInfo: { type: nn(this.pageInfo()) },
          }
        : {}),
      // v7: no aggregate on relationships to unions, on to-one relationships or on relationships
      // an interface declares.
      ...(union || !r.list || this.fromInterface(r)
        ? {}
        : { aggregate: { type: nn(this.relAggregateSelection(r)) } }),
    }));
  }

  relRelationship(r: Relationship): GraphQLObjectType {
    if (this.fromInterface(r)) {
      // `properties: LearningActivityTracksRelationshipProperties!` (a union of the types).
      return this.object(`${prefix(r)}Relationship`, () => {
        const fields: GraphQLFieldConfigMap<unknown, unknown> = {
          cursor: { type: nn(GraphQLString) },
          node: { type: nn(this.node(this.model.node(r.target))) },
        };
        const types = this.propertiesByType(r).map(({ props }) => props);
        if (types.length) {
          const name = `${prefix(r)}RelationshipProperties`;
          fields.properties = {
            type: nn(
              this.get(
                name,
                () =>
                  new GraphQLUnionType({
                    name,
                    types: () => types.map((p) => this.propertiesObject(p)),
                  }),
              ),
            ),
          };
        }
        return fields;
      });
    }
    return this.object(`${prefix(r)}Relationship`, () => {
      const fields: GraphQLFieldConfigMap<unknown, unknown> = {
        cursor: { type: nn(GraphQLString) },
        node: {
          type: nn(
            isUnionRelationship(this.model, r)
              ? this.union(this.model.unions.get(r.target)!)
              : this.node(this.model.node(r.target)),
          ),
        },
      };
      const p = this.props(r);
      if (p) fields.properties = { type: nn(this.propertiesObject(p)) };
      return fields;
    });
  }

  relAggregateSelection(r: Relationship): GraphQLObjectType {
    const base = `${r.source}${r.target}${upperFirst(r.name)}`;
    return this.object(`${base}AggregateSelection`, () => {
      const fields: GraphQLFieldConfigMap<unknown, unknown> = {
        count: { type: nn(this.countConnection()) },
      };
      const target = this.model.node(r.target);
      if (target.attributes.some(isAggregable)) {
        fields.node = {
          type: this.object(`${base}NodeAggregateSelection`, () =>
            aggregateSelectionFields(this, target.attributes),
          ),
        };
      }
      const p = this.props(r);
      if (p && p.attributes.some(isAggregable)) {
        fields.edge = {
          type: this.object(`${base}EdgeAggregateSelection`, () =>
            aggregateSelectionFields(this, p.attributes),
          ),
        };
      }
      return fields;
    });
  }

  /** `MovieActorsConnectionSort { edge, node }`, or nothing when there is nothing to sort on. */
  relConnectionSort(r: Relationship): GraphQLInputObjectType | undefined {
    const named = this.named(r);
    if (named !== r) return this.relConnectionSort(named);
    const p = this.props(r);
    const edge = this.fromInterface(r)
      ? this.keyedEdge(r, "Sort", (x) => this.propertiesSort(x))
      : p
        ? this.propertiesSort(p)
        : undefined;
    // v7: relationships to unions sort on edge properties only.
    const node = isUnionRelationship(this.model, r)
      ? undefined
      : this.nodeSort(this.model.node(r.target));
    if (!edge && !node) return undefined;
    return this.input(`${relConnectionName(r)}Sort`, () => ({
      ...(node ? { node: { type: node } } : {}),
      ...(edge ? { edge: { type: edge } } : {}),
    }));
  }

  relConnectionWhere(r: Relationship): GraphQLInputObjectType {
    const named = this.named(r);
    if (named !== r) return this.relConnectionWhere(named);
    return this.input(`${relConnectionName(r)}Where`, () => {
      if (isUnionRelationship(this.model, r)) {
        // `UserFavoritesConnectionWhere { Book: UserFavoritesBookConnectionWhere, … }`.
        return Object.fromEntries(
          unionMembers(this.model, r).map((m) => [m.target, { type: this.relConnectionWhere(m) }]),
        );
      }
      const self = this.relConnectionWhere(r);
      const out: GraphQLInputFieldConfigMap = {
        AND: { type: list(nn(self)) },
        OR: { type: list(nn(self)) },
        NOT: { type: self },
        node: { type: this.nodeWhere(this.model.node(r.target)) },
      };
      const p = this.props(r);
      const edge = this.fromInterface(r)
        ? this.keyedEdge(r, "Where", (x) => this.propertiesWhere(x))
        : p
          ? this.propertiesWhere(p)
          : undefined;
      if (edge) out.edge = { type: edge };
      return out;
    });
  }

  relConnectionFilters(r: Relationship): GraphQLInputObjectType {
    return this.input(`${prefix(r)}ConnectionFilters`, () => {
      const where = this.relConnectionWhere(r);
      const sourcePlural = pluralize(r.source);
      const connPlural = pluralize(this.connName(r));
      const out: GraphQLInputFieldConfigMap = {};
      for (const q of r.config.byValue ? QUANTIFIERS : []) {
        out[q] = {
          type: where,
          description: `Return ${sourcePlural} where ${QUANTIFIER_WORD[q]} of the related ${connPlural} match this filter`,
        };
      }
      if (!isUnionRelationship(this.model, r) && r.config.byAggregate) {
        out.aggregate = {
          type: this.relConnectionAggregateInput(r),
          description: `Filter ${sourcePlural} by aggregating results on related ${connPlural}`,
        };
      }
      return out;
    });
  }

  relNodeAggregationWhere(r: Relationship): GraphQLInputObjectType {
    const self = (): GraphQLInputObjectType => this.relNodeAggregationWhere(r);
    return this.input(`${prefix(r)}NodeAggregationWhereInput`, () =>
      this.aggregationWhereFields(self, this.model.node(r.target).attributes),
    );
  }

  private aggregateInputEdgeNode(r: Relationship): GraphQLInputFieldConfigMap {
    const out: GraphQLInputFieldConfigMap = {};
    if (this.model.node(r.target).attributes.some(isAggregationFilterable)) {
      out.node = { type: this.relNodeAggregationWhere(r) };
    }
    const p = this.props(r);
    if (this.fromInterface(r)) {
      const edge = this.keyedEdge(r, "AggregationWhereInput", (x) =>
        x.attributes.some(isAggregationFilterable) ? this.propertiesAggregationWhere(x) : undefined,
      );
      if (edge) out.edge = { type: edge };
    } else if (p && p.attributes.some(isAggregationFilterable))
      out.edge = { type: this.propertiesAggregationWhere(p) };
    return out;
  }

  relAggregateInput(r: Relationship): GraphQLInputObjectType {
    return this.input(`${prefix(r)}AggregateInput`, () => {
      const self = this.relAggregateInput(r);
      const out: GraphQLInputFieldConfigMap = {};
      for (const op of ["eq", "lt", "lte", "gt", "gte"]) {
        out[`count_${op.toUpperCase()}`] = {
          type: GraphQLInt,
          deprecationReason: `Please use the relevant generic filter '{ count: { ${op}: ... } } }' instead.`,
        };
      }
      return {
        ...out,
        count: { type: this.intFilters() },
        AND: { type: list(nn(self)) },
        OR: { type: list(nn(self)) },
        NOT: { type: self },
        ...this.aggregateInputEdgeNode(r),
      };
    });
  }

  relConnectionAggregateInput(r: Relationship): GraphQLInputObjectType {
    return this.input(`${prefix(r)}ConnectionAggregateInput`, () => {
      const self = this.relConnectionAggregateInput(r);
      return {
        count: { type: this.connectionAggregationCountFilter() },
        AND: { type: list(nn(self)) },
        OR: { type: list(nn(self)) },
        NOT: { type: self },
        ...this.aggregateInputEdgeNode(r),
      };
    });
  }

  relFieldInput(r: Relationship): GraphQLInputObjectType {
    return this.input(`${prefix(r)}FieldInput`, () => ({
      connect: { type: list(nn(this.relConnectFieldInput(r))) },
      create: { type: list(nn(this.relCreateFieldInput(r))) },
    }));
  }

  /** `SessionLabFieldInput { create: SessionLabCreateFieldInput }`: v7 has no `connect` on to-one. */
  relSingleFieldInput(r: Relationship): GraphQLInputObjectType {
    return this.input(`${prefix(r)}FieldInput`, () => ({
      create: { type: this.relCreateFieldInput(r) },
    }));
  }

  relConnectFieldInput(r: Relationship): GraphQLInputObjectType {
    return this.input(`${prefix(r)}ConnectFieldInput`, () => {
      const target = this.model.node(r.target);
      const out: GraphQLInputFieldConfigMap = {};
      const edge = this.edgeCreateRef(r);
      if (edge) out.edge = { type: edge };
      out.where = { type: this.nodeConnectWhere(target) };
      const connect = this.nodeConnect(target);
      // v7: `connect: LearningActivityConnectInput` (not a list) for an interface.
      if (connect) out.connect = { type: isInterface(target) ? connect : list(nn(connect)) };
      return out;
    });
  }

  relCreateFieldInput(r: Relationship): GraphQLInputObjectType {
    return this.input(`${prefix(r)}CreateFieldInput`, () => {
      const out: GraphQLInputFieldConfigMap = {};
      const edge = this.edgeCreateRef(r);
      if (edge) out.edge = { type: edge };
      out.node = { type: nn(this.nodeCreate(this.model.node(r.target))) };
      return out;
    });
  }

  relDeleteFieldInput(r: Relationship): GraphQLInputObjectType {
    // v7 names them after the interface, except for relationships to an interface.
    const named = this.model.interfaces.has(r.target) ? r : this.named(r);
    if (named !== r) return this.relDeleteFieldInput(named);
    return this.input(`${prefix(r)}DeleteFieldInput`, () => {
      const out: GraphQLInputFieldConfigMap = { where: { type: this.relConnectionWhere(r) } };
      const del = this.nodeDelete(this.model.node(r.target));
      if (del) out.delete = { type: del };
      return out;
    });
  }

  relDisconnectFieldInput(r: Relationship): GraphQLInputObjectType {
    // v7 names them after the interface, except for relationships to an interface.
    const named = this.model.interfaces.has(r.target) ? r : this.named(r);
    if (named !== r) return this.relDisconnectFieldInput(named);
    return this.input(`${prefix(r)}DisconnectFieldInput`, () => {
      const out: GraphQLInputFieldConfigMap = { where: { type: this.relConnectionWhere(r) } };
      const dis = this.nodeDisconnect(this.model.node(r.target));
      if (dis) out.disconnect = { type: dis };
      return out;
    });
  }

  relUpdateConnectionInput(r: Relationship): GraphQLInputObjectType {
    return this.input(`${prefix(r)}UpdateConnectionInput`, () => {
      const out: GraphQLInputFieldConfigMap = {
        node: { type: this.nodeUpdate(this.model.node(r.target)) },
        where: { type: this.relConnectionWhere(r) },
      };
      const edge = this.edgeUpdate(r);
      if (edge) out.edge = { type: edge };
      return out;
    });
  }

  relUpdateFieldInput(r: Relationship): GraphQLInputObjectType {
    return this.input(`${prefix(r)}UpdateFieldInput`, () => ({
      connect: { type: list(nn(this.relConnectFieldInput(r))) },
      disconnect: { type: list(nn(this.relDisconnectFieldInput(r))) },
      create: { type: list(nn(this.relCreateFieldInput(r))) },
      update: { type: this.relUpdateConnectionInput(r) },
      delete: { type: list(nn(this.relDeleteFieldInput(r))) },
    }));
  }
}

function deprecationOf(def: FieldDefinitionNode | InputValueDefinitionNode): string | undefined {
  return getDirectiveValues(GraphQLDeprecatedDirective, def)?.reason as string | undefined;
}

function sortArg(t: GraphQLInputObjectType | undefined): GraphQLFieldConfigArgumentMap {
  return t ? { sort: { type: list(nn(t)) } } : {};
}

/**
 * `items` (fields of `n`) in the order of the type definition: v7 generates fields in that order,
 * attributes, `@cypher` fields and fields served by resolvers interleaved.
 */
function inDefinitionOrder<T extends { readonly name: string }>(
  n: NodeType,
  items: readonly T[],
): T[] {
  const pos = new Map(n.fieldOrder.map((f, i) => [f, i]));
  const at = (x: T) => pos.get(x.name) ?? n.fieldOrder.length;
  return [...items].sort((a, b) => at(a) - at(b));
}

function scalarRef(name: string): TypeRef {
  return { name, list: false, required: false, elementRequired: false };
}

/**
 * `MovieActors`: prefix of every type generated for the `Movie.actors` relationship;
 * `UserFavoritesMovie` for the `Movie` view of `User.favorites` (to a union).
 */
export function prefix(r: Relationship): string {
  return `${r.source}${upperFirst(r.name)}${r.union !== undefined ? r.target : ""}`;
}

/** `MovieActorsConnection`. */
export function relConnectionName(r: Relationship): string {
  return `${prefix(r)}Connection`;
}

function relationshipType(reg: TypeRegistry, r: Relationship): GraphQLOutputType {
  const target = isUnionRelationship(reg.model, r)
    ? reg.union(reg.model.unions.get(r.target)!)
    : reg.node(reg.model.node(r.target));
  if (r.list) {
    const inner = list(r.elementRequired ? nn(target) : target);
    return r.required ? nn(inner) : inner;
  }
  return r.required ? nn(target) : target;
}

/** Arguments of a `@cypher` field, with their defaults. */
function argumentConfigs(
  reg: TypeRegistry,
  args: readonly FieldArgument[],
): GraphQLFieldConfigArgumentMap | undefined {
  if (!args.length) return undefined;
  const out: GraphQLFieldConfigArgumentMap = {};
  for (const a of args) {
    const type = reg.attributeType(a.type);
    out[a.name] = {
      type,
      description: a.description,
      defaultValue: a.defaultAst ? valueFromAST(a.defaultAst, type) : undefined,
    };
  }
  return out;
}

function attributeOutputFields(
  reg: TypeRegistry,
  attributes: readonly Attribute[],
): GraphQLFieldConfigMap<unknown, unknown> {
  const out: GraphQLFieldConfigMap<unknown, unknown> = {};
  for (const a of attributes) {
    if (!a.config.onRead) continue;
    const field: GraphQLFieldConfig<unknown, unknown> = {
      type: reg.attributeType(a.type),
      description: a.description,
      deprecationReason: a.deprecated,
      args: argumentConfigs(reg, a.args),
    };
    out[a.name] = field;
  }
  return out;
}

function rootField(reg: TypeRegistry, f: CypherRootField): GraphQLFieldConfig<unknown, unknown> {
  return {
    type: reg.rootFieldType(f),
    description: f.description,
    deprecationReason: f.deprecated,
    args: argumentConfigs(reg, f.args),
  };
}

function aggregateSelectionFields(
  reg: TypeRegistry,
  attributes: readonly Attribute[],
): GraphQLFieldConfigMap<unknown, unknown> {
  return Object.fromEntries(
    attributes
      .filter(isAggregable)
      .map((a) => [a.name, { type: nn(reg.aggregateSelection(a.type.name)) }]),
  );
}

/** Builds the v7 schema (without resolvers) for a model. */
export function buildV7Schema(model: V7Model): GraphQLSchema {
  const reg = new TypeRegistry(model);
  // v7 order: fields served by resolvers, then per entity (unions, interfaces, `@node` types, each
  // in definition order) its queries, then the `@cypher` fields.
  const query = new GraphQLObjectType({
    name: "Query",
    fields: () => {
      const fields: GraphQLFieldConfigMap<unknown, unknown> = {};
      for (const f of model.query.resolved) fields[f.name] = reg.fieldFromAST(f.definition);
      // v7: `contents(where, limit, offset): [Content!]!` (no sort, no connection).
      for (const u of model.unions.values()) {
        if (!u.read) continue;
        fields[u.plural] = {
          type: nn(list(nn(reg.union(u)))),
          args: {
            where: { type: reg.unionWhere(u) },
            limit: { type: GraphQLInt },
            offset: { type: GraphQLInt },
          },
        };
      }
      const entityQueries = (n: NodeType, type: GraphQLOutputType) => {
        if (n.query.connection || n.query.aggregate)
          fields[`${n.plural}Connection`] = {
            type: nn(reg.rootConnection(n)),
            args: {
              first: { type: GraphQLInt },
              after: { type: GraphQLString },
              where: { type: reg.nodeWhere(n) },
              ...sortArg(reg.nodeSort(n)),
            },
          };
        // `@query(read, connection, aggregate)`.
        if (n.query.read) {
          fields[n.plural] = {
            type: nn(list(nn(type))),
            args: {
              where: { type: reg.nodeWhere(n) },
              limit: { type: GraphQLInt },
              offset: { type: GraphQLInt },
              ...sortArg(reg.nodeSort(n)),
            },
          };
        }
      };
      for (const i of model.interfaces.values()) entityQueries(i, reg.interfaceType(i));
      for (const n of model.nodes) {
        for (const ft of n.fulltext) fields[ft.queryName] = reg.fulltextField(n);
        entityQueries(n, reg.node(n));
      }
      for (const f of model.query.fields) fields[f.name] = rootField(reg, f);
      return fields;
    },
  });
  const mutation = new GraphQLObjectType({
    name: "Mutation",
    fields: () => {
      const fields: GraphQLFieldConfigMap<unknown, unknown> = {};
      for (const f of model.mutation.resolved) fields[f.name] = reg.fieldFromAST(f.definition);
      for (const n of model.nodes) {
        // `@mutation(operations)`: only the listed root mutations exist.
        if (n.mutation.create) {
          fields[`create${n.pascalPlural}`] = {
            type: nn(reg.mutationResponse(n, "Create")),
            args: { input: { type: nn(list(nn(reg.nodeCreate(n)))) } },
          };
        }
        if (n.mutation.delete) {
          const del = reg.nodeDelete(n);
          fields[`delete${n.pascalPlural}`] = {
            type: nn(reg.deleteInfo()),
            args: {
              where: { type: reg.nodeWhere(n) },
              ...(del ? { delete: { type: del } } : {}),
            },
          };
        }
        if (n.mutation.update) {
          fields[`update${n.pascalPlural}`] = {
            type: nn(reg.mutationResponse(n, "Update")),
            args: {
              where: { type: reg.nodeWhere(n) },
              update: { type: reg.nodeUpdate(n) },
            },
          };
        }
      }
      for (const f of model.mutation.fields) fields[f.name] = rootField(reg, f);
      return fields;
    },
  });
  const subscriptionFields: GraphQLFieldConfigMap<unknown, unknown> = {};
  for (const n of model.nodes) {
    const events = subscriptionEvents(model, n);
    for (const event of SUBSCRIPTION_EVENTS) {
      if (!events.has(event)) continue;
      subscriptionFields[subscriptionNames(n.name)[event].field] = {
        type: nn(reg.subscriptionEvent(n, event)),
        args: { where: { type: reg.subscriptionWhere(n) } },
      };
    }
  }
  const subscription = Object.keys(subscriptionFields).length
    ? new GraphQLObjectType({ name: "Subscription", fields: subscriptionFields })
    : undefined;
  // v7: no `Mutation` type when `@mutation` leaves no root mutation.
  const hasMutation =
    model.mutation.fields.length > 0 ||
    model.mutation.resolved.length > 0 ||
    model.nodes.some((n) => n.mutation.create || n.mutation.update || n.mutation.delete);
  // The implementations of an interface are in the schema with it (possible types).
  const types = [...model.interfaces.values()].flatMap((i) =>
    i.implementations.map((m) => reg.node(model.node(m))),
  );
  return inV7TypeOrder(
    new GraphQLSchema({
      query,
      mutation: hasMutation ? mutation : undefined,
      subscription,
      types,
    }),
  );
}

/**
 * v7 prints its schema with graphql-compose's `GROUP_BY_TYPE` order: `Query`, `Mutation`,
 * `Subscription`, then scalars, enums, unions, interfaces, object types and input types, each
 * group sorted by name (`localeCompare`). `printSchema` follows the type map, so the schema is
 * rebuilt with its types in that order.
 */
function inV7TypeOrder(schema: GraphQLSchema): GraphQLSchema {
  const roots = ["Query", "Mutation", "Subscription"];
  const group = (t: GraphQLNamedType): number => {
    if (isScalarType(t)) return 2;
    if (isEnumType(t)) return 3;
    if (isUnionType(t)) return 4;
    if (isInterfaceType(t)) return 5;
    if (isObjectType(t)) return roots.includes(t.name) ? 1 : 6;
    return 7;
  };
  const types = Object.values(schema.getTypeMap())
    .filter((t) => !t.name.startsWith("__"))
    .sort(
      (a, b) =>
        group(a) - group(b) ||
        (group(a) === 1 ? roots.indexOf(a.name) - roots.indexOf(b.name) : 0) ||
        a.name.localeCompare(b.name),
    );
  return new GraphQLSchema({ ...schema.toConfig(), types });
}
