/**
 * Builds the native API's `GraphQLSchema` from the {@link ApiModel}: object, interface and union
 * types per model, `<Model>Where` / `<Model>WhereUnique` / `<Model>OrderBy` inputs, shared
 * filters per scalar type, `<Model>List` results and the `Query` root fields.
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
} from "graphql";
import type { ResolvedNodeModel, ResolvedRelationField, ResolvedScalarField } from "@cyphra/schema";
import type { ApiModel } from "./api.js";
import { NativeSchemaError, isWrite, type RootOperation } from "./config.js";
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

type AnyRecord = Record<string | symbol, unknown>;

/** Resolver of a field of a shaped object: the value under the field's response key. */
const byResponseKey: GraphQLFieldResolver<AnyRecord, unknown> = (src, _args, _ctx, info) =>
  src[info.path.key];

const resolveType = (value: unknown): string | undefined =>
  (value as AnyRecord | null)?.[TYPE] as string | undefined;

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
};

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

  constructor(
    private readonly api: ApiModel,
    private readonly resolver?: RootResolver,
    private readonly nodeResolver?: GraphQLFieldResolver<unknown, unknown>,
  ) {
    this.modelNames = new Set([
      ...api.schema.nodes.map((n) => n.name),
      ...(api.schema.enums ?? []).map((e) => e.name),
      ...api.edges.keys(),
    ]);
  }

  /** A generated type, created once; its name must not be a model's, an enum's or an edge's. */
  private named<T extends GraphQLNamedType>(name: string, create: () => T, own = false): T {
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

  /** `<Model>UpdateInput`: new values (`null` removes the property), `_ops`, relation writes. */
  updateInput(model: ResolvedNodeModel): GraphQLInputObjectType | undefined {
    const scalars = this.updateScalars(model);
    const relations = this.api
      .writeFields(model, "update")
      .filter((f): f is ResolvedRelationField => f.kind === "relation")
      .map((f) => [f.name, this.relationInput(this.relationSide(model, f), "update")] as const)
      .filter((e): e is readonly [string, GraphQLInputObjectType] => e[1] !== undefined);
    if (Object.keys(scalars).length === 0 && relations.length === 0) return undefined;
    const name = names.update(model.name);
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
    if (!create && !connect) return undefined;
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
            return fields;
          },
        }),
    );
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
      if (f.kind === "scalar") {
        fields[this.api.outputName(model, f.name)] = {
          type: this.scalarOutput(f),
          resolve: byResponseKey,
          deprecationReason,
        };
        continue;
      }
      const target = this.api.node(f.target);
      const t = this.output(target);
      fields[f.name] = f.many
        ? {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(t))),
            args: this.listArgs(target),
            resolve: byResponseKey,
            deprecationReason,
          }
        : { type: t, resolve: byResponseKey, deprecationReason };
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
    return new GraphQLSchema({
      query: new GraphQLObjectType({ name: "Query", fields: query }),
      ...(Object.keys(mutation).length > 0
        ? { mutation: new GraphQLObjectType({ name: "Mutation", fields: mutation }) }
        : {}),
      types,
    });
  }
}
