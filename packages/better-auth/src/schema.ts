/**
 * Derives a Cyphra schema from Better Auth's database schema (core models plus plugins).
 *
 * - Each Better Auth model becomes a node named after its database model name in PascalCase
 *   (`user` → `User`, `user_custom` → `UserCustom`).
 * - A field with `references` (a foreign key such as `Session.userId`) is not stored as a
 *   property. It becomes an edge `(User)-[:HAS_SESSION]->(Session)`, a to-one relation field on
 *   the child (`user`) and a list field on the parent (`sessions`).
 *
 * @packageDocumentation
 */

import type { BetterAuthDBSchema, DBFieldAttribute } from "better-auth/db";
import {
  resolveSchema,
  type Decorator,
  type NodeDeclaration,
  type NodeField,
  type ScalarNodeField,
  type ScalarTypeName,
  type SchemaDocument,
  type SchemaModel,
} from "@cyphra/schema";
import {
  assertIdentifier,
  edgeType,
  lowerFirst,
  pascalCase,
  plural,
  relationFieldName,
} from "./naming.js";

/** Mapping functions Better Auth provides to adapters (`getModelName`, `getFieldName`). */
export interface SchemaNaming {
  schema: BetterAuthDBSchema;
  /** Schema key (or custom model name) → database model name. */
  getModelName: (model: string) => string;
  /** Schema field → database field name. */
  getFieldName: (args: { model: string; field: string }) => string;
}

export type OnDelete = "no action" | "restrict" | "cascade" | "set null" | "set default";

export interface ScalarMapping {
  readonly kind: "scalar";
  /** Database field name (the property key on the node). */
  readonly name: string;
  readonly type: ScalarTypeName;
  readonly list: boolean;
  /** Better Auth's `unique` / `index` flags. */
  readonly unique: boolean;
  readonly index: boolean;
}

export interface ForeignKeyMapping {
  readonly kind: "fk";
  /** Database field name Better Auth reads and writes, e.g. `userId`. */
  readonly name: string;
  /** To-one relation field on the child node, e.g. `user`. */
  readonly relation: string;
  /** Schema key of the referenced model, e.g. `user`. */
  readonly parentKey: string;
  /** Database field name of the referenced field on the parent (usually `id`). */
  readonly refField: string;
  readonly relType: string;
  /** List relation field on the parent node, e.g. `sessions`. */
  readonly inverse: string;
  readonly onDelete: OnDelete;
  readonly unique: boolean;
  readonly index: boolean;
  readonly required: boolean;
}

export type FieldMapping = ScalarMapping | ForeignKeyMapping;

export interface ModelMapping {
  /** Better Auth schema key, e.g. `user`. */
  readonly key: string;
  /** Database model name, e.g. `user` or `users` with `usePlural`. */
  readonly dbName: string;
  /** Cyphra node name and Neo4j label, e.g. `User`. */
  readonly node: string;
  /** ORM delegate key, e.g. `user` or `twoFactor`. */
  readonly delegate: string;
  /** Database name of the id field. */
  readonly idField: string;
  /** Every Better Auth field by database name (the id included, as a scalar). */
  readonly fields: ReadonlyMap<string, FieldMapping>;
  readonly foreignKeys: readonly ForeignKeyMapping[];
}

export interface AuthGraph {
  /** By Better Auth schema key. */
  readonly models: ReadonlyMap<string, ModelMapping>;
  /** The auth nodes as a `.cyphra` document (used by `createSchema`). */
  readonly document: SchemaDocument;
  /** The resolved model the ORM runtime runs on. */
  readonly schema: SchemaModel;
}

