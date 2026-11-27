/**
 * What the native API exposes of a schema model once the config is applied: visible fields, their
 * GraphQL names and types, edge models per node, and the checks `makeSchema` runs at startup.
 *
 * @packageDocumentation
 */

import type {
  ResolvedField,
  ResolvedNodeModel,
  ResolvedRelationField,
  ResolvedRelationshipModel,
  ResolvedScalarField,
  SchemaModel,
} from "@cyphra/schema";
import {
  CREATE_OPERATIONS,
  NativeSchemaError,
  WRITE_OPERATIONS,
  type ResolvedConfig,
  type RootOperation,
} from "./config.js";

/** Field names the API uses for its own fields and inputs (`$edge` → `_edge`, …). */
export const RESERVED_FIELDS = [
  "_edge",
  "_score",
  "_scores",
  "_labels",
  "_count",
  "_ops",
  "_on",
  "_typename",
] as const;

/** Output name of a model's own `id` field when Relay global ids take `id`. */
export const RAW_ID = "rawId";

/** `_sum` / `_avg` take these field types. */
export const NUMERIC_TYPES = new Set(["Int", "Float", "BigInt"]);

/** `_min` / `_max` take these field types (the client's `MinMaxKeys`). */
export const ORDERABLE_TYPES = new Set([
  "Int",
  "Float",
  "BigInt",
  "String",
  "Enum",
  "DateTime",
  "Date",
  "LocalDateTime",
  "LocalTime",
  "Time",
]);

/** Field types `groupBy` cannot group on. */
const UNGROUPABLE_TYPES = new Set(["Vector", "Json", "Point", "CartesianPoint"]);

/** Scalar types that cannot be sorted on (points sort by distance instead). */
const UNSORTABLE = new Set(["Vector", "Json", "Duration"]);

/** Types every native schema may contain: models, enums and edges cannot take these names. */
const FIXED_TYPES = [
  "Query",
  "Mutation",
  "Subscription",
  "ChangeOperation",
  "PageInfo",
  "SortOrder",
  "QueryMode",
  "LabelsFilter",
  "Node",
  "ID",
  "String",
  "Int",
  "Float",
  "Boolean",
  "DateTime",
  "Date",
  "LocalDateTime",
  "LocalTime",
  "Time",
  "Duration",
  "BigInt",
  "Json",
  "Point",
  "CartesianPoint",
  "PointInput",
  "CartesianPointInput",
];

const NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** The schema model with the config applied. */
export class ApiModel {
  readonly nodes: ReadonlyMap<string, ResolvedNodeModel>;
  readonly edges: ReadonlyMap<string, ResolvedRelationshipModel>;
  /** Edge models a node can be reached through, per node (see {@link ApiModel.edgeModels}). */
  private readonly edgeSets = new Map<string, readonly string[]>();
  /** Name of each node's interface family (its first interface by name, or itself). */
  private readonly families = new Map<string, string>();

  constructor(
    readonly schema: SchemaModel,
    readonly config: ResolvedConfig,
  ) {
    this.nodes = new Map(schema.nodes.map((n) => [n.name, n]));
    this.edges = new Map(
      schema.relationships.filter((r) => r.properties.length > 0).map((r) => [r.name, r]),
    );
    this.check();
    this.computeEdgeSets();
    for (const n of schema.nodes) {
      if (this.relayKey(n) && n.fields.some((f) => f.name === RAW_ID)) {
        throw new NativeSchemaError(
          `${n.name}.${RAW_ID}: with relay, a model's id field is returned as "${RAW_ID}"; rename this field in schema.cyphra.`,
        );
      }
    }
    this.checkCreatable();
  }

  /** Whether `op` is a root field of `model`. */
  has(model: ResolvedNodeModel, op: RootOperation): boolean {
    return this.config.operations.get(model.name)?.has(op) ?? false;
  }

  /** Whether the API creates nodes of `model` (its `create` operation, also used by nested creates). */
  creatable(model: ResolvedNodeModel): boolean {
    return !model.abstract && this.has(model, "create");
  }

