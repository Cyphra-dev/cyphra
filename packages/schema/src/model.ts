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
  ModelAttribute,
  NodeDeclaration,
  ScalarNodeField,
  ScalarTypeName,
  SchemaDocument,
} from "./ast.js";
import { SchemaValidationError } from "./errors.js";
import { validateEnum, validateModelAttributes, validateVectorField } from "./validate.js";

/** Bump when the shape of {@link SchemaModel} changes incompatibly. */
export const SCHEMA_MODEL_VERSION = 1 as const;

/** Built-in generator functions accepted by `@default(fn())`. */
export type DefaultFunction = "cuid" | "uuid" | "now";

/**
 * A `@default(...)`. Literal values are JSON-friendly: a `BigInt` default is its decimal digits
 * (`"9007199254740993"`), a `Json` default is its (normalized) JSON text, an enum default is the
 * value's name.
 */
export type DefaultValueSpec =
  | { readonly kind: "fn"; readonly fn: DefaultFunction }
  | { readonly kind: "literal"; readonly value: string | number | boolean };

/** An `enum` declaration: its name and values, in declaration order. */
export type ResolvedEnum = {
  readonly name: string;
  readonly values: readonly string[];
};

/** Similarity function of a vector index (`vector.similarity_function`). */
export type VectorSimilarity = "cosine" | "euclidean";

/** A `@vectorIndex(...)` on a `Vector(N)` node field. */
export type ResolvedVectorIndex = {
  /** Neo4j index name (default `<Label>_<field>_vector`). */
  readonly name: string;
  readonly similarity: VectorSimilarity;
  /**
   * `vector.quantization.enabled` (Neo4j 5.23+). Absent: Neo4j's default (on), which stores
   * compressed vectors and makes index scores approximate.
   */
  readonly quantization?: boolean;
};

/** A `@@fulltext([...])` full-text index on a node model. */
export type ResolvedFulltextIndex = {
  /** Neo4j index name (default `<Label>_<field>_<field>…_fulltext`). */
  readonly name: string;
  /** Indexed `String` / `String[]` fields, in declaration order of the attribute. */
  readonly fields: readonly string[];
  /** `fulltext.analyzer` (absent: Neo4j's default, `standard-no-stop-words`). */
  readonly analyzer?: string;
  /**
   * `fulltext.eventually_consistent` (absent: `false`). An eventually consistent index is updated
   * in the background after commit, so queries can miss recent writes.
   */
  readonly eventuallyConsistent?: boolean;
};

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
  /** Number of dimensions of a `Vector(N)` field (stored as `LIST<FLOAT>`, typed `number[]`). */
  readonly dimensions?: number;
  /** Vector index declared with `@vectorIndex(...)` on a `Vector(N)` field. */
  readonly vectorIndex?: ResolvedVectorIndex;
  /** Name of the `enum` of an `Enum` field. */
  readonly enum?: string;
  /** Allowed values of an `Enum` field (copied from its `enum`, checked on every write). */
  readonly enumValues?: readonly string[];
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
  /** `@@fulltext` indexes (absent when the model has none). */
  readonly fulltextIndexes?: readonly ResolvedFulltextIndex[];
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
  /** `enum` declarations (absent when the schema has none). */
  readonly enums?: readonly ResolvedEnum[];
};

/** Smallest and largest values of a `BigInt` (a Neo4j 64-bit `INTEGER`). */
const BIGINT_MIN = -(2n ** 63n);
const BIGINT_MAX = 2n ** 63n - 1n;

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