function scalarType(attr: DBFieldAttribute): { type: ScalarTypeName; list: boolean } {
  const t = attr.type;
  if (Array.isArray(t)) return { type: "String", list: false }; // enum of string literals
  switch (t) {
    // `supportsJSON: false`: Better Auth stringifies JSON itself, so it stays a String (not Json).
    case "string":
    case "json":
      return { type: "String", list: false };
    // Also with `bigint: true`: a Neo4j INTEGER is always 64-bit, and Better Auth reads and writes
    // these fields as JS numbers, which a Cyphra `BigInt` (a JS bigint) would not give it.
    case "number":
      return { type: "Int", list: false };
    case "boolean":
      return { type: "Boolean", list: false };
    case "date":
      return { type: "DateTime", list: false };
    case "string[]":
      return { type: "String", list: true };
    case "number[]":
      return { type: "Int", list: true };
    default:
      throw new Error(`@cyphra/better-auth: unsupported field type ${JSON.stringify(t)}.`);
  }
}

const dec = (name: string, args: Decorator["args"] = []): Decorator => ({ name, args });

function relationDecorator(relType: string, direction: "IN" | "OUT"): Decorator {
  return dec("relationship", [
    { key: "type", value: { kind: "string", value: relType } },
    { key: "direction", value: { kind: "identifier", value: direction } },
  ]);
}

function resolveModelKey(schema: BetterAuthDBSchema, model: string): string {
  if (schema[model]) return model;
  const found = Object.entries(schema).find(([, t]) => t.modelName === model);
  if (!found) throw new Error(`@cyphra/better-auth: unknown referenced model "${model}".`);
  return found[0];
}

type PendingFk = {
  childKey: string;
  name: string;
  attr: DBFieldAttribute;
  parentKey: string;
};

/**
 * Build the auth graph (node mappings, `.cyphra` document and resolved schema model) for a
 * Better Auth configuration.
 */
