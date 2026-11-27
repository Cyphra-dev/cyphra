/**
 * The Cyphra schema model `compat.v7` runs its translated operations on: built from the v7 type
 * definitions (the {@link V7Model}), not from `schema.cyphra`, so every name the engine compiles is
 * the one the v7 statements use.
 *
 * - Each `@node` type is a model with the same name and its v7 labels (all of them are matched).
 * - Each stored attribute is a scalar field named by its **property** (`@alias(property)`), so the
 *   engine reads and writes the same property as v7; the GraphQL name maps to it through
 *   {@link EngineNode.fields}.
 * - Each relationship to another `@node` type is a relation field (named like the GraphQL field,
 *   unless a property already has that name), with an edge model for its
 *   `@relationshipProperties` (properties named by property too). A to-one relationship also gets
 *   a to-many relation over the same edges, for its connection.
 *
 * What the engine cannot represent exactly is left out, and a request that uses it stays on the
 * compat compiler: interfaces (v7 interfaces add no label), unions, relationships to them, and
 * `@cypher` fields.
 *
 * @packageDocumentation
 */

import type {
  ResolvedNodeModel,
  ResolvedRelationField,
  ResolvedRelationshipModel,
  ResolvedScalarField,
  SchemaModel,
} from "@cyphra/schema";
import type { Attribute, NodeType, PropertiesType, Relationship, V7Model } from "../model.js";

/** How one v7 `@node` type maps onto its engine model. */
export type EngineNode = {
  readonly v7: NodeType;
  readonly model: ResolvedNodeModel;
  /** GraphQL attribute name → engine scalar field (its property). Absent: not in the engine. */
  readonly fields: ReadonlyMap<string, string>;
  /** GraphQL relationship name → engine relation field. Absent: not in the engine. */
  readonly relations: ReadonlyMap<string, string>;
  /**
   * GraphQL to-one relationship name → a to-many engine relation over the same edges, for its
   * connection (v7 lists every edge it finds, data may have several).
   */
  readonly allEdges: ReadonlyMap<string, string>;
};

