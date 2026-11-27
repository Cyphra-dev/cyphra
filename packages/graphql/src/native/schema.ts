/**
 * Builds the native API's `GraphQLSchema` from the {@link ApiModel}: object, interface and union
 * types per model, `<Model>Where` / `<Model>WhereUnique` / `<Model>OrderBy` inputs, shared
 * filters per scalar type, `<Model>List` results and the `Query` root fields.
 *
 * @packageDocumentation
 */

import {
  Kind,
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  getNullableType,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLUnionType,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigArgumentMap,
  type GraphQLFieldConfigMap,
  type GraphQLFieldResolver,
  type GraphQLInputFieldConfigMap,
  type GraphQLInputType,
  type GraphQLNamedType,
  type GraphQLOutputType,
  type GraphQLScalarType,
  type TypeNode,
} from "graphql";
import type { ResolvedNodeModel, ResolvedRelationField, ResolvedScalarField } from "@cyphra/schema";
import type { ApiModel } from "./api.js";
import { NativeSchemaError, isWrite, type RootOperation } from "./config.js";
import type { SubscriptionResolvers } from "./subscriptions.js";
import type { TypeRef } from "./extensions.js";
import { NUMERIC_TYPES, ORDERABLE_TYPES } from "./api.js";
import {
  BigIntScalar,
  CartesianPointInputType,
  CartesianPointType,
  DateScalar,
  DateTimeScalar,
  DurationScalar,
  JsonScalar,
  LocalDateTimeScalar,
  LocalTimeScalar,
  PointInputType,
  PointType,
  TimeScalar,
} from "./scalars.js";

/** Key under which a shaped result object carries its GraphQL type name (for `resolveType`). */
export const TYPE = Symbol("cyphra.native.type");

/** Key under which a shaped node carries the client's row it was shaped from (for `extend`). */
export const ROW = Symbol("cyphra.native.row");

type AnyRecord = Record<string | symbol, unknown>;

/** Resolver of a field of a shaped object: the value under the field's response key. */
const byResponseKey: GraphQLFieldResolver<AnyRecord, unknown> = (src, _args, _ctx, info) =>
  // A shaped object has its values under response keys; anything else (an object a custom
  // resolver returned as is) under field names.
  TYPE in src || info.path.key in src ? src[info.path.key] : src[info.fieldName];

const resolveType = (value: unknown): string | undefined => {
  const v = value as AnyRecord | null;
  return (v?.[TYPE] ?? v?.__typename) as string | undefined;
};

/** Names of the generated types of a model. */
export const names = {
  where: (m: string) => `${m}Where`,
  whereUnique: (m: string) => `${m}WhereUnique`,
  orderBy: (m: string) => `${m}OrderBy`,
  scalarOrderBy: (m: string) => `${m}ScalarOrderBy`,
  relationCountOrder: (m: string) => `${m}RelationCountOrder`,
  list: (m: string) => `${m}List`,
  count: (m: string) => `${m}Count`,
  listRelationFilter: (m: string) => `${m}ListRelationFilter`,
  relationFilter: (m: string) => `${m}RelationFilter`,
  typename: (m: string) => `${m}Typename`,
  typenameFilter: (m: string) => `${m}TypenameFilter`,
  onWhere: (m: string) => `${m}OnWhere`,
  edgeUnion: (m: string) => `${m}Edge`,
  batch: (m: string) => `${m}Batch`,
  createMany: (m: string) => `${m}CreateManyInput`,
  update: (m: string) => `${m}UpdateInput`,
  updateMany: (m: string) => `${m}UpdateManyInput`,
  ops: (m: string) => `${m}Ops`,
  edgeInput: (e: string) => `${e}Input`,
  connect: (m: string, edge: string) => `${m}Connect${edge}`,
  countWhere: (m: string) => `${m}CountWhere`,
  countFilter: (m: string) => `${m}CountFilter`,
  aggregate: (m: string) => `${m}Aggregate`,
  countAggregate: (m: string) => `${m}CountAggregate`,
  sumAggregate: (m: string) => `${m}SumAggregate`,
  avgAggregate: (m: string) => `${m}AvgAggregate`,
  minAggregate: (m: string) => `${m}MinAggregate`,
  maxAggregate: (m: string) => `${m}MaxAggregate`,
  group: (m: string) => `${m}Group`,
  groupKeys: (m: string) => `${m}GroupKeys`,
  groupField: (m: string) => `${m}GroupField`,
  groupByInput: (m: string) => `${m}GroupByInput`,
  having: (m: string) => `${m}Having`,
  groupKeyFilter: (m: string) => `${m}GroupKeyFilter`,
  groupOrderBy: (m: string) => `${m}GroupOrderBy`,
  groupKeyOrderBy: (m: string) => `${m}GroupKeyOrderBy`,
  countOrderBy: (m: string) => `${m}CountAggregateOrderBy`,
  numericOrderBy: (m: string) => `${m}NumericAggregateOrderBy`,
  minMaxOrderBy: (m: string) => `${m}MinMaxAggregateOrderBy`,
  fulltextIndex: (m: string) => `${m}FulltextIndex`,
  vectorField: (m: string) => `${m}VectorField`,
  searchIndexes: (m: string) => `${m}SearchIndexes`,
  similarFields: (m: string) => `${m}SimilarFields`,
  traverseRelation: (m: string) => `${m}TraverseRelation`,
  path: (m: string) => `${m}Path`,
  pathEdge: (m: string) => `${m}PathEdge`,
  pathEdgeProperties: (m: string) => `${m}PathEdgeProperties`,
  traversal: (m: string) => `${m}Traversal`,
  change: (m: string) => `${m}Change`,
  relationEvent: (m: string, field: string) =>
    `${m}${field.charAt(0).toUpperCase()}${field.slice(1)}Event`,
};

/** A scalar field of `type`, for the shared inputs of aggregate results (`IntFilter`, …). */
function syntheticField(type: ResolvedScalarField["type"]): ResolvedScalarField {
  return {
    kind: "scalar",
    name: "",
    type,
    optional: true,
    list: false,
    id: false,
    unique: false,
    index: false,
  };
}

/** A scalar field standing for the value of a computed or Cypher-backed field (`ref`). */
function refField(ref: TypeRef): ResolvedScalarField {
  return {
    ...syntheticField(ref.scalar!),
    list: ref.list,
    ...(ref.scalar === "Enum" ? { enum: ref.name, enumValues: ref.enumValues } : {}),
  };
}

/**
 * How a relation is written from its owner: the part of the generated names that depends on the
 * relation side. A nested create omits the target's back relation (`Without<Inverse>`); without
 * one, a typed edge still changes the items (`Via<Edge>`, they take `_edge`).
 */
export type RelationSide = {
  readonly field: ResolvedRelationField;
  readonly target: ResolvedNodeModel;
  /** The back relation a nested create omits. */
  readonly inverse?: string;
  /** The edge model of the relation (with properties). */
  readonly edge?: string;
  /** `Without<Inverse>`, `Via<Edge>` or `""`. */
  readonly suffix: string;
};

/** The resolver of one root field of a model. */
export type RootResolver = (
  model: ResolvedNodeModel,
  operation: RootOperation,
) => GraphQLFieldResolver<unknown, unknown>;

const NUMERIC = new Set(["Int", "Float", "BigInt"]);

const RANGE_OPS = ["lt", "lte", "gt", "gte"] as const;