  /** Whether any write operation of `model` is on. */
  writable(model: ResolvedNodeModel): boolean {
    return WRITE_OPERATIONS.some((op) => this.has(model, op));
  }

  /** The fields of `model` a create (or an update) may set, in declaration order. */
  writeFields(model: ResolvedNodeModel, mode: "create" | "update"): ResolvedField[] {
    if (model.union) return [];
    return model.fields.filter((f) => this.config.field(model.name, f.name)[mode]);
  }

  /**
   * The relation field on the target side of `f` (same type, opposite direction), the one a
   * nested create through `f` must not set: `Post.author` for `User.posts`.
   */
  inverse(owner: ResolvedNodeModel, f: ResolvedRelationField): ResolvedRelationField | undefined {
    const target = this.node(f.target);
    if (target.union) return undefined;
    return target.fields.find(
      (x): x is ResolvedRelationField =>
        x.kind === "relation" &&
        x.relType === f.relType &&
        x.direction !== f.direction &&
        (x.target === owner.name || (owner.interfaces ?? []).includes(x.target)),
    );
  }

  /** A model that creates nodes must let every required field without a default be set. */
  private checkCreatable(): void {
    for (const n of this.schema.nodes) {
      if (n.abstract || !CREATE_OPERATIONS.some((op) => this.has(n, op))) continue;
      for (const f of n.fields) {
        if (f.kind !== "scalar" || f.optional || f.list || f.default) continue;
        if (this.config.field(n.name, f.name).create) continue;
        throw new NativeSchemaError(
          `${n.name}.${f.name} is required, has no default and cannot be set by create (config.models.${n.name}.fields.${f.name}); turn create off for ${n.name} or let the field be created.`,
        );
      }
    }
  }

  node(name: string): ResolvedNodeModel {
    const n = this.nodes.get(name);
    if (!n) throw new NativeSchemaError(`Unknown model "${name}".`);
    return n;
  }

  /** The fields of `model` the API exposes (readable), in declaration order. */
  fields(model: ResolvedNodeModel): ResolvedField[] {
    if (model.union) return [];
    return model.fields.filter((f) => this.config.field(model.name, f.name).read);
  }

  scalars(model: ResolvedNodeModel): ResolvedScalarField[] {
    return this.fields(model).filter((f): f is ResolvedScalarField => f.kind === "scalar");
  }

  relations(model: ResolvedNodeModel): ResolvedRelationField[] {
    return this.fields(model).filter((f): f is ResolvedRelationField => f.kind === "relation");
  }

  /** Readable relations of `model` back to `model` (what `traverse` / `shortestPath` follow). */
  selfRelations(model: ResolvedNodeModel): ResolvedRelationField[] {
    if (model.abstract) return [];
    return this.relations(model).filter((f) => f.target === model.name);
  }

  /** To-many relations: what `_count` counts. */
  counted(model: ResolvedNodeModel): ResolvedRelationField[] {
    return this.relations(model).filter((f) => f.many);
  }

  filterable(model: ResolvedNodeModel, f: ResolvedField): boolean {
    if (!this.config.field(model.name, f.name).filter) return false;
    return !(f.kind === "scalar" && f.type === "Vector");
  }

  sortable(model: ResolvedNodeModel, f: ResolvedField): boolean {
    if (!this.config.field(model.name, f.name).sort) return false;
    if (f.kind === "relation") return true;
    return !f.list && !UNSORTABLE.has(f.type);
  }

  /** Scalars of `model` a to-one relation can sort by (no points, lists or unsortable types). */
  sortableScalars(model: ResolvedNodeModel): ResolvedScalarField[] {
    return this.scalars(model).filter(
      (f) => this.sortable(model, f) && f.type !== "Point" && f.type !== "CartesianPoint",
    );
  }