function resolveDefault(
  owner: string,
  f: ScalarNodeField,
  enumValues?: readonly string[],
): DefaultValueSpec | undefined {
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
  const t = f.type.name;
  if (lit && t === "Enum" && !f.type.list && (lit.kind === "identifier" || lit.kind === "string")) {
    const values = enumValues ?? [];
    if (!values.includes(lit.value)) {
      throw new SchemaValidationError(
        `${where}: default ${lit.value} is not a value of enum ${f.type.enum} (${values.join(", ")}).`,
      );
    }
    return { kind: "literal", value: lit.value };
  }
  if (!lit || lit.kind === "identifier") {
    throw new SchemaValidationError(`${where}: unsupported @default(...) argument.`);
  }
  if (t === "BigInt" && !f.type.list && lit.kind === "number") {
    const digits = lit.raw ?? String(lit.value);
    if (!/^-?[0-9]+$/.test(digits) || BigInt(digits) < BIGINT_MIN || BigInt(digits) > BIGINT_MAX) {
      throw new SchemaValidationError(
        `${where}: default ${digits} is not a 64-bit integer (BigInt is -2^63 to 2^63-1).`,
      );
    }
    return { kind: "literal", value: BigInt(digits).toString() };
  }
  if (t === "Json" && lit.kind === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lit.value);
    } catch {
      throw new SchemaValidationError(
        `${where}: a Json default must be a string holding JSON text, e.g. @default("{}") (got ${JSON.stringify(lit.value)}).`,
      );
    }
    return { kind: "literal", value: JSON.stringify(parsed) };
  }
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