function pascal(key: string): string {
  return key
    .split(/[_\W]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

/** Builds the schema; one instance per `makeSchema`. */
export class SchemaBuilder {
  private readonly types = new Map<string, GraphQLNamedType>();
  private readonly modelNames: Set<string>;

  readonly SortOrder = new GraphQLEnumType({
    name: "SortOrder",
    values: { asc: { value: "asc" }, desc: { value: "desc" } },
  });

  readonly QueryMode = new GraphQLEnumType({
    name: "QueryMode",
    description: "`insensitive` compares lower-cased values.",
    values: { default: { value: "default" }, insensitive: { value: "insensitive" } },
  });

  readonly PageInfo = new GraphQLObjectType({
    name: "PageInfo",
    fields: {
      hasNextPage: { type: new GraphQLNonNull(GraphQLBoolean) },
      hasPreviousPage: { type: new GraphQLNonNull(GraphQLBoolean) },
      startCursor: { type: GraphQLString },
      endCursor: { type: GraphQLString },
    },
  });

  /** Relay's `Node` (`relay: true`). */
  readonly Node = new GraphQLInterfaceType({
    name: "Node",
    description: "An object with a global id (Relay): refetch it with node(id).",
    fields: { id: { type: new GraphQLNonNull(GraphQLID), description: "The global id." } },
    resolveType,
  });

  /** `operation` of a `<Model>Change` (subscriptions). */
  readonly ChangeOperation = new GraphQLEnumType({
    name: "ChangeOperation",
    description: "What happened to a node (subscriptions, experimental).",
    values: {
      CREATED: { value: "CREATED" },
      UPDATED: { value: "UPDATED" },
      DELETED: { value: "DELETED" },
    },
  });

  constructor(
    private readonly api: ApiModel,
    private readonly resolver?: RootResolver,
    private readonly nodeResolver?: GraphQLFieldResolver<unknown, unknown>,
    private readonly subscriptions?: SubscriptionResolvers,
  ) {
    this.modelNames = new Set([
      ...api.schema.nodes.map((n) => n.name),
      ...(api.schema.enums ?? []).map((e) => e.name),
      ...api.edges.keys(),
    ]);
  }

  /** A generated type, created once; its name must not be a model's, an enum's or an edge's. */
  named<T extends GraphQLNamedType>(name: string, create: () => T, own = false): T {
    const existing = this.types.get(name);
    if (existing) return existing as T;
    if (!own && this.modelNames.has(name)) {
      throw new NativeSchemaError(
        `The generated type "${name}" has the name of a model, an enum or a relationship of schema.cyphra; rename it there.`,
      );
    }
    const t = create();
    this.types.set(name, t);
    return t;
  }

  // ---------------------------------------------------------------------------
  // Scalars
  // ---------------------------------------------------------------------------

  private enumType(name: string): GraphQLEnumType {
    return this.named(
      name,
      () => {
        const e = (this.api.schema.enums ?? []).find((x) => x.name === name);
        if (!e) throw new NativeSchemaError(`Unknown enum "${name}".`);
        return new GraphQLEnumType({
          name,
          values: Object.fromEntries(e.values.map((v) => [v, { value: v }])),
        });
      },
      true,
    );
  }

  /** The GraphQL type of one value of a scalar field, for output or input. */
  private scalarBase(
    f: ResolvedScalarField,
    input: boolean,
  ): GraphQLScalarType | GraphQLEnumType | GraphQLObjectType | GraphQLInputObjectType {
    switch (f.type) {
      case "String":
        return f.id ? GraphQLID : GraphQLString;
      case "Int":
        return GraphQLInt;
      case "Float":
      case "Vector":
        return GraphQLFloat;
      case "Boolean":
        return GraphQLBoolean;
      case "DateTime":
        return DateTimeScalar;
      case "Date":
        return DateScalar;
      case "LocalDateTime":
        return LocalDateTimeScalar;
      case "LocalTime":
        return LocalTimeScalar;
      case "Time":
        return TimeScalar;
      case "Duration":
        return DurationScalar;
      case "BigInt":
        return BigIntScalar;
      case "Json":
        return JsonScalar;
      case "Point":
        return input ? PointInputType : PointType;
      case "CartesianPoint":
        return input ? CartesianPointInputType : CartesianPointType;
      case "Enum":
        return this.enumType(f.enum!);
    }
  }

  private scalarOutput(f: ResolvedScalarField): GraphQLOutputType {
    const base = this.scalarBase(f, false) as GraphQLOutputType;
    if (f.type === "Vector") {
      const list = new GraphQLList(new GraphQLNonNull(base));
      return f.optional ? list : new GraphQLNonNull(list);
    }
    if (f.list) return new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(base)));
    return f.optional ? base : new GraphQLNonNull(base);
  }

  // ---------------------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------------------

  /** The shared filter input of a scalar field (`StringFilter`, `IntListFilter`, …). */
  private scalarFilter(f: ResolvedScalarField): GraphQLInputType {
    const base = this.scalarBase(f, true) as GraphQLInputType & { name: string };
    const t = base.name;
    const list = (x: GraphQLInputType) => new GraphQLList(new GraphQLNonNull(x));
    if (f.list) {
      return this.named(`${t}ListFilter`, () => {
        return new GraphQLInputObjectType({
          name: `${t}ListFilter`,
          fields: {
            has: { type: base },
            hasEvery: { type: list(base) },
            hasSome: { type: list(base) },
            isEmpty: { type: GraphQLBoolean },
            equals: { type: list(base) },
          },
        });
      });
    }
    if (f.type === "Point" || f.type === "CartesianPoint") {
      const name = `${f.type}Filter`;
      return this.named(name, () => {
        const distance = new GraphQLInputObjectType({
          name: `${f.type}DistanceFilter`,
          fields: {
            from: { type: new GraphQLNonNull(base) },
            ...Object.fromEntries(RANGE_OPS.map((op) => [op, { type: GraphQLFloat }])),
          },
        });
        const box = new GraphQLInputObjectType({
          name: `${f.type}BBoxInput`,
          fields: {
            lowerLeft: { type: new GraphQLNonNull(base) },
            upperRight: { type: new GraphQLNonNull(base) },
          },
        });
        return new GraphQLInputObjectType({
          name,
          fields: {
            equals: { type: base },
            not: { type: base },
            distance: { type: distance },
            withinBBox: { type: box },
          },
        });
      });
    }
    return this.named(`${t}Filter`, () => {
      const fields: GraphQLInputFieldConfigMap = { equals: { type: base } };
      if (f.type === "Json") {
        fields.not = { type: base };
      } else if (f.type === "Boolean") {
        fields.not = { type: base };
      } else {
        fields.not = { type: base };
        fields.in = { type: list(base) };
        fields.notIn = { type: list(base) };
        if (f.type !== "Duration" && f.type !== "Enum") {
          for (const op of RANGE_OPS) fields[op] = { type: base };
        }
        if (f.type === "String") {
          fields.contains = { type: base };
          fields.startsWith = { type: base };
          fields.endsWith = { type: base };
          fields.mode = { type: this.QueryMode };
        }
      }
      return new GraphQLInputObjectType({ name: `${t}Filter`, fields });
    });
  }

  private labelsFilter(): GraphQLInputObjectType {
    return this.named("LabelsFilter", () => {
      const list = new GraphQLList(new GraphQLNonNull(GraphQLString));
      return new GraphQLInputObjectType({
        name: "LabelsFilter",
        description: "Filter on the dynamic labels (`@@labels`) of a node.",
        fields: {
          has: { type: GraphQLString },
          hasSome: { type: list },
          hasEvery: { type: list },
          hasNone: { type: list },
          isEmpty: { type: GraphQLBoolean },
        },
      });
    });
  }

  where(model: ResolvedNodeModel): GraphQLInputObjectType {
    const name = names.where(model.name);
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          fields: () => {
            const self = this.where(model);
            const fields: GraphQLInputFieldConfigMap = {
              AND: { type: new GraphQLList(new GraphQLNonNull(self)) },
              OR: { type: new GraphQLList(new GraphQLNonNull(self)) },
              NOT: { type: self },
            };
            Object.assign(fields, this.fieldFilters(model));
            const counted = this.api.counted(model).filter((f) => this.api.filterable(model, f));
            if (counted.length > 0) {
              fields._count = {
                type: this.countWhere(model, counted),
                description: "Filters on the number of related nodes (only the readable ones).",
              };
            }
            if (model.abstract) {
              fields._typename = { type: this.typenameFilter(model) };
              fields._on = { type: this.onWhere(model) };
            }
            if (!model.union && (model.dynamicLabels?.length ?? 0) > 0) {
              fields._labels = { type: this.labelsFilter() };
            }
            return fields;
          },
        }),
    );
  }

  /** `where` entries of every filterable field of `model`. */
  private fieldFilters(model: ResolvedNodeModel, skip: ReadonlySet<string> = new Set()) {
    const fields: GraphQLInputFieldConfigMap = {};
    for (const [name, def] of this.api.config.extensions.cypherFields.get(model.name) ?? []) {
      if (!def.filter || skip.has(name)) continue;
      fields[name] = { type: this.scalarFilter(refField(def.type)) };
    }
    for (const f of this.api.fields(model)) {
      if (skip.has(f.name) || !this.api.filterable(model, f)) continue;
      if (f.kind === "scalar") {
        fields[f.name] = { type: this.scalarFilter(f) };
      } else {
        const target = this.api.node(f.target);
        fields[f.name] = {
          type: f.many ? this.listRelationFilter(target) : this.relationFilter(target),
        };
      }
    }
    return fields;
  }

  /** `<Model>CountWhere`: a count filter per to-many relation of `model`. */
  private countWhere(
    model: ResolvedNodeModel,
    counted: readonly ResolvedRelationField[],
  ): GraphQLInputObjectType {
    const name = names.countWhere(model.name);
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          fields: () =>
            Object.fromEntries(
              counted.map((f) => [f.name, { type: this.countFilter(this.api.node(f.target)) }]),
            ),
        }),
    );
  }

  /** `<Target>CountFilter`: `Int` operators on a number of related nodes, and their `where`. */
  private countFilter(target: ResolvedNodeModel): GraphQLInputObjectType {
    const name = names.countFilter(target.name);
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          fields: () => {
            const list = new GraphQLList(new GraphQLNonNull(GraphQLInt));
            const fields: GraphQLInputFieldConfigMap = {
              equals: { type: GraphQLInt },
              not: { type: GraphQLInt },
              in: { type: list },
              notIn: { type: list },
            };
            for (const op of RANGE_OPS) fields[op] = { type: GraphQLInt };
            fields.where = { type: this.where(target), description: "Count only these nodes." };
            return fields;
          },
        }),
    );
  }

  private listRelationFilter(target: ResolvedNodeModel): GraphQLInputObjectType {
    const name = names.listRelationFilter(target.name);
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          fields: () => ({
            some: { type: this.where(target), description: "At least one related node matches." },
            none: { type: this.where(target), description: "No related node matches." },
            every: { type: this.where(target), description: "Every related node matches." },
          }),
        }),
    );
  }

  private relationFilter(target: ResolvedNodeModel): GraphQLInputObjectType {
    const name = names.relationFilter(target.name);
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          fields: () => ({
            is: { type: this.where(target), description: "The related node matches (null: none)." },
            isNot: { type: this.where(target) },
          }),
        }),
    );
  }

  private typenameEnum(model: ResolvedNodeModel): GraphQLEnumType {
    const name = names.typename(model.name);
    return this.named(
      name,
      () =>
        new GraphQLEnumType({
          name,
          values: Object.fromEntries(
            this.api.concrete(model).map((m) => [m.name, { value: m.name }]),
          ),
        }),
    );
  }

  private typenameFilter(model: ResolvedNodeModel): GraphQLInputObjectType {
    const name = names.typenameFilter(model.name);
    return this.named(name, () => {
      const t = this.typenameEnum(model);
      const list = new GraphQLList(new GraphQLNonNull(t));
      return new GraphQLInputObjectType({
        name,
        fields: {
          equals: { type: t },
          not: { type: t },
          in: { type: list },
          notIn: { type: list },
        },
      });
    });
  }

  private onWhere(model: ResolvedNodeModel): GraphQLInputObjectType {
    const name = names.onWhere(model.name);
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          description: `Per-${model.union ? "member" : "implementation"} filters: only the listed ones are kept.`,
          fields: () =>
            Object.fromEntries(
              (model.members ?? model.implementations ?? []).map((m) => [
                m,
                { type: this.where(this.api.node(m)) },
              ]),
            ),
        }),
    );
  }

  whereUnique(model: ResolvedNodeModel): GraphQLInputObjectType | undefined {
    const keys = model.uniqueFields
      .map((k) => model.fields.find((f) => f.name === k))
      .filter((f): f is ResolvedScalarField => f?.kind === "scalar")
      .filter((f) => this.api.fields(model).includes(f) && this.api.filterable(model, f));
    const compounds = (model.compoundUniques ?? []).filter((c) =>
      c.fields.every((name) => {
        const f = model.fields.find((x) => x.name === name);
        return f && this.api.fields(model).includes(f) && this.api.filterable(model, f);
      }),
    );
    if (keys.length === 0 && compounds.length === 0) return undefined;
    const name = names.whereUnique(model.name);
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          description:
            "At least one unique key (checked when the query runs), plus filters on the other fields.",
          fields: () => {
            const fields: GraphQLInputFieldConfigMap = {};
            for (const f of keys)
              fields[f.name] = { type: this.scalarBase(f, true) as GraphQLInputType };
            for (const c of compounds) {
              const keyName = `${model.name}${pascal(c.key)}Key`;
              fields[c.key] = {
                type: this.named(
                  keyName,
                  () =>
                    new GraphQLInputObjectType({
                      name: keyName,
                      fields: Object.fromEntries(
                        c.fields.map((fname) => {
                          const f = model.fields.find(
                            (x) => x.name === fname,
                          ) as ResolvedScalarField;
                          return [
                            fname,
                            {
                              type: new GraphQLNonNull(
                                this.scalarBase(f, true) as GraphQLInputType,
                              ),
                            },
                          ];
                        }),
                      ),
                    }),
                ),
              };
            }
            const self = this.where(model);
            Object.assign(fields, {
              AND: { type: new GraphQLList(new GraphQLNonNull(self)) },
              OR: { type: new GraphQLList(new GraphQLNonNull(self)) },
              NOT: { type: self },
            });
            Object.assign(fields, this.fieldFilters(model, new Set(keys.map((k) => k.name))));
            return fields;
          },
        }),
    );
  }

  // ---------------------------------------------------------------------------
  // Ordering
  // ---------------------------------------------------------------------------

  private pointOrder(type: "Point" | "CartesianPoint"): GraphQLInputObjectType {
    const name = `${type}DistanceOrder`;
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          description: "Sort by distance from a point (nearest first with asc, the default).",
          fields: {
            distanceFrom: {
              type: new GraphQLNonNull(type === "Point" ? PointInputType : CartesianPointInputType),
            },
            sort: { type: this.SortOrder },
          },
        }),
    );
  }

  /** `<Model>OrderBy`, or `undefined` when nothing of the model can be sorted on. */
  orderBy(model: ResolvedNodeModel): GraphQLInputObjectType | undefined {
    const fields = this.orderByFields(model);
    if (Object.keys(fields).length === 0) return undefined;
    const name = names.orderBy(model.name);
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          description: "One key per element of the orderBy list.",
          fields: () => this.orderByFields(model),
        }),
    );
  }

  private orderByFields(model: ResolvedNodeModel): GraphQLInputFieldConfigMap {
    const fields: GraphQLInputFieldConfigMap = {};
    if (model.abstract) fields._typename = { type: this.SortOrder };
    for (const [name, def] of this.api.config.extensions.cypherFields.get(model.name) ?? []) {
      if (def.sort) fields[name] = { type: this.SortOrder, description: "A Cypher-backed field." };
    }
    for (const f of this.api.fields(model)) {
      if (!this.api.sortable(model, f)) continue;
      if (f.kind === "scalar") {
        fields[f.name] = {
          type:
            f.type === "Point" || f.type === "CartesianPoint"
              ? this.pointOrder(f.type)
              : this.SortOrder,
        };
        continue;
      }
      const target = this.api.node(f.target);
      if (f.many) {
        fields[f.name] = {
          type: this.relationCountOrder(target),
          description: "Sort by the number of related nodes.",
        };
      } else {
        const t = this.scalarOrderBy(target);
        if (t) fields[f.name] = { type: t, description: "Sort by a field of the related node." };
      }
    }
    return fields;
  }

  private scalarOrderBy(model: ResolvedNodeModel): GraphQLInputObjectType | undefined {
    const scalars = this.api.sortableScalars(model);
    if (scalars.length === 0) return undefined;
    const name = names.scalarOrderBy(model.name);
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          fields: Object.fromEntries(scalars.map((f) => [f.name, { type: this.SortOrder }])),
        }),
    );
  }

  private relationCountOrder(target: ResolvedNodeModel): GraphQLInputObjectType {
    const name = names.relationCountOrder(target.name);
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          fields: () => ({
            _count: { type: new GraphQLNonNull(this.SortOrder) },
            where: { type: this.where(target), description: "Count only the matching nodes." },
          }),
        }),
    );
  }

  // ---------------------------------------------------------------------------
  // Write inputs
  // ---------------------------------------------------------------------------

  /** The input type of one value of a scalar field (`[Float!]` for a vector or a list). */
  private scalarInput(f: ResolvedScalarField): GraphQLInputType {
    const base = this.scalarBase(f, true) as GraphQLInputType;
    return f.list || f.type === "Vector" ? new GraphQLList(new GraphQLNonNull(base)) : base;
  }

  /** Whether a create must set `f` (required, no default). */
  private static required(f: ResolvedScalarField): boolean {
    return !f.optional && !f.list && !f.default;
  }

  /** `{ increment, decrement, multiply }` of a numeric type (`IntOps`, …). */
  private numberOps(f: ResolvedScalarField): GraphQLInputObjectType {
    const base = this.scalarBase(f, true) as GraphQLScalarType;
    const name = `${base.name}Ops`;
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          description: "Number updates, applied in this order to the current value.",
          fields: {
            increment: { type: base },
            decrement: { type: base },
            multiply: { type: base },
          },
        }),
    );
  }

  private labelsUpdate(): GraphQLInputObjectType {
    return this.named("LabelsUpdate", () => {
      const list = new GraphQLList(new GraphQLNonNull(GraphQLString));
      return new GraphQLInputObjectType({
        name: "LabelsUpdate",
        description: "Dynamic labels (`@@labels`) to add and remove, or the whole set.",
        fields: { add: { type: list }, remove: { type: list }, set: { type: list } },
      });
    });
  }

  /** `_ops` of an update: the numeric fields `update` may set, or `undefined`. */
  private opsInput(model: ResolvedNodeModel): GraphQLInputObjectType | undefined {
    const numeric = this.api
      .writeFields(model, "update")
      .filter(
        (f): f is ResolvedScalarField => f.kind === "scalar" && !f.list && NUMERIC.has(f.type),
      );
    if (numeric.length === 0) return undefined;
    const name = names.ops(model.name);
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          description: "Number updates of the fields (not with a value for the same field).",
          fields: Object.fromEntries(numeric.map((f) => [f.name, { type: this.numberOps(f) }])),
        }),
    );
  }

  /** The scalar (and `_labels`) fields of a create input. */
  private createScalars(model: ResolvedNodeModel): GraphQLInputFieldConfigMap {
    const fields: GraphQLInputFieldConfigMap = {};
    for (const f of this.api.writeFields(model, "create")) {
      if (f.kind !== "scalar") continue;
      const t = this.scalarInput(f);
      fields[f.name] = { type: SchemaBuilder.required(f) ? new GraphQLNonNull(t) : t };
    }
    if ((model.dynamicLabels?.length ?? 0) > 0) {
      fields._labels = {
        type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
        description: "Dynamic labels (`@@labels`) the new node carries.",
      };
    }
    return fields;
  }

  /** The scalar, `_ops` and `_labels` fields of an update input. */
  private updateScalars(model: ResolvedNodeModel): GraphQLInputFieldConfigMap {
    const fields: GraphQLInputFieldConfigMap = {};
    for (const f of this.api.writeFields(model, "update")) {
      if (f.kind === "scalar") fields[f.name] = { type: this.scalarInput(f) };
    }
    const ops = this.opsInput(model);
    if (ops) fields._ops = { type: ops };
    if ((model.dynamicLabels?.length ?? 0) > 0) fields._labels = { type: this.labelsUpdate() };
    return fields;
  }

  /** How `field` of `owner` is written: see {@link RelationSide}. */
  relationSide(owner: ResolvedNodeModel, field: ResolvedRelationField): RelationSide {
    const target = this.api.node(field.target);
    const inverse = this.api.inverse(owner, field)?.name;
    const edge = field.edge && this.api.edges.has(field.edge) ? field.edge : undefined;
    const suffix = inverse ? `Without${pascal(inverse)}` : edge ? `Via${edge}` : "";
    return { field, target, inverse, edge, suffix };
  }

  /**
   * `<Model>CreateInput` (the root create), or the item of a nested create through `side`
   * (`<Model>CreateWithout<Inverse>Input`, with `_edge` on a typed edge).
   */
  createInput(model: ResolvedNodeModel, side?: RelationSide): GraphQLInputObjectType {
    const suffix = side?.suffix ?? "";
    const name = `${model.name}Create${suffix}Input`;
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          fields: () => {
            const fields = this.createScalars(model);
            for (const f of this.api.writeFields(model, "create")) {
              if (f.kind !== "relation" || f.name === side?.inverse) continue;
              const t = this.relationInput(this.relationSide(model, f), "create");
              if (t) fields[f.name] = { type: t };
            }
            if (side?.edge) fields._edge = { type: this.edgeInput(side.edge) };
            return fields;
          },
        }),
    );
  }

  /** The item of a nested create into a union: one field per member that can be created. */
  private unionCreateInput(side: RelationSide): GraphQLInputObjectType | undefined {
    const members = this.api.concrete(side.target).filter((m) => this.api.creatable(m));
    if (members.length === 0) return undefined;
    const name = `${side.target.name}Create${side.suffix}Input`;
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          description: "Exactly one member: the node to create.",
          fields: () => {
            const fields: GraphQLInputFieldConfigMap = {};
            for (const m of members) fields[m.name] = { type: this.createInput(m) };
            if (side.edge) fields._edge = { type: this.edgeInput(side.edge) };
            return fields;
          },
        }),
    );
  }

  /** `<Model>CreateManyInput`: the scalars of a create (createMany takes no relation writes). */
  createManyInput(model: ResolvedNodeModel): GraphQLInputObjectType | undefined {
    const fields = this.createScalars(model);
    if (Object.keys(fields).length === 0) return undefined;
    const name = names.createMany(model.name);
    return this.named(name, () => new GraphQLInputObjectType({ name, fields }));
  }

  /**
   * `<Model>UpdateInput`: new values (`null` removes the property), `_ops`, relation writes. Or
   * the data of a nested update through `side`, without the target's back relation
   * (`<Model>UpdateWithout<Inverse>Input`).
   */
  updateInput(model: ResolvedNodeModel, side?: RelationSide): GraphQLInputObjectType | undefined {
    const scalars = this.updateScalars(model);
    const inverse = side?.inverse;
    const relations = this.api
      .writeFields(model, "update")
      .filter((f): f is ResolvedRelationField => f.kind === "relation" && f.name !== inverse)
      .map((f) => [f.name, this.relationInput(this.relationSide(model, f), "update")] as const)
      .filter((e): e is readonly [string, GraphQLInputObjectType] => e[1] !== undefined);
    if (Object.keys(scalars).length === 0 && relations.length === 0) return undefined;
    const name = inverse
      ? `${model.name}UpdateWithout${pascal(inverse)}Input`
      : names.update(model.name);
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          fields: () => ({
            ...scalars,
            ...Object.fromEntries(relations.map(([k, t]) => [k, { type: t }])),
          }),
        }),
    );
  }

  /** `<Model>UpdateManyInput`: scalars, `_ops` and `_labels` (updateMany takes no relation writes). */
  updateManyInput(model: ResolvedNodeModel): GraphQLInputObjectType | undefined {
    const fields = this.updateScalars(model);
    if (Object.keys(fields).length === 0) return undefined;
    const name = names.updateMany(model.name);
    return this.named(name, () => new GraphQLInputObjectType({ name, fields }));
  }

  /** `<Edge>Input`: the edge properties (and `_ops` for numeric ones, on connect / set). */
  private edgeInput(edgeName: string): GraphQLInputObjectType {
    const name = names.edgeInput(edgeName);
    return this.named(name, () => {
      const edge = this.api.edges.get(edgeName)!;
      const fields: GraphQLInputFieldConfigMap = {};
      for (const p of edge.properties) fields[p.name] = { type: this.scalarInput(p) };
      const numeric = edge.properties.filter((p) => !p.list && NUMERIC.has(p.type));
      if (numeric.length > 0) {
        const opsName = names.ops(edgeName);
        fields._ops = {
          type: this.named(
            opsName,
            () =>
              new GraphQLInputObjectType({
                name: opsName,
                description:
                  "Number updates of edge properties, on connect and set (a new edge starts from the default, or 0).",
                fields: Object.fromEntries(
                  numeric.map((p) => [p.name, { type: this.numberOps(p) }]),
                ),
              }),
          ),
        };
      }
      return new GraphQLInputObjectType({ name, fields });
    });
  }

  /**
   * What identifies one related node on `side` (connect, set, disconnect): the target's
   * `WhereUnique`, a member-keyed input for a union, plus `_edge` when `withEdge` and the
   * relation has a typed edge. `undefined` when the target has no unique key the API exposes.
   */
  private connectInput(side: RelationSide, withEdge: boolean): GraphQLInputType | undefined {
    const { target } = side;
    const edge = withEdge ? side.edge : undefined;
    if (!target.union) {
      const unique = this.whereUnique(target);
      if (!unique || !edge) return unique;
      const name = names.connect(target.name, edge);
      return this.named(
        name,
        () =>
          new GraphQLInputObjectType({
            name,
            description: `A ${target.name} by unique key, with the properties of the ${edge} edge.`,
            fields: () => ({
              ...unique.getFields(),
              _edge: { type: this.edgeInput(edge) },
            }),
          }),
      );
    }
    const members = (target.members ?? target.implementations ?? [])
      .map((m) => this.api.node(m))
      .map((m) => [m, this.whereUnique(m)] as const)
      .filter((e): e is readonly [ResolvedNodeModel, GraphQLInputObjectType] => e[1] !== undefined);
    if (members.length === 0) return undefined;
    const name = edge ? names.connect(target.name, edge) : names.whereUnique(target.name);
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          description: "Exactly one member, by unique key.",
          fields: () => {
            const fields: GraphQLInputFieldConfigMap = {};
            for (const [m, t] of members) fields[m.name] = { type: t };
            if (edge) fields._edge = { type: this.edgeInput(edge) };
            return fields;
          },
        }),
    );
  }

  /**
   * The nested writes of a relation (`<Target><Create|Update><One|Many><suffix>Relation`):
   * `create` (when the target can be created through the API), `connect`, and on update
   * `disconnect` and (to-many) `set`. `undefined` when none is possible.
   */
  relationInput(side: RelationSide, mode: "create" | "update"): GraphQLInputObjectType | undefined {
    const { target, field } = side;
    const create = target.union
      ? this.unionCreateInput(side)
      : this.api.creatable(target)
        ? this.createInput(target, side)
        : undefined;
    const connect = this.connectInput(side, true);
    const unique = this.connectInput(side, false);
    // Built in the fields thunk (an update input of the target has relation inputs in turn).
    const toOne =
      mode === "update" &&
      !field.many &&
      !target.union &&
      (this.api.has(target, "delete") ||
        (this.api.has(target, "update") && Object.keys(this.updateScalars(target)).length > 0));
    if (!create && !connect && !toOne) return undefined;
    const list = (t: GraphQLInputType) => new GraphQLList(new GraphQLNonNull(t));
    const name = `${target.name}${mode === "create" ? "Create" : "Update"}${field.many ? "Many" : "One"}${side.suffix}Relation`;
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          fields: () => {
            const fields: GraphQLInputFieldConfigMap = {};
            if (create) {
              fields.create = {
                type: field.many ? list(create) : create,
                ...(mode === "update" && !field.many
                  ? { description: "Replaces the related node's edge." }
                  : {}),
              };
            }
            if (connect) {
              fields.connect = {
                type: field.many ? list(connect) : connect,
                description: field.many
                  ? "MERGEs an edge to each node (connecting a linked node keeps one edge)."
                  : "MERGEs the edge, replacing the current one.",
              };
            }
            if (mode === "update" && unique) {
              if (field.many) {
                fields.disconnect = { type: list(unique) };
                fields.set = {
                  type: list(connect!),
                  description:
                    "The only linked nodes afterwards (edges to the others are deleted).",
                };
              } else {
                fields.disconnect = { type: GraphQLBoolean, description: "true: remove the edge." };
              }
            }
            return { ...fields, ...this.nestedWrites(side, mode, create) };
          },
        }),
    );
  }

  /**
   * The writes of a relation to the related nodes themselves: `connectOrCreate` (when the target
   * can be created and has a unique key), and on update `update` / `delete` / `upsert` (when the
   * target's `update` / `delete` / `upsert` operations are on). None for a union target: they name
   * the node by the target's own key.
   */
  private nestedWrites(
    side: RelationSide,
    mode: "create" | "update",
    create: GraphQLInputObjectType | undefined,
  ): GraphQLInputFieldConfigMap {
    const { target, field } = side;
    const fields: GraphQLInputFieldConfigMap = {};
    if (target.union) return fields;
    const unique = this.whereUnique(target);
    const list = (t: GraphQLInputType) => new GraphQLList(new GraphQLNonNull(t));
    const nonNull = (t: GraphQLInputType) => new GraphQLNonNull(t);
    const many = (t: GraphQLInputType) => (field.many ? list(t) : t);
    const item = (kind: string, build: () => GraphQLInputFieldConfigMap, description: string) => {
      const name = `${target.name}${kind}${field.many ? "Many" : "One"}${side.suffix}Input`;
      return this.named(
        name,
        () => new GraphQLInputObjectType({ name, description, fields: build }),
      );
    };
    if (create && unique) {
      fields.connectOrCreate = {
        type: many(
          item(
            "ConnectOrCreate",
            () => ({ where: { type: nonNull(unique) }, create: { type: nonNull(create) } }),
            `Links the ${target.name} matching where (a MERGE of the edge, as connect), or creates it.`,
          ),
        ),
        description: side.edge
          ? "`_edge` (in create) sets the edge's properties, also when an existing node is linked."
          : undefined,
      };
    }
    if (mode === "create") return fields;
    const updatable = this.api.has(target, "update");
    const data = updatable ? this.updateInput(target, side) : undefined;
    if (data && (unique || !field.many)) {
      fields.update = field.many
        ? {
            type: list(
              item(
                "UpdateWhere",
                () => ({ where: { type: nonNull(unique!) }, data: { type: nonNull(data) } }),
                `A linked ${target.name}, by unique key, and its update.`,
              ),
            ),
            description: "Updates linked nodes (NOT_FOUND when one is not linked).",
          }
        : { type: data, description: "Updates the linked node (NOT_FOUND when there is none)." };
    }
    if (this.api.has(target, "delete") && (unique || !field.many)) {
      fields.delete = field.many
        ? {
            type: list(unique!),
            description:
              "Deletes linked nodes, with their onDelete rules (NOT_FOUND when one is not linked).",
          }
        : {
            type: GraphQLBoolean,
            description: "true: deletes the linked node (NOT_FOUND when there is none).",
          };
    }
    if (this.api.has(target, "upsert") && create && data && (unique || !field.many)) {
      fields.upsert = {
        type: many(
          item(
            "Upsert",
            () => ({
              ...(field.many ? { where: { type: nonNull(unique!) } } : {}),
              create: { type: nonNull(create) },
              update: { type: nonNull(data) },
            }),
            `Updates the linked ${target.name}${field.many ? " matching where" : ""}, or creates and links one when there is none.`,
          ),
        ),
      };
    }
    return fields;
  }

  /** `<Model>Batch`: what batch mutations return. */
  batchType(model: ResolvedNodeModel): GraphQLObjectType {
    const name = names.batch(model.name);
    return this.named(
      name,
      () =>
        new GraphQLObjectType({
          name,
          fields: () => ({
            count: { type: new GraphQLNonNull(GraphQLInt), resolve: byResponseKey },
            nodes: {
              type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(this.output(model)))),
              description:
                "The affected records (as they were, for deleteMany). Loaded only when selected.",
              resolve: byResponseKey,
            },
          }),
        }),
    );
  }

  // ---------------------------------------------------------------------------
  // Output types
  // ---------------------------------------------------------------------------

  /** The output type of a model: an object, an interface or a union. */
  output(model: ResolvedNodeModel): GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType {
    const existing = this.types.get(model.name);
    if (existing) return existing as GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType;
    let t: GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType;
    if (model.abstract && !this.api.isGraphQLInterface(model)) {
      t = new GraphQLUnionType({
        name: model.name,
        types: () => this.api.concrete(model).map((m) => this.output(m) as GraphQLObjectType),
        resolveType,
      });
    } else if (model.abstract) {
      t = new GraphQLInterfaceType({
        name: model.name,
        interfaces: () => this.interfacesOf(model),
        fields: () => this.outputFields(model),
        resolveType,
      });
    } else {
      t = new GraphQLObjectType({
        name: model.name,
        interfaces: () => this.interfacesOf(model),
        fields: () => this.outputFields(model),
      });
    }
    this.types.set(model.name, t);
    return t;
  }

  /** The GraphQL interfaces of a model's type: its own, and `Node` with Relay. */
  private interfacesOf(model: ResolvedNodeModel): GraphQLInterfaceType[] {
    const own = this.api
      .graphQLInterfaces(model)
      .map((i) => this.output(i) as GraphQLInterfaceType);
    return this.api.relayKey(model) ? [this.Node, ...own] : own;
  }

  /** Arguments of a to-many relation field (a nested `include` of the client). */
  private listArgs(target: ResolvedNodeModel): GraphQLFieldConfigArgumentMap {
    const args: GraphQLFieldConfigArgumentMap = { where: { type: this.where(target) } };
    const order = this.orderBy(target);
    if (order) args.orderBy = { type: new GraphQLList(new GraphQLNonNull(order)) };
    args.skip = { type: GraphQLInt };
    args.take = { type: GraphQLInt };
    return args;
  }

  private outputFields(model: ResolvedNodeModel): GraphQLFieldConfigMap<AnyRecord, unknown> {
    const fields: GraphQLFieldConfigMap<AnyRecord, unknown> = {};
    if (this.api.relayKey(model)) {
      fields.id = {
        type: new GraphQLNonNull(GraphQLID),
        description: "The global id (Relay).",
        resolve: byResponseKey,
      };
    }
    for (const f of this.api.fields(model)) {
      const access = this.api.config.field(model.name, f.name);
      const deprecationReason = access.deprecated;
      // A field with a read rule is nullable: `null` where the rule hides it.
      const ruled = this.api.config.fieldRuled(model.name, f.name);
      const description = ruled ? "Null where a read rule hides it." : undefined;
      if (f.kind === "scalar") {
        const type = this.scalarOutput(f);
        fields[this.api.outputName(model, f.name)] = {
          type: ruled ? getNullableType(type) : type,
          description,
          resolve: byResponseKey,
          deprecationReason,
        };
        continue;
      }
      const target = this.api.node(f.target);
      const t = this.output(target);
      const list = new GraphQLList(new GraphQLNonNull(t));
      fields[f.name] = f.many
        ? {
            type: ruled ? list : new GraphQLNonNull(list),
            description,
            args: this.listArgs(target),
            resolve: byResponseKey,
            deprecationReason,
          }
        : { type: t, description, resolve: byResponseKey, deprecationReason };
    }
    const count = this.countType(model);
    if (count) {
      fields._count = {
        type: new GraphQLNonNull(count),
        description:
          "Number of related nodes per to-many relation (only the selected ones are counted).",
        resolve: byResponseKey,
      };
    }
    if ((model.dynamicLabels?.length ?? 0) > 0) {
      fields._labels = {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
        description: "The dynamic labels (`@@labels`) the node carries.",
        resolve: byResponseKey,
      };
    }
    const edge = this.edgeType(model);
    if (edge) {
      fields._edge = {
        type: edge,
        description: `Edge properties when this ${model.name} is reached through a relation with a relationship model (selecting it anywhere else is an error).`,
        resolve: byResponseKey,
      };
    }
    Object.assign(fields, this.namedTraversalFields(model), this.extensionFields(model));
    if (this.api.scored(model)) {
      fields._score = {
        type: GraphQLFloat,
        description: `Relevance or similarity score when this ${model.name} comes from a search or findSimilar root field (selecting it anywhere else is an error).`,
        resolve: byResponseKey,
      };
    }
    if (this.api.fused(model)) {
      fields._scores = {
        type: new GraphQLList(new GraphQLNonNull(this.indexScore())),
        description: `Each index's score when this ${model.name} comes from a search or findSimilar over a union (selecting it anywhere else is an error).`,
        resolve: byResponseKey,
      };
    }
    if (Object.keys(fields).length === 0) {
      throw new NativeSchemaError(
        `${model.name} has no field the API exposes; GraphQL object types need at least one.`,
      );
    }
    return fields;
  }

  /** `<Model>Count`: an interface on interfaces, implemented by their implementations' ones. */
  countType(model: ResolvedNodeModel): GraphQLObjectType | GraphQLInterfaceType | undefined {
    if (model.union || this.api.counted(model).length === 0) return undefined;
    const name = names.count(model.name);
    return this.named(name, () => {
      const fields = () => {
        const out: GraphQLFieldConfigMap<AnyRecord, unknown> = {};
        for (const f of this.api.counted(model)) {
          out[f.name] = {
            type: new GraphQLNonNull(GraphQLInt),
            args: { where: { type: this.where(this.api.node(f.target)) } },
            resolve: byResponseKey,
          };
        }
        return out;
      };
      const interfaces = () =>
        this.api
          .graphQLInterfaces(model)
          .map((i) => this.countType(i))
          .filter((t): t is GraphQLInterfaceType => t instanceof GraphQLInterfaceType);
      return model.abstract
        ? new GraphQLInterfaceType({ name, fields, interfaces, resolveType })
        : new GraphQLObjectType({ name, fields, interfaces });
    });
  }

  /** The object type of an edge model (fields read by name: they take no arguments). */
  private edgeObject(name: string): GraphQLObjectType {
    return this.named(
      name,
      () => {
        const edge = this.api.edges.get(name)!;
        return new GraphQLObjectType({
          name,
          fields: () =>
            Object.fromEntries(
              edge.properties.map((p) => [p.name, { type: this.scalarOutput(p) }]),
            ),
        });
      },
      true,
    );
  }

  /** `_edge`'s type: the edge model, or a union when several reach the model's family. */
  private edgeType(model: ResolvedNodeModel): GraphQLOutputType | undefined {
    const edges = this.api.edgeModels(model);
    if (edges.length === 0) return undefined;
    if (edges.length === 1) return this.edgeObject(edges[0]!);
    const name = names.edgeUnion(this.api.edgeFamily(model));
    return this.named(
      name,
      () =>
        new GraphQLUnionType({
          name,
          description: "Edge properties: one member per relationship model.",
          types: () => edges.map((e) => this.edgeObject(e)),
          resolveType,
        }),
    );
  }

  listType(model: ResolvedNodeModel): GraphQLObjectType {
    const name = names.list(model.name);
    return this.named(
      name,
      () =>
        new GraphQLObjectType({
          name,
          fields: () => ({
            nodes: {
              type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(this.output(model)))),
              resolve: byResponseKey,
            },
            pageInfo: { type: new GraphQLNonNull(this.PageInfo), resolve: byResponseKey },
            totalCount: {
              type: new GraphQLNonNull(GraphQLInt),
              description:
                "Number of nodes matching where, ignoring paging. Counted only when selected.",
              resolve: byResponseKey,
            },
          }),
        }),
    );
  }

  // ---------------------------------------------------------------------------
  // Aggregates and groupBy
  // ---------------------------------------------------------------------------

  /** The nullable output type of one aggregated value of `f` (`_min`, `_sum`, a group key). */
  private valueOutput(f: ResolvedScalarField): GraphQLOutputType {
    return this.scalarBase(f, false) as GraphQLOutputType;
  }

  /** `_sum`'s type for `f`: the field's own number type (`Int`, `Float`, `BigInt`). */
  private sumOutput(f: ResolvedScalarField): GraphQLOutputType {
    return f.type === "BigInt" ? BigIntScalar : f.type === "Float" ? GraphQLFloat : GraphQLInt;
  }

  /** `<Model>CountAggregate`, `<Model>SumAggregate`, …: one object type per aggregate. */
  private aggregateFields(model: ResolvedNodeModel): GraphQLFieldConfigMap<AnyRecord, unknown> {
    const nn = (t: GraphQLOutputType) => new GraphQLNonNull(t);
    const object = (
      name: string,
      description: string,
      fields: [string, GraphQLOutputType][],
    ): GraphQLObjectType =>
      this.named(
        name,
        () =>
          new GraphQLObjectType({
            name,
            description,
            fields: Object.fromEntries(
              fields.map(([k, type]) => [k, { type, resolve: byResponseKey }]),
            ),
          }),
      );
    const out: GraphQLFieldConfigMap<AnyRecord, unknown> = {};
    const count = object(
      names.countAggregate(model.name),
      "`_all`: the number of nodes; a field: the number of its non-null values.",
      [
        ["_all", nn(GraphQLInt)],
        ...this.api
          .scalars(model)
          .map((f): [string, GraphQLOutputType] => [f.name, nn(GraphQLInt)]),
      ],
    );
    out._count = { type: nn(count), resolve: byResponseKey };
    const numeric = this.api.numericFields(model);
    const orderable = this.api.orderableFields(model);
    if (numeric.length > 0) {
      const sum = object(
        names.sumAggregate(model.name),
        "Sums of the non-null values (null when there are none).",
        numeric.map((f) => [f.name, this.sumOutput(f)]),
      );
      const avg = object(
        names.avgAggregate(model.name),
        "Means of the non-null values (null when there are none).",
        numeric.map((f) => [f.name, GraphQLFloat]),
      );
      out._sum = { type: nn(sum), resolve: byResponseKey };
      out._avg = { type: nn(avg), resolve: byResponseKey };
    }
    if (orderable.length > 0) {
      const fields = orderable.map((f): [string, GraphQLOutputType] => [
        f.name,
        this.valueOutput(f),
      ]);
      const min = object(names.minAggregate(model.name), "Smallest non-null values.", fields);
      const max = object(names.maxAggregate(model.name), "Largest non-null values.", fields);
      out._min = { type: nn(min), resolve: byResponseKey };
      out._max = { type: nn(max), resolve: byResponseKey };
    }
    return out;
  }

  /** `<Model>Aggregate`: what `<model>Aggregate` returns (only the selected aggregates run). */
  aggregateType(model: ResolvedNodeModel): GraphQLObjectType {
    const name = names.aggregate(model.name);
    return this.named(
      name,
      () => new GraphQLObjectType({ name, fields: () => this.aggregateFields(model) }),
    );
  }

  /** `<Model>GroupField`: the fields of `model` `groupBy` can group on. */
  private groupFieldEnum(model: ResolvedNodeModel): GraphQLEnumType {
    const name = names.groupField(model.name);
    return this.named(
      name,
      () =>
        new GraphQLEnumType({
          name,
          values: Object.fromEntries(
            this.api.groupFields(model).map((f) => [f.name, { value: f.name }]),
          ),
        }),
    );
  }

  /** `<Model>GroupByInput`: `fields` of the model, and the fields of each to-one relation. */
  private groupByInput(model: ResolvedNodeModel): GraphQLInputObjectType {
    const name = names.groupByInput(model.name);
    return this.named(name, () => {
      const list = (t: GraphQLInputType) => new GraphQLList(new GraphQLNonNull(t));
      const fields: GraphQLInputFieldConfigMap = {};
      if (this.api.groupFields(model).length > 0) {
        fields.fields = {
          type: list(this.groupFieldEnum(model)),
          description: "Fields of the model.",
        };
      }
      for (const r of this.api.groupRelations(model)) {
        fields[r.name] = {
          type: list(this.groupFieldEnum(this.api.node(r.target))),
          description: `Fields of the related ${r.target} (to-one).`,
        };
      }
      return new GraphQLInputObjectType({
        name,
        description: "The fields to group on: at least one.",
        fields,
      });
    });
  }

  /** `<Model>GroupKeys`: the group key fields of a related node, in a `<Model>Group` row. */
  private groupKeys(model: ResolvedNodeModel): GraphQLObjectType {
    const name = names.groupKeys(model.name);
    return this.named(
      name,
      () =>
        new GraphQLObjectType({
          name,
          description: "Group keys of the related node (only the fields listed in by).",
          fields: Object.fromEntries(
            this.api
              .groupFields(model)
              .map((f) => [f.name, { type: this.valueOutput(f), resolve: byResponseKey }]),
          ),
        }),
    );
  }

  /** `<Model>Group`: one row of `<model>GroupBy` (keys listed in `by`, then aggregates). */
  groupType(model: ResolvedNodeModel): GraphQLObjectType {
    const name = names.group(model.name);
    return this.named(
      name,
      () =>
        new GraphQLObjectType({
          name,
          description:
            "One group: its keys (only the fields listed in by can be selected) and aggregates.",
          fields: () => {
            const fields: GraphQLFieldConfigMap<AnyRecord, unknown> = {};
            for (const f of this.api.groupFields(model)) {
              fields[f.name] = { type: this.valueOutput(f), resolve: byResponseKey };
            }
            for (const r of this.api.groupRelations(model)) {
              fields[r.name] = {
                type: this.groupKeys(this.api.node(r.target)),
                resolve: byResponseKey,
              };
            }
            return { ...fields, ...this.aggregateFields(model) };
          },
        }),
    );
  }

  /**
   * `<Type>Having` (`IntHaving`, `StringHaving`, …): the filters of a group key (when the field is
   * listed in `by`) and of the aggregates of a field of that type.
   */
  private scalarHaving(f: ResolvedScalarField): GraphQLInputObjectType {
    const groupable = !f.list && !["Vector", "Json", "Point", "CartesianPoint"].includes(f.type);
    const base = this.scalarBase(f, true) as GraphQLInputType & { name: string };
    const name = groupable ? `${base.name}Having` : "CountHaving";
    return this.named(name, () => {
      const filter = (type: ResolvedScalarField["type"]) => this.scalarFilter(syntheticField(type));
      const fields: GraphQLInputFieldConfigMap = {};
      if (groupable) {
        const own = this.scalarFilter(f) as GraphQLInputObjectType;
        for (const [k, v] of Object.entries(own.getFields())) {
          fields[k] = { type: v.type, description: v.description };
        }
      }
      fields._count = { type: filter("Int"), description: "The number of non-null values." };
      if (groupable && NUMERIC_TYPES.has(f.type)) {
        fields._sum = {
          type: filter(f.type === "BigInt" ? "BigInt" : f.type === "Float" ? "Float" : "Int"),
        };
        fields._avg = { type: filter("Float") };
      }
      if (groupable && ORDERABLE_TYPES.has(f.type)) {
        fields._min = { type: this.scalarFilter(f) };
        fields._max = { type: this.scalarFilter(f) };
      }
      return new GraphQLInputObjectType({
        name,
        description: groupable
          ? "Aggregates of the field in each group; the other filters need the field in by."
          : "Aggregates of the field in each group.",
        fields,
      });
    });
  }

  /** `<Model>GroupKeyFilter`: filters on the group keys of a related node, in `having`. */
  private groupKeyFilter(model: ResolvedNodeModel): GraphQLInputObjectType {
    const name = names.groupKeyFilter(model.name);
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          description: "Filters on the related node's fields listed in by.",
          fields: Object.fromEntries(
            this.api
              .groupFields(model)
              .filter((f) => this.api.filterable(model, f))
              .map((f) => [f.name, { type: this.scalarFilter(f) }]),
          ),
        }),
    );
  }

  /** `<Model>Having`: filters on the groups of a `groupBy` (keys and aggregates). */
  private having(model: ResolvedNodeModel): GraphQLInputObjectType {
    const name = names.having(model.name);
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          fields: () => {
            const self = this.having(model);
            const fields: GraphQLInputFieldConfigMap = {
              AND: { type: new GraphQLList(new GraphQLNonNull(self)) },
              OR: { type: new GraphQLList(new GraphQLNonNull(self)) },
              NOT: { type: self },
            };
            for (const f of this.api.scalars(model)) {
              if (this.api.config.field(model.name, f.name).filter) {
                fields[f.name] = { type: this.scalarHaving(f) };
              }
            }
            for (const r of this.api.groupRelations(model)) {
              if (!this.api.filterable(model, r)) continue;
              const t = this.groupKeyFilter(this.api.node(r.target));
              if (Object.keys(t.getFields()).length > 0) fields[r.name] = { type: t };
            }
            return fields;
          },
        }),
    );
  }

  /** An input of `SortOrder` fields (aggregate and group key orderings). */
  private sortInput(
    name: string,
    keys: readonly string[],
    description?: string,
  ): GraphQLInputObjectType {
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          description,
          fields: Object.fromEntries(keys.map((k) => [k, { type: this.SortOrder }])),
        }),
    );
  }

  /** `<Model>GroupOrderBy`: sort groups by keys listed in `by` or by aggregates. */
  private groupOrderBy(model: ResolvedNodeModel): GraphQLInputObjectType {
    const name = names.groupOrderBy(model.name);
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          description:
            "One key per element of the orderBy list: a key listed in by, or an aggregate.",
          fields: () => {
            const sortable = (m: ResolvedNodeModel, fs: readonly ResolvedScalarField[]) =>
              fs.filter((f) => this.api.sortable(m, f)).map((f) => f.name);
            const fields: GraphQLInputFieldConfigMap = {};
            for (const k of sortable(model, this.api.groupFields(model))) {
              fields[k] = { type: this.SortOrder };
            }
            for (const r of this.api.groupRelations(model)) {
              const target = this.api.node(r.target);
              const keys = sortable(target, this.api.groupFields(target));
              if (!this.api.sortable(model, r) || keys.length === 0) continue;
              fields[r.name] = { type: this.sortInput(names.groupKeyOrderBy(target.name), keys) };
            }
            const counted = sortable(model, this.api.scalars(model));
            fields._count = {
              type: this.sortInput(names.countOrderBy(model.name), ["_all", ...counted]),
            };
            const numeric = sortable(model, this.api.numericFields(model));
            if (numeric.length > 0) {
              const t = this.sortInput(names.numericOrderBy(model.name), numeric);
              fields._sum = { type: t };
              fields._avg = { type: t };
            }
            const orderable = sortable(model, this.api.orderableFields(model));
            if (orderable.length > 0) {
              const t = this.sortInput(names.minMaxOrderBy(model.name), orderable);
              fields._min = { type: t };
              fields._max = { type: t };
            }
            return fields;
          },
        }),
    );
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  readonly SearchMode = new GraphQLEnumType({
    name: "SearchMode",
    description:
      "How search reads query: `lucene` (Lucene query syntax, the default), `terms` (any of the words, escaped), `phrase` (the words in order, escaped).",
    values: { lucene: { value: "lucene" }, terms: { value: "terms" }, phrase: { value: "phrase" } },
  });

  /** `IndexScore`: one index's score of a union search hit (`_scores`). */
  private indexScore(): GraphQLObjectType {
    return this.named(
      "IndexScore",
      () =>
        new GraphQLObjectType({
          name: "IndexScore",
          fields: {
            index: {
              type: new GraphQLNonNull(GraphQLString),
              description: "The full-text index (search) or the vector field (findSimilar).",
              resolve: byResponseKey,
            },
            score: {
              type: new GraphQLNonNull(GraphQLFloat),
              description: "The index's own score.",
              resolve: byResponseKey,
            },
            normalized: {
              type: new GraphQLNonNull(GraphQLFloat),
              description: "score min-max normalised over the hits of this index, in [0, 1].",
              resolve: byResponseKey,
            },
            rank: {
              type: new GraphQLNonNull(GraphQLInt),
              description: "Position of the hit in this index's list, from 1.",
              resolve: byResponseKey,
            },
          },
        }),
    );
  }

  /** An enum of names (index names, vector fields); each must be a GraphQL name. */
  private nameEnum(name: string, values: readonly string[], what: string): GraphQLEnumType {
    return this.named(name, () => {
      for (const v of values) {
        if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(v) || v === "true" || v === "false" || v === "null") {
          throw new NativeSchemaError(
            `${what} "${v}" is not a valid GraphQL enum value; rename it in schema.cyphra (name: "…").`,
          );
        }
      }
      return new GraphQLEnumType({
        name,
        values: Object.fromEntries(values.map((v) => [v, { value: v }])),
      });
    });
  }

  /** `<Model>FulltextIndex`: the `@@fulltext` indexes of a model. */
  private fulltextIndexEnum(model: ResolvedNodeModel): GraphQLEnumType {
    return this.nameEnum(
      names.fulltextIndex(model.name),
      (model.fulltextIndexes ?? []).map((i) => i.name),
      `${model.name}: the @@fulltext index name`,
    );
  }

  /** `<Model>VectorField`: the `Vector(N)` fields of a model with a `@vectorIndex`. */
  private vectorFieldEnum(model: ResolvedNodeModel): GraphQLEnumType {
    return this.nameEnum(
      names.vectorField(model.name),
      model.fields.filter((f) => f.kind === "scalar" && f.vectorIndex).map((f) => f.name),
      `${model.name}: the vector field`,
    );
  }

  /** Members of a union with a `@@fulltext` index / a `@vectorIndex` field. */
  private searchedMembers(
    union: ResolvedNodeModel,
    kind: "search" | "findSimilar",
  ): ResolvedNodeModel[] {
    return this.api
      .concrete(union)
      .filter((m) =>
        kind === "search"
          ? (m.fulltextIndexes?.length ?? 0) > 0
          : m.fields.some((f) => f.kind === "scalar" && f.vectorIndex),
      );
  }

  /** `<Union>SearchIndexes` / `<Union>SimilarFields`: the index of each member to query. */
  private memberIndexes(
    union: ResolvedNodeModel,
    kind: "search" | "findSimilar",
  ): GraphQLInputObjectType {
    const name =
      kind === "search" ? names.searchIndexes(union.name) : names.similarFields(union.name);
    return this.named(
      name,
      () =>
        new GraphQLInputObjectType({
          name,
          description: `The ${kind === "search" ? "@@fulltext index" : "vector field"} to query for each member (only the members listed are searched). Default: every member with exactly one.`,
          fields: () =>
            Object.fromEntries(
              this.searchedMembers(union, kind).map((m) => [
                m.name,
                { type: kind === "search" ? this.fulltextIndexEnum(m) : this.vectorFieldEnum(m) },
              ]),
            ),
        }),
    );
  }

  /** Arguments of `<model>Search` / `<model>FindSimilar` (a node model or a union). */
  private searchArgs(
    model: ResolvedNodeModel,
    op: "search" | "findSimilar",
  ): GraphQLFieldConfigArgumentMap {
    const nn = <T extends GraphQLInputType>(t: T) => new GraphQLNonNull(t);
    const where = { type: this.where(model) };
    const minScore = {
      type: GraphQLFloat,
      description:
        op === "search"
          ? "Drop hits scoring below this (Lucene scores: positive, per query)."
          : "Drop hits scoring below this (similarities, in [0, 1]).",
    };
    const vector = {
      type: nn(new GraphQLList(nn(GraphQLFloat))),
      description: "The query embedding.",
    };
    if (model.union) {
      const fusion: GraphQLFieldConfigArgumentMap = {
        where: { ...where, description: "Filter on the hits (_on: per member), before ranking." },
        minScore,
        skip: { type: GraphQLInt, description: "Hits to skip, after fusion." },
        rrfK: { type: GraphQLInt, description: "k of reciprocal rank fusion (default 60)." },
      };
      return op === "search"
        ? {
            query: { type: nn(GraphQLString) },
            mode: { type: this.SearchMode },
            indexes: { type: this.memberIndexes(model, "search") },
            ...fusion,
            take: { type: GraphQLInt },
          }
        : {
            vector,
            fields: { type: this.memberIndexes(model, "findSimilar") },
            take: { type: nn(GraphQLInt) },
            ...fusion,
          };
    }
    return op === "search"
      ? {
          index: { type: nn(this.fulltextIndexEnum(model)) },
          query: { type: nn(GraphQLString), description: "The search text (blank: no hits)." },
          mode: { type: this.SearchMode },
          where: { ...where, description: "Filter on the hits, before skip / take." },
          minScore,
          skip: { type: GraphQLInt },
          take: { type: GraphQLInt },
        }
      : {
          field: { type: nn(this.vectorFieldEnum(model)) },
          vector,
          k: { type: nn(GraphQLInt), description: "Number of results, best first." },
          where: { ...where, description: "Filter on the results." },
          minScore,
        };
  }

  // ---------------------------------------------------------------------------
  // Traversals
  // ---------------------------------------------------------------------------

  readonly TraversalDirection = new GraphQLEnumType({
    name: "TraversalDirection",
    description:
      "Arrow direction of each hop, from the node stepped from (default: each relation's declared direction).",
    values: { out: { value: "out" }, in: { value: "in" }, both: { value: "both" } },
  });

  readonly PathDirection = new GraphQLEnumType({
    name: "PathDirection",
    description: "`out`: the edge points from nodes[i] to nodes[i + 1]; `in`: the other way round.",
    values: { out: { value: "out" }, in: { value: "in" } },
  });

  readonly TraverseDepth = new GraphQLInputObjectType({
    name: "TraverseDepth",
    fields: {
      min: { type: GraphQLInt, description: "Fewest hops (default 1; 0 includes the start node)." },
      max: { type: new GraphQLNonNull(GraphQLInt), description: "Most hops." },
    },
  });

  /** `<Model>TraverseRelation`: the readable relations of `model` back to `model`. */
  private traverseRelation(model: ResolvedNodeModel): GraphQLEnumType | undefined {
    const rels = this.api.selfRelations(model);
    if (rels.length === 0) return undefined;
    const name = names.traverseRelation(model.name);
    return this.named(
      name,
      () =>
        new GraphQLEnumType({
          name,
          values: Object.fromEntries(rels.map((r) => [r.name, { value: r.name }])),
        }),
    );
  }

  /** The type of `_edge` on the edges of `model`'s paths (edge models of its self relations). */
  private pathEdgeProperties(model: ResolvedNodeModel): GraphQLOutputType | undefined {
    const edges = [
      ...new Set(
        this.api
          .selfRelations(model)
          .flatMap((r) => (r.edge && this.api.edges.has(r.edge) ? [r.edge] : [])),
      ),
    ].sort();
    if (edges.length === 0) return undefined;
    if (edges.length === 1) return this.edgeObject(edges[0]!);
    const name = names.pathEdgeProperties(model.name);
    return this.named(
      name,
      () =>
        new GraphQLUnionType({
          name,
          types: () => edges.map((e) => this.edgeObject(e)),
          resolveType,
        }),
    );
  }

  /** `<Model>Path`: the nodes and edges of a path between nodes of `model`. */
  pathType(model: ResolvedNodeModel): GraphQLObjectType {
    const name = names.path(model.name);
    return this.named(
      name,
      () =>
        new GraphQLObjectType({
          name,
          description: "edges[i] joins nodes[i] and nodes[i + 1].",
          fields: () => {
            const edgeName = names.pathEdge(model.name);
            const props = this.pathEdgeProperties(model);
            const edge = this.named(
              edgeName,
              () =>
                new GraphQLObjectType({
                  name: edgeName,
                  fields: {
                    type: {
                      type: new GraphQLNonNull(GraphQLString),
                      description: "The relationship type.",
                      resolve: byResponseKey,
                    },
                    direction: {
                      type: new GraphQLNonNull(this.PathDirection),
                      resolve: byResponseKey,
                    },
                    ...(props
                      ? {
                          _edge: {
                            type: props,
                            description:
                              "The edge's properties (null for an edge without a relationship model).",
                            resolve: byResponseKey,
                          },
                        }
                      : {}),
                  },
                }),
            );
            return {
              nodes: {
                type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(this.output(model)))),
                resolve: byResponseKey,
              },
              edges: {
                type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(edge))),
                resolve: byResponseKey,
              },
            };
          },
        }),
    );
  }

  /** `<Model>Traversal`: a reached node and the (shortest) path it was reached by. */
  private traversalType(model: ResolvedNodeModel): GraphQLObjectType {
    const name = names.traversal(model.name);
    return this.named(
      name,
      () =>
        new GraphQLObjectType({
          name,
          fields: () => ({
            node: { type: new GraphQLNonNull(this.output(model)), resolve: byResponseKey },
            path: {
              type: new GraphQLNonNull(this.pathType(model)),
              description:
                "How the node was reached (the shortest such path unless distinct is false). Path nodes carry their scalar fields.",
              resolve: byResponseKey,
            },
          }),
        }),
    );
  }

  /** Root field of `traverse`, `traversePaths` or `shortestPath` on `model`. */
  private traversalField(
    model: ResolvedNodeModel,
    op: "traverse" | "traversePaths" | "shortestPath",
    resolve: GraphQLFieldResolver<unknown, unknown> | undefined,
  ): GraphQLFieldConfig<unknown, unknown> | undefined {
    const via = this.traverseRelation(model);
    if (!via) return undefined;
    const nn = <T extends GraphQLInputType>(t: T) => new GraphQLNonNull(t);
    const where = this.where(model);
    const common: GraphQLFieldConfigArgumentMap = {
      from: { type: nn(where), description: "The start node(s)." },
      via: {
        type: nn(new GraphQLList(nn(via))),
        description: "Relations to follow (any of them on each hop).",
      },
      direction: { type: this.TraversalDirection },
    };
    if (op === "shortestPath") {
      return {
        type: this.pathType(model),
        description:
          "One shortest path from a from node to a to node along via (null when there is none).",
        args: {
          ...common,
          to: { type: nn(where), description: "The end node(s)." },
          maxDepth: { type: nn(GraphQLInt), description: "Longest path searched, in hops." },
          where: { type: where, description: "Filter every intermediate node must match." },
        },
        resolve,
      };
    }
    const order = this.orderBy(model);
    return {
      type: new GraphQLList(
        new GraphQLNonNull(op === "traverse" ? this.output(model) : this.traversalType(model)),
      ),
      description:
        op === "traverse"
          ? "The nodes reached from the from node(s) along via, in depth.min..depth.max hops."
          : "The nodes reached from the from node(s) along via, with the path each was reached by.",
      args: {
        ...common,
        depth: { type: nn(this.TraverseDepth) },
        where: { type: where, description: "Filter on the reached nodes." },
        distinct: {
          type: GraphQLBoolean,
          description: "Each reached node once (default true); false: one result per path.",
        },
        ...(order ? { orderBy: { type: new GraphQLList(nn(order)) } } : {}),
        skip: { type: GraphQLInt },
        take: { type: GraphQLInt },
      },
      resolve,
    };
  }

  /** The GraphQL type of a computed or Cypher-backed field (or argument). */
  private refType(node: TypeNode, input: boolean): GraphQLOutputType & GraphQLInputType {
    if (node.kind === Kind.NON_NULL_TYPE) {
      return new GraphQLNonNull(this.refType(node.type, input)) as never;
    }
    if (node.kind === Kind.LIST_TYPE)
      return new GraphQLList(this.refType(node.type, input)) as never;
    const name = node.name.value;
    const builtin: Record<string, GraphQLScalarType> = {
      String: GraphQLString,
      ID: GraphQLID,
      Int: GraphQLInt,
      Float: GraphQLFloat,
      Boolean: GraphQLBoolean,
      DateTime: DateTimeScalar,
      Date: DateScalar,
      LocalDateTime: LocalDateTimeScalar,
      LocalTime: LocalTimeScalar,
      Time: TimeScalar,
      Duration: DurationScalar,
      BigInt: BigIntScalar,
      Json: JsonScalar,
    };
    if (builtin[name]) return builtin[name] as never;
    const model = this.api.nodes.get(name);
    if (model && !input) return this.output(model) as never;
    return this.enumType(name) as never;
  }

  /** Computed and Cypher-backed fields of `model` (`config.computed`, `config.cypherFields`). */
  private extensionFields(model: ResolvedNodeModel): GraphQLFieldConfigMap<AnyRecord, unknown> {
    const out: GraphQLFieldConfigMap<AnyRecord, unknown> = {};
    const ext = this.api.config.extensions;
    const typeOf = (ref: TypeRef, ruled: boolean): GraphQLOutputType => {
      const t: GraphQLOutputType = this.refType(ref.node, false);
      return ruled ? (getNullableType(t) as GraphQLOutputType) : t;
    };
    for (const [name, def] of ext.computed.get(model.name) ?? []) {
      out[name] = {
        type: typeOf(def.type, def.read !== undefined),
        description: def.description ?? "Computed by the server (cannot be filtered or sorted on).",
        resolve: byResponseKey,
        deprecationReason: def.deprecated,
      };
    }
    for (const [name, def] of ext.cypherFields.get(model.name) ?? []) {
      const args: GraphQLFieldConfigArgumentMap = {};
      for (const [a, spec] of def.args) {
        args[a] = {
          type: this.refType(spec.type.node, true),
          ...(spec.default !== undefined ? { defaultValue: spec.default } : {}),
          ...(spec.description !== undefined ? { description: spec.description } : {}),
        };
      }
      out[name] = {
        type: typeOf(def.type, def.read !== undefined),
        description: def.description,
        args,
        resolve: byResponseKey,
        deprecationReason: def.deprecated,
      };
    }
    return out;
  }

  /** The named traversal fields of `model` (`config.traversals`). */
  private namedTraversalFields(
    model: ResolvedNodeModel,
  ): GraphQLFieldConfigMap<AnyRecord, unknown> {
    const out: GraphQLFieldConfigMap<AnyRecord, unknown> = {};
    for (const [name, t] of this.api.config.traversals.get(model.name) ?? []) {
      const end = this.api.node(t.end);
      const args: GraphQLFieldConfigArgumentMap = {};
      if (t.args.has("where")) args.where = { type: this.where(end) };
      const order = this.orderBy(end);
      if (t.args.has("orderBy") && order)
        args.orderBy = { type: new GraphQLList(new GraphQLNonNull(order)) };
      if (t.args.has("skip")) args.skip = { type: GraphQLInt };
      if (t.args.has("take")) args.take = { type: GraphQLInt };
      out[name] = {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(this.output(end)))),
        description: t.description ?? `The ${end.name} nodes this traversal reaches (each once).`,
        args,
        resolve: byResponseKey,
      };
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Root
  // ---------------------------------------------------------------------------

  private rootField(
    model: ResolvedNodeModel,
    op: RootOperation,
  ): GraphQLFieldConfig<unknown, unknown> | undefined {
    if (isWrite(op)) return this.mutationField(model, op);
    const resolve = this.resolver?.(model, op);
    const where = this.where(model);
    const order = this.orderBy(model);
    const orderArg: GraphQLFieldConfigArgumentMap = order
      ? { orderBy: { type: new GraphQLList(new GraphQLNonNull(order)) } }
      : {};
    const out = this.output(model);
    switch (op) {
      case "findUnique": {
        const unique = this.whereUnique(model);
        if (!unique) return undefined;
        return { type: out, args: { where: { type: new GraphQLNonNull(unique) } }, resolve };
      }
      case "findFirst":
        return {
          type: out,
          args: { where: { type: where }, ...orderArg, skip: { type: GraphQLInt } },
          resolve,
        };
      case "findMany":
        // Root fields are nullable: a failing one is null with its error, the others still return.
        return {
          type: this.listType(model),
          args: {
            where: { type: where },
            ...orderArg,
            skip: { type: GraphQLInt },
            take: { type: GraphQLInt },
            after: {
              type: GraphQLString,
              description: "A cursor (pageInfo.endCursor): the page after it.",
            },
            before: {
              type: GraphQLString,
              description: "A cursor (pageInfo.startCursor): the page before it.",
            },
          },
          resolve,
        };
      case "count":
        return { type: GraphQLInt, args: { where: { type: where } }, resolve };
      case "aggregate":
        return {
          type: this.aggregateType(model),
          description: "Aggregates over the matching nodes (with skip / take: over that window).",
          args: {
            where: { type: where },
            ...orderArg,
            skip: { type: GraphQLInt },
            take: { type: GraphQLInt },
          },
          resolve,
        };
      case "groupBy": {
        const by = this.groupByInput(model);
        if (Object.keys(by.getFields()).length === 0) return undefined;
        return {
          type: new GraphQLList(new GraphQLNonNull(this.groupType(model))),
          description: "Groups of the matching nodes by the fields in by, with their aggregates.",
          args: {
            by: { type: new GraphQLNonNull(by) },
            where: { type: where },
            having: { type: this.having(model) },
            orderBy: { type: new GraphQLList(new GraphQLNonNull(this.groupOrderBy(model))) },
            skip: { type: GraphQLInt },
            take: { type: GraphQLInt },
          },
          resolve,
        };
      }
      case "traverse":
      case "traversePaths":
      case "shortestPath":
        return this.traversalField(model, op, resolve);
      case "search":
      case "findSimilar":
        return {
          type: new GraphQLList(new GraphQLNonNull(out)),
          description:
            op === "search"
              ? model.union
                ? "Full-text search over the members' indexes, merged by reciprocal rank fusion (_score), best first."
                : "Nodes matching a full-text query, best first (_score: the relevance)."
              : model.union
                ? "Nearest neighbours over the members' vector indexes, merged by reciprocal rank fusion (_score), best first."
                : "The k nodes most similar to vector, best first (_score: the similarity).",
          args: this.searchArgs(model, op),
          resolve,
        };
    }
  }

  /** A `Mutation` root field, or `undefined` when the model has nothing it could take. */
  private mutationField(
    model: ResolvedNodeModel,
    op: RootOperation,
  ): GraphQLFieldConfig<unknown, unknown> | undefined {
    const nn = <T extends GraphQLInputType>(t: T) => new GraphQLNonNull(t);
    const list = (t: GraphQLInputType) => nn(new GraphQLList(nn(t)));
    const out = this.output(model);
    const unique = () => this.whereUnique(model);
    let field: GraphQLFieldConfig<unknown, unknown> | undefined;
    switch (op) {
      case "create":
        field = { type: out, args: { data: { type: nn(this.createInput(model)) } } };
        break;
      case "createMany": {
        const data = this.createManyInput(model);
        if (data) field = { type: this.batchType(model), args: { data: { type: list(data) } } };
        break;
      }
      case "update": {
        const [where, data] = [unique(), this.updateInput(model)];
        if (where && data) {
          field = { type: out, args: { where: { type: nn(where) }, data: { type: nn(data) } } };
        }
        break;
      }
      case "updateMany": {
        const data = this.updateManyInput(model);
        if (data) {
          field = {
            type: this.batchType(model),
            args: { where: { type: this.where(model) }, data: { type: nn(data) } },
          };
        }
        break;
      }
      case "upsert": {
        const [where, update] = [unique(), this.updateInput(model)];
        if (where && update) {
          field = {
            type: out,
            args: {
              where: { type: nn(where) },
              create: { type: nn(this.createInput(model)) },
              update: { type: nn(update) },
            },
          };
        }
        break;
      }
      case "delete": {
        const where = unique();
        if (where) field = { type: out, args: { where: { type: nn(where) } } };
        break;
      }
      case "deleteMany":
        field = { type: this.batchType(model), args: { where: { type: this.where(model) } } };
        break;
    }
    // Root fields are nullable: a failing one is null with its error.
    return field && { ...field, resolve: this.resolver?.(model, op) };
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  /** `<Model>Change`: the payload of `<model>Changed`. */
  changeType(model: ResolvedNodeModel): GraphQLObjectType {
    const name = names.change(model.name);
    return this.named(
      name,
      () =>
        new GraphQLObjectType({
          name,
          description: `A change of a ${model.name} node (subscriptions, experimental).`,
          fields: () => ({
            operation: { type: new GraphQLNonNull(this.ChangeOperation), resolve: byResponseKey },
            id: {
              type: new GraphQLNonNull(GraphQLID),
              description:
                "Key of the node (its global id with relay), always present, also for DELETED.",
              resolve: byResponseKey,
            },
            node: {
              type: this.output(model),
              description:
                "The node after the change, re-read with the selection and the read rules. Null for DELETED.",
              resolve: byResponseKey,
            },
            changedFields: {
              type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
              description:
                "Fields whose value changed (UPDATED; empty otherwise). Fields a rule hides from the subscriber are left out.",
              resolve: byResponseKey,
            },
          }),
        }),
    );
  }

  /** `<Model><Relation>Event`: the payload of `<model><Relation>Connected` / `…Disconnected`. */
  relationEventType(model: ResolvedNodeModel, field: ResolvedRelationField): GraphQLObjectType {
    const name = names.relationEvent(model.name, field.name);
    const target = this.api.node(field.target);
    const edge = field.edge && this.api.edges.has(field.edge) ? field.edge : undefined;
    return this.named(
      name,
      () =>
        new GraphQLObjectType({
          name,
          description: `A relationship of ${model.name}.${field.name} created or deleted (subscriptions, experimental).`,
          fields: () => ({
            id: {
              type: new GraphQLNonNull(GraphQLID),
              description: `Key of the ${model.name} (its global id with relay).`,
              resolve: byResponseKey,
            },
            relatedId: {
              type: new GraphQLNonNull(GraphQLID),
              description: `Key of the related ${target.name} (its global id with relay).`,
              resolve: byResponseKey,
            },
            node: {
              type: new GraphQLNonNull(this.output(model)),
              description: `The ${model.name}, re-read with the selection and the read rules.`,
              resolve: byResponseKey,
            },
            related: {
              type: new GraphQLNonNull(this.output(target)),
              description: `The related ${target.name}, re-read with the selection and the read rules.`,
              resolve: byResponseKey,
            },
            ...(edge
              ? {
                  _edge: {
                    type: this.edgeObject(edge),
                    description:
                      "The relationship's properties: after it was created, or before it was deleted.",
                    resolve: byResponseKey,
                  },
                }
              : {}),
          }),
        }),
    );
  }

  /** The `Subscription` root fields (`config.subscriptions`). */
  private subscriptionFields(): GraphQLFieldConfigMap<unknown, unknown> {
    const out: GraphQLFieldConfigMap<unknown, unknown> = {};
    const owners = new Map<string, string>();
    const add = (fieldName: string, owner: string, field: GraphQLFieldConfig<unknown, unknown>) => {
      const other = owners.get(fieldName);
      if (other) {
        throw new NativeSchemaError(
          `Two subscription fields are named "${fieldName}" (${other} and ${owner}); rename one with config.naming or the relation in schema.cyphra.`,
        );
      }
      owners.set(fieldName, owner);
      out[fieldName] = field;
    };
    for (const [modelName, subs] of this.api.config.subscriptions) {
      const model = this.api.node(modelName);
      if (subs.changed) {
        const r = this.subscriptions?.changed(model);
        add(subs.changed, `${model.name}.changed`, {
          type: new GraphQLNonNull(this.changeType(model)),
          description: `Changes of ${model.name} nodes (experimental): created, updated or deleted, by GraphQL or any other writer. Delivered when the subscriber may read the node now (where, read rules).`,
          args: {
            where: { type: this.where(model) },
            operations: {
              type: new GraphQLList(new GraphQLNonNull(this.ChangeOperation)),
              description: "Only these operations (default: all).",
            },
          },
          ...(r ? { subscribe: r.subscribe, resolve: r.resolve } : {}),
        });
      }
      for (const rel of subs.relations) {
        const field = model.fields.find((f) => f.name === rel.field) as ResolvedRelationField;
        const target = this.api.node(field.target);
        for (const op of ["connected", "disconnected"] as const) {
          const fieldName = rel[op];
          if (!fieldName) continue;
          const r = this.subscriptions?.relation(model, field, op);
          add(fieldName, `${model.name}.${field.name} (${op})`, {
            type: new GraphQLNonNull(this.relationEventType(model, field)),
            description: `Relationships of ${model.name}.${field.name} ${op === "connected" ? "created" : "deleted"} (experimental). Delivered when the subscriber may read both nodes now (where, relatedWhere, read rules).`,
            args: {
              where: { type: this.where(model) },
              relatedWhere: { type: this.where(target) },
            },
            ...(r ? { subscribe: r.subscribe, resolve: r.resolve } : {}),
          });
        }
      }
    }
    return out;
  }

  build(): GraphQLSchema {
    const query: GraphQLFieldConfigMap<unknown, unknown> = {};
    const mutation: GraphQLFieldConfigMap<unknown, unknown> = {};
    const owners = new Map<string, string>();
    for (const model of this.api.schema.nodes) {
      const ops = this.api.config.operations.get(model.name);
      for (const [op, fieldName] of ops ?? []) {
        const field = this.rootField(model, op);
        if (!field) continue;
        const root = isWrite(op) ? mutation : query;
        const key = `${isWrite(op) ? "Mutation" : "Query"}.${fieldName}`;
        const other = owners.get(key);
        if (other) {
          throw new NativeSchemaError(
            `Two root fields are named "${fieldName}" (${other} and ${model.name}.${op}); rename one with config.naming.`,
          );
        }
        owners.set(key, `${model.name}.${op}`);
        root[fieldName] = field;
      }
    }
    if (this.api.config.relay) {
      if (query.node) {
        throw new NativeSchemaError(
          'With relay, "node" is the Relay root field; rename the other one with config.naming.',
        );
      }
      query.node = {
        type: this.Node,
        description: "The node with this global id (null when there is none).",
        args: { id: { type: new GraphQLNonNull(GraphQLID) } },
        resolve: this.nodeResolver,
      };
    }
    // Every model type is in the schema, even one only reached through relations.
    const types = this.api.schema.nodes.map((n) => this.output(n));
    if (Object.keys(query).length === 0) {
      throw new NativeSchemaError(
        "The API has no root field: every read operation is turned off (config.models / config.defaults).",
      );
    }
    const subscription = this.subscriptionFields();
    return new GraphQLSchema({
      query: new GraphQLObjectType({ name: "Query", fields: query }),
      ...(Object.keys(mutation).length > 0
        ? { mutation: new GraphQLObjectType({ name: "Mutation", fields: mutation }) }
        : {}),
      ...(Object.keys(subscription).length > 0
        ? { subscription: new GraphQLObjectType({ name: "Subscription", fields: subscription }) }
        : {}),
      types,
    });
  }
}