  /** Readable scalars `_sum` / `_avg` take (`Int`, `Float`, `BigInt`). */
  numericFields(model: ResolvedNodeModel): ResolvedScalarField[] {
    return this.scalars(model).filter((f) => !f.list && NUMERIC_TYPES.has(f.type));
  }

  /** Readable scalars `_min` / `_max` take (numbers, strings, enums, ordered temporals). */
  orderableFields(model: ResolvedNodeModel): ResolvedScalarField[] {
    return this.scalars(model).filter((f) => !f.list && ORDERABLE_TYPES.has(f.type));
  }

  /** Readable scalars `groupBy` can group on (no lists, vectors, points or JSON). */
  groupFields(model: ResolvedNodeModel): ResolvedScalarField[] {
    if (model.union) return [];
    return this.scalars(model).filter((f) => !f.list && !UNGROUPABLE_TYPES.has(f.type));
  }

  /** To-one relations whose target's fields `groupBy` can group on (`by: { author: [name] }`). */
  groupRelations(model: ResolvedNodeModel): ResolvedRelationField[] {
    return this.relations(model).filter(
      (f) => !f.many && this.groupFields(this.node(f.target)).length > 0,
    );
  }

  /**
   * Whether `model`'s type has `_score`: it comes out of a `search` / `findSimilar` root field (its
   * own, an interface's, or a union's it is a member of).
   */
  scored(model: ResolvedNodeModel): boolean {
    const searched = (m: ResolvedNodeModel) => this.has(m, "search") || this.has(m, "findSimilar");
    if (searched(model)) return true;
    if ((model.interfaces ?? []).some((i) => this.scored(this.node(i)))) return true;
    return this.fused(model);
  }

  /** Whether `model`'s type has `_scores`: it is a member of a union searched by the API. */
  fused(model: ResolvedNodeModel): boolean {
    if (model.abstract) return false;
    return this.schema.nodes.some(
      (u) =>
        u.union === true &&
        (u.implementations ?? []).includes(model.name) &&
        (this.has(u, "search") || this.has(u, "findSimilar")),
    );
  }

  /**
   * The key field behind a Relay global id: the `@id` field of a node or an interface, when
   * `relay` is on and it is a `String`, `Int` or `BigInt` (absent otherwise).
   */
  relayKey(model: ResolvedNodeModel): ResolvedScalarField | undefined {
    if (!this.config.relay || model.union) return undefined;
    if (model.abstract && !this.isGraphQLInterface(model)) return undefined;
    const f = model.fields.find((x) => x.name === model.idField);
    if (f?.kind !== "scalar" || f.list) return undefined;
    return f.type === "String" || f.type === "Int" || f.type === "BigInt" ? f : undefined;
  }

  /**
   * The GraphQL name of a model field in output types: with Relay, a field named `id` is returned
   * as `rawId` (`id` is the global id).
   */
  outputName(model: ResolvedNodeModel, field: string): string {
    return field === "id" && this.relayKey(model) ? RAW_ID : field;
  }

  /** The model field behind a GraphQL output field name (the reverse of {@link outputName}). */
  fieldOfOutput(model: ResolvedNodeModel, name: string): string {
    return name === RAW_ID && this.relayKey(model) ? "id" : name;
  }

  /** Concrete node models of an abstract model (an interface or a union), or the model itself. */
  concrete(model: ResolvedNodeModel): ResolvedNodeModel[] {
    if (!model.abstract) return [model];
    return (model.implementations ?? []).map((i) => this.node(i)).filter((n) => !n.abstract);
  }

  /**
   * Whether an interface is served as a GraphQL interface. An interface without any field the API
   * exposes (`interface Archivable {}`) is served as a union of its implementations instead:
   * GraphQL interfaces need at least one field.
   */
  isGraphQLInterface(model: ResolvedNodeModel): boolean {
    if (!model.abstract || model.union) return false;
    return this.fields(model).length > 0 || this.edgeModels(model).length > 0;
  }