export function deriveAuthGraph(naming: SchemaNaming): AuthGraph {
  const { schema, getModelName, getFieldName } = naming;
  const keys = Object.keys(schema).sort(
    (a, b) => (schema[a]!.order ?? Infinity) - (schema[b]!.order ?? Infinity),
  );

  const nodeOf = new Map<string, string>();
  for (const key of keys) {
    const node = assertIdentifier(pascalCase(getModelName(key)), "model name");
    if ([...nodeOf.values()].includes(node)) {
      throw new Error(`@cyphra/better-auth: two models map to the node name "${node}".`);
    }
    nodeOf.set(key, node);
  }

  // Pass 1: scalar fields and the list of foreign keys.
  const fieldsOf = new Map<string, { field: NodeField; fk?: PendingFk }[]>();
  const mappingsOf = new Map<string, Map<string, FieldMapping>>();
  const pending: PendingFk[] = [];
  for (const key of keys) {
    const idField = assertIdentifier(getFieldName({ model: key, field: "id" }), "field name");
    const fields: { field: NodeField; fk?: PendingFk }[] = [
      {
        field: {
          kind: "Scalar",
          name: idField,
          type: { name: "String", optional: false },
          decorators: [
            dec("id"),
            dec("default", [{ key: "fn", value: { kind: "identifier", value: "cuid" } }]),
          ],
        },
      },
    ];
    const mappings = new Map<string, FieldMapping>([
      [
        idField,
        { kind: "scalar", name: idField, type: "String", list: false, unique: true, index: false },
      ],
    ]);
    for (const [fieldKey, attr] of Object.entries(schema[key]!.fields)) {
      if (fieldKey === "id") continue;
      const name = assertIdentifier(getFieldName({ model: key, field: fieldKey }), "field name");
      if (attr.references) {
        const fk = {
          childKey: key,
          name,
          attr,
          parentKey: resolveModelKey(schema, attr.references.model),
        };
        pending.push(fk);
        fields.push({ field: null as unknown as NodeField, fk });
        continue;
      }
      const { type, list } = scalarType(attr);
      const decorators: Decorator[] = [];
      if (attr.unique && !list) decorators.push(dec("unique"));
      else if (attr.index && !list) decorators.push(dec("index"));
      const field: ScalarNodeField = {
        kind: "Scalar",
        name,
        type: {
          name: type,
          optional: list ? false : attr.required !== true,
          ...(list ? { list } : {}),
        },
        decorators,
      };
      fields.push({ field });
      mappings.set(name, {
        kind: "scalar",
        name,
        type,
        list,
        unique: attr.unique === true,
        index: attr.index === true,
      });
    }
    fieldsOf.set(key, fields);
    mappingsOf.set(key, mappings);
  }

  // Pass 2: foreign keys become relation fields on both ends.
  const taken = new Map<string, Set<string>>();
  for (const key of keys) {
    taken.set(
      key,
      new Set([
        ...mappingsOf.get(key)!.keys(),
        ...pending.filter((p) => p.childKey === key).map((p) => p.name),
      ]),
    );
  }
  const inverseFields = new Map<string, NodeField[]>(keys.map((k) => [k, []]));
  const foreignKeysOf = new Map<string, ForeignKeyMapping[]>(keys.map((k) => [k, []]));

  for (const fk of pending) {
    const childNode = nodeOf.get(fk.childKey)!;
    const childTaken = taken.get(fk.childKey)!;
    const siblings = pending.filter(
      (p) => p.childKey === fk.childKey && p.parentKey === fk.parentKey,
    );

    let relation = relationFieldName(fk.name);
    if (relation !== fk.name && childTaken.has(relation)) relation = fk.name;
    childTaken.delete(fk.name);
    childTaken.add(relation);

    const relType = siblings.length > 1 ? edgeType(childNode, relation) : edgeType(childNode);

    const parentTaken = taken.get(fk.parentKey)!;
    const base =
      siblings.length > 1
        ? `${relation}${pascalCase(plural(childNode))}`
        : plural(lowerFirst(childNode));
    let inverse = base;
    for (let i = 2; parentTaken.has(inverse); i++) inverse = `${base}${i}`;
    parentTaken.add(inverse);

    const required = fk.attr.required === true;
    const refField = getFieldName({ model: fk.parentKey, field: fk.attr.references!.field });
    const mapping: ForeignKeyMapping = {
      kind: "fk",
      name: fk.name,
      relation,
      parentKey: fk.parentKey,
      refField,
      relType,
      inverse,
      onDelete: fk.attr.references!.onDelete ?? "cascade",
      unique: fk.attr.unique === true,
      index: fk.attr.index === true,
      required,
    };
    mappingsOf.get(fk.childKey)!.set(fk.name, mapping);
    foreignKeysOf.get(fk.childKey)!.push(mapping);

    const slot = fieldsOf.get(fk.childKey)!.find((f) => f.fk === fk)!;
    slot.field = {
      kind: "Relational",
      name: relation,
      target: nodeOf.get(fk.parentKey)!,
      cardinality: "one",
      optional: !required,
      decorators: [relationDecorator(relType, "IN")],
    };
    inverseFields.get(fk.parentKey)!.push({
      kind: "Relational",
      name: inverse,
      target: childNode,
      cardinality: "many",
      optional: false,
      decorators: [relationDecorator(relType, "OUT")],
    });
  }

  const declarations: NodeDeclaration[] = keys.map((key) => ({
    kind: "Node",
    name: nodeOf.get(key)!,
    fields: [...fieldsOf.get(key)!.map((f) => f.field), ...inverseFields.get(key)!],
  }));
  const document: SchemaDocument = { kind: "Document", declarations };

  const models = new Map<string, ModelMapping>();
  for (const key of keys) {
    const node = nodeOf.get(key)!;
    models.set(key, {
      key,
      dbName: getModelName(key),
      node,
      delegate: lowerFirst(node),
      idField: getFieldName({ model: key, field: "id" }),
      fields: mappingsOf.get(key)!,
      foreignKeys: foreignKeysOf.get(key)!,
    });
  }
  return { models, document, schema: resolveSchema(document) };
}
