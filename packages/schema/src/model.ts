/**
 * Resolved schema model: the normalized, JSON-serializable form of a `.cyphra` schema.
 *
 * The parser produces a surface-level AST ({@link SchemaDocument}); {@link resolveSchema} turns it into
 * a {@link SchemaModel} with relations linked, defaults typed, and cross-references checked. Everything
 * downstream — the generated typed client, the ORM runtime, and schema-diff migrations — reads this
 * model, never the AST.
 *
 * @packageDocumentation
 */

import type {
  Decorator,
  DecoratorValue,
  ScalarNodeField,
  ScalarTypeName,
  SchemaDocument,
} from "./ast.js";
import { SchemaValidationError } from "./errors.js";

/** Bump when the shape of {@link SchemaModel} changes incompatibly. */
export const SCHEMA_MODEL_VERSION = 1 as const;

/** Built-in generator functions accepted by `@default(fn())`. */
export type DefaultFunction = "cuid" | "uuid" | "now";

export type DefaultValueSpec =
  | { readonly kind: "fn"; readonly fn: DefaultFunction }
  | { readonly kind: "literal"; readonly value: string | number | boolean };

export type ResolvedScalarField = {
  readonly kind: "scalar";
  readonly name: string;
  readonly type: ScalarTypeName;
  /** `true` when the property may be absent / `null`. Lists are never optional. */
  readonly optional: boolean;
  readonly list: boolean;
  readonly id: boolean;
  readonly unique: boolean;
  readonly index: boolean;
  readonly default?: DefaultValueSpec;
};

export type RelationDirection = "OUT" | "IN";

export type ResolvedRelationField = {
  readonly kind: "relation";
  readonly name: string;
  /** Target node model name. */
  readonly target: string;
  /** Neo4j relationship type, e.g. `AUTHORED`. */
  readonly relType: string;
  /** `OUT`: `(this)-[:T]->(target)`; `IN`: `(this)<-[:T]-(target)`. */
  readonly direction: RelationDirection;
  readonly many: boolean;
  readonly optional: boolean;
  /** Name of the `relationship { … }` model that types this edge's properties, if any. */
  readonly edge?: string;
};

export type ResolvedField = ResolvedScalarField | ResolvedRelationField;

export type ResolvedNodeModel = {
  readonly name: string;
  /** Neo4j label (currently always the model name). */
  readonly label: string;
  /** Name of the `@id` field, if any. */
  readonly idField?: string;
  /** `@id` and `@unique` scalar fields — valid keys for `findUnique` / `connect`. */
  readonly uniqueFields: readonly string[];
  /** Fields in declaration order. */
  readonly fields: readonly ResolvedField[];
};

export type ResolvedRelationshipModel = {
  readonly name: string;
  readonly relType: string;
  readonly from: string;
  readonly to: string;
  readonly properties: readonly ResolvedScalarField[];
};

export type SchemaModel = {
  readonly version: typeof SCHEMA_MODEL_VERSION;
  readonly nodes: readonly ResolvedNodeModel[];
  readonly relationships: readonly ResolvedRelationshipModel[];
};

const DEFAULT_FUNCTIONS: Record<DefaultFunction, readonly ScalarTypeName[]> = {
  cuid: ["String"],
  uuid: ["String"],
  now: ["DateTime", "Date"],
};

function findDecorator(decs: readonly Decorator[], name: string): Decorator | undefined {
  return decs.find((d) => d.name === name);
}

function argValue(dec: Decorator, key: string): DecoratorValue | undefined {
  return dec.args.find((a) => a.key === key)?.value;
}

function resolveDefault(owner: string, f: ScalarNodeField): DefaultValueSpec | undefined {
  const dec = findDecorator(f.decorators, "default");
  if (!dec) {
    return undefined;
  }
  const where = `${owner} field "${f.name}"`;
  const fn = argValue(dec, "fn");
  if (fn && fn.kind === "identifier") {
    const allowed = DEFAULT_FUNCTIONS[fn.value as DefaultFunction];
    if (!allowed) {
      throw new SchemaValidationError(
        `${where}: unknown default function "${fn.value}()" (expected ${Object.keys(
          DEFAULT_FUNCTIONS,
        )
          .map((k) => `${k}()`)
          .join(", ")}).`,
      );
    }
    if (!allowed.includes(f.type.name) || f.type.list) {
      throw new SchemaValidationError(
        `${where}: @default(${fn.value}()) is not valid for type ${f.type.name}${f.type.list ? "[]" : ""}.`,
      );
    }
    return { kind: "fn", fn: fn.value as DefaultFunction };
  }
  const lit = argValue(dec, "value");
  if (!lit || lit.kind === "identifier") {
    throw new SchemaValidationError(`${where}: unsupported @default(...) argument.`);
  }
  const t = f.type.name;
  const ok =
    !f.type.list &&
    ((lit.kind === "string" && t === "String") ||
      (lit.kind === "boolean" && t === "Boolean") ||
      (lit.kind === "number" && (t === "Float" || (t === "Int" && Number.isInteger(lit.value)))));
  if (!ok) {
    throw new SchemaValidationError(
      `${where}: default ${JSON.stringify(lit.value)} does not match type ${t}${f.type.list ? "[]" : ""}.`,
    );
  }
  return { kind: "literal", value: lit.value };
}