  /** Interfaces `model` implements in GraphQL (every one, transitively, as GraphQL wants). */
  graphQLInterfaces(model: ResolvedNodeModel): ResolvedNodeModel[] {
    return (model.interfaces ?? [])
      .map((i) => this.node(i))
      .filter((i) => this.isGraphQLInterface(i));
  }

  /**
   * Edge models (with properties) of the relations through which nodes of `model` can be reached,
   * shared by a whole interface family (an interface and its implementations have the same
   * `_edge` type, as GraphQL requires), sorted by name.
   */
  edgeModels(model: ResolvedNodeModel): readonly string[] {
    return this.edgeSets.get(model.name) ?? [];
  }

  /** Name of the interface family of `model`: its `_edge` union is `<family>Edge`. */
  edgeFamily(model: ResolvedNodeModel): string {
    return this.families.get(model.name) ?? model.name;
  }

  private computeEdgeSets(): void {
    // Union-find over interface families.
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let p = parent.get(x) ?? x;
      while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
      return p;
    };
    const join = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const n of this.schema.nodes) {
      if (n.union) continue;
      for (const i of n.interfaces ?? []) join(n.name, i);
    }
    const byRoot = new Map<string, Set<string>>();
    const add = (node: string, edge: string) => {
      const r = find(node);
      if (!byRoot.has(r)) byRoot.set(r, new Set());
      byRoot.get(r)!.add(edge);
    };
    for (const n of this.schema.nodes) {
      for (const f of this.relations(n)) {
        if (!f.edge || !this.edges.has(f.edge)) continue;
        const target = this.node(f.target);
        if (target.union) for (const m of this.concrete(target)) add(m.name, f.edge);
        else add(target.name, f.edge);
      }
    }
    const familyName = new Map<string, string>();
    for (const n of this.schema.nodes) {
      if (n.union) continue;
      const r = find(n.name);
      const current = familyName.get(r);
      if (
        n.abstract &&
        (current === undefined || !this.nodes.get(current)?.abstract || n.name < current)
      )
        familyName.set(r, n.name);
      else if (current === undefined) familyName.set(r, n.name);
    }
    for (const n of this.schema.nodes) {
      if (n.union) continue;
      const set = byRoot.get(find(n.name));
      if (set) this.edgeSets.set(n.name, [...set].sort());
      this.families.set(n.name, familyName.get(find(n.name)) ?? n.name);
    }
  }

  /** Startup checks: names GraphQL cannot serve, reserved names. */
  private check(): void {
    const taken = new Set(FIXED_TYPES);
    for (const n of [
      ...this.schema.nodes.map((x) => x.name),
      ...(this.schema.enums ?? []).map((x) => x.name),
      ...this.schema.relationships.map((x) => x.name),
    ]) {
      if (taken.has(n)) {
        throw new NativeSchemaError(
          `"${n}" is the name of a type of the native GraphQL API (${FIXED_TYPES.join(", ")}); rename it in schema.cyphra.`,
        );
      }
    }
    for (const n of this.schema.nodes) {
      if (!NAME.test(n.name) || n.name.startsWith("__")) {
        throw new NativeSchemaError(`Model name "${n.name}" is not a valid GraphQL type name.`);
      }
      for (const f of n.fields) {
        if (f.name.startsWith("__")) {
          throw new NativeSchemaError(
            `${n.name}.${f.name}: GraphQL names cannot start with "__"; rename the field in schema.cyphra.`,
          );
        }
        if ((RESERVED_FIELDS as readonly string[]).includes(f.name)) {
          throw new NativeSchemaError(
            `${n.name}.${f.name}: "${f.name}" is reserved by the native GraphQL API (${RESERVED_FIELDS.join(", ")}); rename the field in schema.cyphra.`,
          );
        }
      }
    }
    for (const e of this.schema.enums ?? []) {
      for (const v of e.values) {
        if (!NAME.test(v) || v === "true" || v === "false" || v === "null") {
          throw new NativeSchemaError(
            `enum ${e.name}: value "${v}" is not a valid GraphQL enum value.`,
          );
        }
      }
    }
  }
}