export type EngineSchema = {
  readonly schema: SchemaModel;
  /** The `@node` types the engine serves, by name. */
  readonly nodes: ReadonlyMap<string, EngineNode>;
  /**
   * Per `@relationshipProperties` type: GraphQL attribute name → edge property (as `fields` of
   * {@link EngineNode}), for edge filters and sorts. Absent: not in the engine.
   */
  readonly edgeFields: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

/** Field names the engine gives a meaning in `select` / `where` (never used for a v7 field). */
function reserved(name: string): boolean {
  return name.startsWith("$") || name.startsWith("__") || name === "_count";
}

const SCALAR_TYPES: Record<string, ResolvedScalarField["type"]> = {
  ID: "String",
  String: "String",
  Int: "Int",
  Float: "Float",
  Boolean: "Boolean",
  BigInt: "BigInt",
  Date: "Date",
  DateTime: "DateTime",
};

/** The engine field of a stored v7 attribute, or `undefined` (computed, or not representable). */
function scalarField(attr: Attribute): ResolvedScalarField | undefined {
  if (attr.cypher || attr.variants || reserved(attr.property)) return undefined;
  // Enums are compared and stored as strings; the GraphQL schema already checks their values.
  const type = attr.kind === "enum" ? "String" : SCALAR_TYPES[attr.type.name];
  if (!type) return undefined;
  return {
    kind: "scalar",
    name: attr.property,
    type,
    // Every property may be absent: v7 checks required inputs, and `set: null` removes one.
    optional: true,
    list: attr.type.list,
    id: false,
    unique: false,
    index: false,
  };
}

/** The stored properties of a `@relationshipProperties` type, by property name (deduplicated). */
function edgeProperties(props: PropertiesType): ResolvedScalarField[] {
  const out = new Map<string, ResolvedScalarField>();
  for (const a of props.attributes) {
    const f = scalarField(a);
    if (f && !out.has(f.name)) out.set(f.name, f);
  }
  return [...out.values()];
}

/** GraphQL attribute → edge property, for the attributes stored like {@link edgeProperties}. */
function edgeFieldNames(props: PropertiesType): Map<string, string> {
  const fields = new Map(edgeProperties(props).map((f) => [f.name, f]));
  const out = new Map<string, string>();
  for (const a of props.attributes) {
    const f = scalarField(a);
    const known = f && fields.get(f.name);
    if (f && known && known.type === f.type && known.list === f.list) out.set(a.name, f.name);
  }
  return out;
}

/** Whether a relationship's target is a plain `@node` type (not an interface or a union). */
function plainTarget(model: V7Model, rel: Relationship): boolean {
  return (
    !model.unions.has(rel.target) &&
    !model.interfaces.has(rel.target) &&
    model.nodes.some((n) => n.name === rel.target)
  );
}

/** Build the engine schema of the v7 model (see the module comment). */
export function engineSchema(model: V7Model): EngineSchema {
  const nodes: ResolvedNodeModel[] = [];
  const relationships: ResolvedRelationshipModel[] = [];
  const mapped = new Map<string, EngineNode>();
  for (const node of model.nodes) {
    // A model name the engine reserves for its own client members cannot be one of its delegates.
    if (node.name.startsWith("$") || node.labels.length === 0) continue;
    const fields: ResolvedScalarField[] = [];
    const byProperty = new Map<string, ResolvedScalarField>();
    const fieldNames = new Map<string, string>();
    for (const attr of node.attributes) {
      const f = scalarField(attr);
      if (!f) continue;
      const known = byProperty.get(f.name);
      // Two GraphQL fields stored in one property: one engine field, if they agree on its type.
      if (known && (known.type !== f.type || known.list !== f.list)) continue;
      if (!known) {
        byProperty.set(f.name, f);
        fields.push(f);
      }
      fieldNames.set(attr.name, f.name);
    }
    const relations: ResolvedRelationField[] = [];
    const relationNames = new Map<string, string>();
    const allEdges = new Map<string, string>();
    const taken = new Set(fields.map((f) => f.name));
    for (const rel of node.relationships) {
      if (!plainTarget(model, rel)) continue;
      let name = rel.name;
      for (let i = 1; taken.has(name) || reserved(name); i++) name = `${rel.name}_rel${i}`;
      taken.add(name);
      let edge: string | undefined;
      const props = rel.properties ? model.properties.get(rel.properties) : undefined;
      if (props) {
        // One edge model per relationship field: the engine reads its properties by name.
        edge = `${node.name}.${rel.name}`;
        relationships.push({
          name: edge,
          relType: rel.type,
          from: rel.direction === "OUT" ? node.name : rel.target,
          to: rel.direction === "OUT" ? rel.target : node.name,
          properties: edgeProperties(props),
        });
      }
      relations.push({
        kind: "relation",
        name,
        target: rel.target,
        relType: rel.type,
        direction: rel.direction,
        many: rel.list,
        optional: !rel.required,
        ...(edge ? { edge } : {}),
      });
      relationNames.set(rel.name, name);
      if (!rel.list) {
        let all = `${rel.name}_all`;
        for (let i = 1; taken.has(all) || reserved(all); i++) all = `${rel.name}_all${i}`;
        taken.add(all);
        relations.push({
          kind: "relation",
          name: all,
          target: rel.target,
          relType: rel.type,
          direction: rel.direction,
          many: true,
          optional: true,
          ...(edge ? { edge } : {}),
        });
        allEdges.set(rel.name, all);
      }
    }
    const resolved: ResolvedNodeModel = {
      name: node.name,
      label: node.labels[0]!,
      ...(node.labels.length > 1 ? { labels: node.labels } : {}),
      uniqueFields: [],
      fields: [...fields, ...relations],
    };
    nodes.push(resolved);
    mapped.set(node.name, {
      v7: node,
      model: resolved,
      fields: fieldNames,
      relations: relationNames,
      allEdges,
    });
  }
  return {
    schema: { version: 1, nodes, relationships },
    nodes: mapped,
    edgeFields: new Map([...model.properties.values()].map((p) => [p.name, edgeFieldNames(p)])),
  };
}