function resolveScalar(
  owner: string,
  f: ScalarNodeField,
  allowId: boolean,
  enums: ReadonlyMap<string, ResolvedEnum>,
): ResolvedScalarField {
  const id = Boolean(findDecorator(f.decorators, "id"));
  const list = Boolean(f.type.list);
  let enumDef: ResolvedEnum | undefined;
  if (f.type.name === "Enum") {
    enumDef = enums.get(f.type.enum ?? "");
    if (!enumDef) {
      throw new SchemaValidationError(
        `${owner} field "${f.name}": unknown type "${f.type.enum}" (not a scalar type or a declared enum).`,
      );
    }
  }
  if (f.type.name === "Json") {
    if (list) {
      throw new SchemaValidationError(
        `${owner} field "${f.name}": Json[] is not supported (a Json value can itself be an array).`,
      );
    }
    for (const n of ["id", "unique", "index"]) {
      if (findDecorator(f.decorators, n)) {
        throw new SchemaValidationError(
          `${owner} field "${f.name}": @${n} is not valid on a Json field.`,
        );
      }
    }
  }
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
  validateVectorField(owner, f, allowId);
  for (const d of f.decorators) {
    if (!["id", "unique", "index", "default", "vectorIndex"].includes(d.name)) {
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
  if (f.type.name === "Vector") {
    return { ...field, dimensions: f.type.dimensions ?? 0 };
  }
  const def = resolveDefault(owner, f, enumDef?.values);
  const typed = enumDef ? { ...field, enum: enumDef.name, enumValues: enumDef.values } : field;
  return def ? { ...typed, default: def } : typed;
}

function resolveVectorIndex(label: string, f: ScalarNodeField): ResolvedVectorIndex | undefined {
  const dec = findDecorator(f.decorators, "vectorIndex");
  if (!dec) return undefined;
  const sim = argValue(dec, "similarity");
  const name = argValue(dec, "name");
  const quantization = argValue(dec, "quantization");
  return {
    ...(quantization?.kind === "boolean" ? { quantization: quantization.value } : {}),
    name:
      name?.kind === "string"
        ? name.value
        : `${label}_${f.name}_vector`.replace(/[^A-Za-z0-9_]/g, "_"),
    similarity: sim?.kind === "identifier" ? (sim.value as VectorSimilarity) : "cosine",
  };
}

function sanitizeIndexName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function resolveFulltext(decl: NodeDeclaration, attr: ModelAttribute): ResolvedFulltextIndex {
  const fields = attr.fields ?? [];
  const name = attr.args.find((a) => a.key === "name")?.value;
  const analyzer = attr.args.find((a) => a.key === "analyzer")?.value;
  const eventually = attr.args.find((a) => a.key === "eventuallyConsistent")?.value;
  return {
    name:
      name?.kind === "string"
        ? name.value
        : sanitizeIndexName(`${decl.name}_${fields.join("_")}_fulltext`),
    fields,
    ...(analyzer && analyzer.kind !== "number" && analyzer.kind !== "boolean"
      ? { analyzer: analyzer.value }
      : {}),
    ...(eventually?.kind === "boolean" ? { eventuallyConsistent: eventually.value } : {}),
  };
}

/**
 * Names of the constraints and range indexes migrations derive from the schema (they share
 * Neo4j's index/constraint namespace with vector and full-text index names).
 */
function impliedDdlNames(doc: SchemaDocument): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of doc.declarations) {
    if (d.kind === "Enum") continue;
    for (const f of d.fields) {
      if (f.kind !== "Scalar") continue;
      const has = (n: string) => f.decorators.some((x) => x.name === n);
      const base = d.kind === "Node" ? `${d.name}_${f.name}` : `${d.name}_${f.name}_rel`;
      const suffix =
        has("id") && d.kind === "Node"
          ? "id"
          : has("unique")
            ? "unique"
            : has("index")
              ? "idx"
              : null;
      if (suffix) out.set(sanitizeIndexName(`${base}_${suffix}`), `${d.name}.${f.name}`);
    }
  }
  return out;
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
  const enums = new Map<string, ResolvedEnum>();
  for (const d of doc.declarations) {
    if (nodeNames.has(d.name) || relNames.has(d.name) || enums.has(d.name)) {
      throw new SchemaValidationError(`Duplicate declaration "${d.name}".`);
    }
    if (d.kind === "Enum") {
      validateEnum(d);
      enums.set(d.name, { name: d.name, values: [...d.values] });
      continue;
    }
    (d.kind === "Node" ? nodeNames : relNames).add(d.name);
    validateModelAttributes(d);
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
      properties: d.fields.map((f) => resolveScalar(owner, f, false, enums)),
    });
  }

  const nodes: ResolvedNodeModel[] = [];
  // Index and constraint names share one namespace in Neo4j: track every name the schema implies.
  const indexNames = impliedDdlNames(doc);
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
        const field = resolveScalar(owner, f, true, enums);
        const vectorIndex = resolveVectorIndex(d.name, f);
        if (vectorIndex) {
          const clash = indexNames.get(vectorIndex.name);
          if (clash) {
            throw new SchemaValidationError(
              `${owner} field "${f.name}": vector index name "${vectorIndex.name}" is already used by ${clash}.`,
            );
          }
          indexNames.set(vectorIndex.name, `${d.name}.${f.name}`);
        }
        fields.push(vectorIndex ? { ...field, vectorIndex } : field);
        continue;
      }
      const where = `${owner} field "${f.name}"`;
      if (!nodeNames.has(f.target)) {
        throw new SchemaValidationError(
          `${where}: unknown node "${f.target}" (not a node model or an enum).`,
        );
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
    const fulltextIndexes: ResolvedFulltextIndex[] = [];
    for (const attr of d.attributes ?? []) {
      if (attr.name !== "fulltext") continue;
      const index = resolveFulltext(d, attr);
      const clash = indexNames.get(index.name);
      if (clash) {
        throw new SchemaValidationError(
          `${owner} @@fulltext: index name "${index.name}" is already used by ${clash}.`,
        );
      }
      indexNames.set(index.name, `@@fulltext on ${d.name}`);
      fulltextIndexes.push(index);
    }
    nodes.push({
      name: d.name,
      label: d.name,
      ...(idField ? { idField } : {}),
      uniqueFields: scalars.filter((f) => f.id || f.unique).map((f) => f.name),
      fields,
      ...(fulltextIndexes.length ? { fulltextIndexes } : {}),
    });
  }

  return {
    version: SCHEMA_MODEL_VERSION,
    nodes,
    relationships,
    ...(enums.size ? { enums: [...enums.values()] } : {}),
  };
}

/** Look up a node model by name. */
export function getNodeModel(model: SchemaModel, name: string): ResolvedNodeModel {
  const n = model.nodes.find((x) => x.name === name);
  if (!n) {
    throw new Error(`Unknown node model "${name}".`);
  }
  return n;
}