function resolveScalar(owner: string, f: ScalarNodeField, allowId: boolean): ResolvedScalarField {
  const id = Boolean(findDecorator(f.decorators, "id"));
  const list = Boolean(f.type.list);
  if (id && !allowId) {
    throw new SchemaValidationError(
      `${owner} field "${f.name}": @id is only valid on node fields.`,
    );
  }
  if (id && (f.type.optional || list)) {
    throw new SchemaValidationError(
      `${owner} field "${f.name}": an @id field cannot be optional or a list.`,
    );
  }
  for (const d of f.decorators) {
    if (!["id", "unique", "index", "default"].includes(d.name)) {
      throw new SchemaValidationError(`${owner} field "${f.name}": unknown decorator @${d.name}.`);
    }
  }
  const field: ResolvedScalarField = {
    kind: "scalar",
    name: f.name,
    type: f.type.name,
    optional: list ? false : f.type.optional,
    list,
    id,
    unique: Boolean(findDecorator(f.decorators, "unique")),
    index: Boolean(findDecorator(f.decorators, "index")),
  };
  const def = resolveDefault(owner, f);
  return def ? { ...field, default: def } : field;
}

function assertUniqueNames(owner: string, names: readonly string[]): void {
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) {
      throw new SchemaValidationError(`${owner}: duplicate field "${n}".`);
    }
    seen.add(n);
  }
}

/**
 * Resolve a parsed document into a {@link SchemaModel}: link relations to their targets and
 * relationship models, type defaults, and check every cross-reference.
 *
 * @param doc - Output of {@link parseSchema}.
 * @throws {SchemaValidationError} On unknown targets, bad defaults, ambiguous edges, etc.
 */
export function resolveSchema(doc: SchemaDocument): SchemaModel {
  const nodeNames = new Set<string>();
  const relNames = new Set<string>();
  for (const d of doc.declarations) {
    const set = d.kind === "Node" ? nodeNames : relNames;
    if (nodeNames.has(d.name) || relNames.has(d.name)) {
      throw new SchemaValidationError(`Duplicate declaration "${d.name}".`);
    }
    set.add(d.name);
  }

  const relationships: ResolvedRelationshipModel[] = [];
  for (const d of doc.declarations) {
    if (d.kind !== "Relationship") {
      continue;
    }
    const owner = `Relationship "${d.name}"`;
    for (const end of [d.from, d.to]) {
      if (!nodeNames.has(end)) {
        throw new SchemaValidationError(`${owner}: unknown node "${end}".`);
      }
    }
    assertUniqueNames(
      owner,
      d.fields.map((f) => f.name),
    );
    relationships.push({
      name: d.name,
      relType: d.relType,
      from: d.from,
      to: d.to,
      properties: d.fields.map((f) => resolveScalar(owner, f, false)),
    });
  }

  const nodes: ResolvedNodeModel[] = [];
  for (const d of doc.declarations) {
    if (d.kind !== "Node") {
      continue;
    }
    const owner = `Node "${d.name}"`;
    assertUniqueNames(
      owner,
      d.fields.map((f) => f.name),
    );
    const fields: ResolvedField[] = [];
    for (const f of d.fields) {
      if (f.kind === "Scalar") {
        fields.push(resolveScalar(owner, f, true));
        continue;
      }
      const where = `${owner} field "${f.name}"`;
      if (!nodeNames.has(f.target)) {
        throw new SchemaValidationError(`${where}: unknown node "${f.target}".`);
      }
      const rel = findDecorator(f.decorators, "relationship");
      const typeArg = rel ? argValue(rel, "type") : undefined;
      if (!rel || !typeArg || typeArg.kind !== "string" || typeArg.value === "") {
        throw new SchemaValidationError(
          `${where}: relation fields need @relationship(type: "TYPE", direction: OUT|IN).`,
        );
      }
      const dirArg = argValue(rel, "direction");
      let direction: RelationDirection = "OUT";
      if (dirArg) {
        if (dirArg.kind !== "identifier" || (dirArg.value !== "OUT" && dirArg.value !== "IN")) {
          throw new SchemaValidationError(`${where}: direction must be OUT or IN.`);
        }
        direction = dirArg.value;
      }
      const [start, end] = direction === "OUT" ? [d.name, f.target] : [f.target, d.name];
      const edges = relationships.filter(
        (r) => r.relType === typeArg.value && r.from === start && r.to === end,
      );
      if (edges.length > 1) {
        throw new SchemaValidationError(
          `${where}: several relationship models match (${edges.map((e) => e.name).join(", ")}).`,
        );
      }
      const field: ResolvedRelationField = {
        kind: "relation",
        name: f.name,
        target: f.target,
        relType: typeArg.value,
        direction,
        many: f.cardinality === "many",
        optional: f.cardinality === "many" ? false : f.optional,
      };
      fields.push(edges[0] ? { ...field, edge: edges[0].name } : field);
    }
    const scalars = fields.filter((f): f is ResolvedScalarField => f.kind === "scalar");
    const idField = scalars.find((f) => f.id)?.name;
    nodes.push({
      name: d.name,
      label: d.name,
      ...(idField ? { idField } : {}),
      uniqueFields: scalars.filter((f) => f.id || f.unique).map((f) => f.name),
      fields,
    });
  }

  return { version: SCHEMA_MODEL_VERSION, nodes, relationships };
}

/** Look up a node model by name. */
export function getNodeModel(model: SchemaModel, name: string): ResolvedNodeModel {
  const n = model.nodes.find((x) => x.name === name);
  if (!n) {
    throw new Error(`Unknown node model "${name}".`);
  }
  return n;
}
