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
  RelationalNodeField,
  ScalarNodeField,
  ScalarTypeName,
  SchemaDocument,
} from "./ast.js";
import { SchemaValidationError } from "./errors.js";
import {
  ancestorInterfaces,
  nodeOwner,
  parentInterfaces,
  validateEnum,
  validateImplements,
  validateModelAttributes,
  validateUnion,
  validateVectorField,
  withInheritedFields,
} from "./validate.js";
import {
  VALIDATION_RULES,
  assertNamedArgs,
  checkRules,
  resolveFieldRules,
  type ValidationRule,
} from "./rules.js";
import {
  TEMPORAL_EXAMPLES,
  formatDuration,
  formatLocalDateTime,
  formatLocalTime,
  formatTime,
  parseDuration,
  parseLocalDateTime,
  parseLocalTime,
  parseTime,
  type IsoTemporalType,
} from "./temporal.js";

/** `text` in the canonical form the runtime returns, or `null` when it is not valid. */
function canonicalTemporalText(type: IsoTemporalType, text: string): string | null {
  switch (type) {
    case "LocalDateTime": {
      const p = parseLocalDateTime(text);
      return p && formatLocalDateTime(p);
    }
    case "LocalTime": {
      const p = parseLocalTime(text);
      return p && formatLocalTime(p);
    }
    case "Time": {
      const p = parseTime(text);
      return p && formatTime(p);
    }
    case "Duration": {
      const p = parseDuration(text);
      return p && formatDuration(p);
    }
  }
}

/** Bump when the shape of {@link SchemaModel} changes incompatibly. */
export const SCHEMA_MODEL_VERSION = 1 as const;

/** Built-in generator functions accepted by `@default(fn())`. */
export type DefaultFunction = "cuid" | "uuid" | "now";

/**
 * A `@default(...)`. Literal values are JSON-friendly: a `BigInt` default is its decimal digits
 * (`"9007199254740993"`), a `Json` default is its (normalized) JSON text, an enum default is the
 * value's name, a `LocalDateTime` / `LocalTime` / `Time` / `Duration` default its ISO 8601 text
 * (normalized: `"PT90M"` becomes `"PT1H30M"`).
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
  /**
   * Interface that declares the index, on a node implementing it (the index covers the
   * interface's label; searching through the node keeps the nodes with its own label).
   */
  readonly inheritedFrom?: string;
};

/**
 * A `@@unique([a, b])` composite uniqueness constraint on a node model: no two nodes of the label
 * share the same values for all of `fields` (nodes missing one of them are not constrained).
 */
export type ResolvedCompoundUnique = {
  /** Neo4j constraint name (the attribute's `name`, else `<Label>_<field>_<field>…_unique`). */
  readonly name: string;
  /**
   * Key of the compound value in a unique `where` (`findUnique`, `upsert`, `connect`, …): the
   * attribute's `name`, else the field names joined by `_` (`a_b`, as in Prisma).
   */
  readonly key: string;
  /** Constrained scalar fields, in the attribute's order (at least two). */
  readonly fields: readonly string[];
  /** Interface that declares the constraint, on a node implementing it (absent otherwise). */
  readonly inheritedFrom?: string;
};

/** A `@@index([a, b])` composite range index on a node model. */
export type ResolvedCompoundIndex = {
  /** Neo4j index name (the attribute's `name`, else `<Label>_<field>_<field>…_idx`). */
  readonly name: string;
  /** Indexed scalar fields, in the attribute's order (at least two). */
  readonly fields: readonly string[];
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
  /**
   * Validation rules (`@length`, `@min`, `@email`, …) in declaration order, checked on every
   * write (absent when the field has none).
   */
  readonly rules?: readonly ValidationRule[];
  /**
   * Interface that declares the field, on a node implementing it (absent for the node's own
   * fields). Its constraints and indexes belong to the interface's label.
   */
  readonly inheritedFrom?: string;
};

export type RelationDirection = "OUT" | "IN";

/**
 * What deleting a node does to the nodes a relation field links it to
 * (`@relationship(…, onDelete: …)`): `Cascade` deletes them too (following their own rules),
 * `Restrict` refuses the delete while any exist, `SetNull` (the default) only removes the edges.
 */
export type OnDeleteRule = "Cascade" | "Restrict" | "SetNull";

/** Rules accepted by `@relationship(onDelete: …)`, in the order the docs list them. */
export const ON_DELETE_RULES = [
  "Cascade",
  "Restrict",
  "SetNull",
] as const satisfies readonly OnDeleteRule[];

/** Arguments accepted by `@relationship(…)`. */
const RELATIONSHIP_ARGS = ["type", "direction", "onDelete"] as const;

/** Arguments accepted by `@out(…)` / `@in(…)` (`type` is the positional one). */
const OUT_IN_ARGS = ["type", "onDelete"] as const;

/** The decorators that make a field a relation field. */
const RELATION_DECORATORS = ["out", "in", "relationship"] as const;

/**
 * How a relation field names its edges: `@out(TYPE)` / `@in(TYPE)`, or the older
 * `@relationship(type: "TYPE", direction: OUT|IN)`.
 */
export type RelationSyntax = "out" | "in" | "relationship";

/** The edges a relation field declares, read from its decorator (see {@link relationOf}). */
export type RelationSpec = {
  readonly relType: string;
  readonly direction: RelationDirection;
  readonly onDelete?: OnDeleteRule;
  readonly syntax: RelationSyntax;
  /** The decorator it was read from. */
  readonly decorator: Decorator;
};

/** `@out(TYPE)` or `@in(TYPE)` (or the `@relationship` form) of `direction` for a message. */
export function relationSyntaxOf(
  syntax: RelationSyntax,
  relType: string,
  direction: RelationDirection,
): string {
  if (syntax === "relationship") {
    return `@relationship(type: ${JSON.stringify(relType)}, direction: ${direction})`;
  }
  return `@${direction === "OUT" ? "out" : "in"}(${relType})`;
}

/**
 * The decorator of a relation field, as importers and code generators write it: `@out(TYPE)` /
 * `@in(TYPE)` (with `onDelete` when given), or `@relationship(type: "…", direction: …)` for a type
 * that is not an identifier (`HAS-TAG`).
 */
export function relationFieldDecorator(
  relType: string,
  direction: RelationDirection,
  onDelete?: OnDeleteRule,
): Decorator {
  const rule = onDelete
    ? [{ key: "onDelete", value: { kind: "identifier" as const, value: onDelete } }]
    : [];
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(relType)) {
    return {
      name: "relationship",
      args: [
        { key: "type", value: { kind: "string", value: relType } },
        { key: "direction", value: { kind: "identifier", value: direction } },
        ...rule,
      ],
    };
  }
  return {
    name: direction === "OUT" ? "out" : "in",
    args: [{ key: "type", value: { kind: "identifier", value: relType } }, ...rule],
  };
}

/**
 * Read the relationship a relation field declares: `@out(TYPE, onDelete: …)`, `@in(TYPE, …)` or
 * `@relationship(type: "TYPE", direction: OUT|IN, onDelete: …)`.
 *
 * @param where - Prefix of error messages (`Node "User" field "posts"`).
 * @throws {SchemaValidationError} When the field has none of them, several, or bad arguments.
 */
export function relationOf(where: string, f: RelationalNodeField): RelationSpec {
  const decs = f.decorators.filter((d) =>
    (RELATION_DECORATORS as readonly string[]).includes(d.name),
  );
  if (decs.length === 0) {
    throw new SchemaValidationError(
      `${where}: relation fields need @out(TYPE) or @in(TYPE) (or @relationship(type: "TYPE", direction: OUT|IN)).`,
    );
  }
  if (decs.length > 1) {
    const names = decs.map((d) => `@${d.name}`);
    const what =
      new Set(names).size === 1
        ? `at most one ${names[0]} allowed`
        : `use one of @out(TYPE), @in(TYPE) or @relationship(…), not ${names.join(" and ")}`;
    throw new SchemaValidationError(`${where}: ${what}.`);
  }
  const rel = decs[0]!;
  const allowed: readonly string[] = rel.name === "relationship" ? RELATIONSHIP_ARGS : OUT_IN_ARGS;
  const typeArg = argValue(rel, "type");
  let relType: string;
  let direction: RelationDirection = "OUT";
  if (rel.name === "relationship") {
    if (!typeArg || typeArg.kind !== "string" || typeArg.value === "") {
      throw new SchemaValidationError(
        `${where}: relation fields need @relationship(type: "TYPE", direction: OUT|IN).`,
      );
    }
    relType = typeArg.value;
    const dirArg = argValue(rel, "direction");
    if (dirArg) {
      if (dirArg.kind !== "identifier" || (dirArg.value !== "OUT" && dirArg.value !== "IN")) {
        throw new SchemaValidationError(`${where}: direction must be OUT or IN.`);
      }
      direction = dirArg.value;
    }
  } else {
    if (!typeArg || typeArg.kind !== "identifier") {
      const got =
        typeArg?.kind === "string"
          ? ` (got ${JSON.stringify(typeArg.value)}: write the type without quotes, or use @relationship(type: "…", direction: ${rel.name === "out" ? "OUT" : "IN"}) for a type that is not an identifier)`
          : "";
      throw new SchemaValidationError(
        `${where}: @${rel.name} needs the relationship type, e.g. @${rel.name}(AUTHORED)${got}.`,
      );
    }
    relType = typeArg.value;
    direction = rel.name === "out" ? "OUT" : "IN";
  }
  const seenArgs = new Set<string>();
  for (const a of rel.args) {
    if (!allowed.includes(a.key)) {
      const hint =
        rel.name !== "relationship" && a.key === "direction"
          ? ` (@${rel.name} already gives the direction)`
          : "";
      throw new SchemaValidationError(
        `${where}: unknown @${rel.name} argument "${a.key}" (expected ${allowed.join(", ")})${hint}.`,
      );
    }
    if (seenArgs.has(a.key)) {
      throw new SchemaValidationError(`${where}: @${rel.name} ${a.key} given twice.`);
    }
    seenArgs.add(a.key);
  }
  const ruleArg = argValue(rel, "onDelete");
  let onDelete: OnDeleteRule | undefined;
  if (ruleArg) {
    if (
      ruleArg.kind !== "identifier" ||
      !(ON_DELETE_RULES as readonly string[]).includes(ruleArg.value)
    ) {
      throw new SchemaValidationError(
        `${where}: onDelete must be ${ON_DELETE_RULES.join(", ")} (got ${ruleArg.kind === "string" ? JSON.stringify(ruleArg.value) : String(ruleArg.value)}).`,
      );
    }
    onDelete = ruleArg.value as OnDeleteRule;
  }
  return {
    relType,
    direction,
    ...(onDelete ? { onDelete } : {}),
    syntax: rel.name as RelationSyntax,
    decorator: rel,
  };
}

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
  /**
   * What deleting a node of this model does to the nodes this field links it to (absent when the
   * schema sets none, which means `SetNull`: the edges are removed, the nodes stay).
   */
  readonly onDelete?: OnDeleteRule;
  /** Interface that declares the field, on a node implementing it (absent otherwise). */
  readonly inheritedFrom?: string;
};

export type ResolvedField = ResolvedScalarField | ResolvedRelationField;

export type ResolvedNodeModel = {
  readonly name: string;
  /** Neo4j label of the model (its name). */
  readonly label: string;
  /**
   * `true` for an `interface`: an abstract model whose label every implementation carries. It can
   * be queried (results are its implementations) but not created. Absent for a `node`.
   */
  readonly abstract?: true;
  /**
   * `true` for a `union` (always with `abstract: true`): a type grouping unrelated nodes, its
   * {@link ResolvedNodeModel.implementations}. It adds no label (no node carries `label`), has no
   * fields and is matched by a label predicate over its members. Absent otherwise.
   */
  readonly union?: true;
  /**
   * Nodes implementing this interface, directly or through an interface extending it, in
   * declaration order (only on an interface), or the nodes of a union: its members in `union`
   * order, an interface member replaced by its implementations.
   */
  readonly implementations?: readonly string[];
  /**
   * The members of a union as declared, when one of them is an interface
   * (`union Party = Person | Team`: `["Person", "Team"]`). A union is matched by its members'
   * labels, and relation writes and `where.$on` may name an interface member. Absent otherwise
   * (then the members are {@link ResolvedNodeModel.implementations}).
   */
  readonly members?: readonly string[];
  /**
   * Interfaces an interface extends, in `extends` order (only on an interface extending others;
   * {@link ResolvedNodeModel.interfaces} adds the ones they extend).
   */
  readonly extends?: readonly string[];
  /**
   * Every interface the model inherits from: each one it implements (or, on an interface,
   * extends), followed by the ones that one extends (absent when there are none).
   */
  readonly interfaces?: readonly string[];
  /**
   * Every label of a node: its own, then each interface's (absent when it implements none, i.e.
   * when it is just `[label]`, and on an interface, which is matched by its own label). Nodes of
   * the model are written and matched with all of them.
   */
  readonly labels?: readonly string[];
  /**
   * Labels declared with `@@labels([...])` (and inherited from interfaces): flags a node of the
   * model may carry or not, added and removed at runtime (`data: { $labels: … }`) and filtered on
   * (`where: { $labels: … }`). Never part of how the model is matched. Absent when none.
   */
  readonly dynamicLabels?: readonly string[];
  /** Name of the `@id` field, if any. */
  readonly idField?: string;
  /** `@id` and `@unique` scalar fields — valid keys for `findUnique` / `connect`. */
  readonly uniqueFields: readonly string[];
  /** Fields in declaration order. */
  readonly fields: readonly ResolvedField[];
  /** `@@fulltext` indexes (absent when the model has none). */
  readonly fulltextIndexes?: readonly ResolvedFulltextIndex[];
  /**
   * `@@unique([...])` composite uniqueness constraints (absent when the model has none); each one
   * is also a valid key for `findUnique` / `connect` (`where: { a_b: { a, b } }`).
   */
  readonly compoundUniques?: readonly ResolvedCompoundUnique[];
  /** `@@index([...])` composite range indexes (absent when the model has none). */
  readonly compoundIndexes?: readonly ResolvedCompoundIndex[];
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
  now: ["DateTime", "Date", "LocalDateTime", "LocalTime", "Time"],
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
  if (
    (t === "LocalDateTime" || t === "LocalTime" || t === "Time" || t === "Duration") &&
    !f.type.list &&
    lit.kind === "string"
  ) {
    const text = canonicalTemporalText(t, lit.value);
    if (text === null) {
      throw new SchemaValidationError(
        `${where}: default ${JSON.stringify(lit.value)} is not a valid ${t} (ISO 8601, e.g. "${TEMPORAL_EXAMPLES[t]}").`,
      );
    }
    return { kind: "literal", value: text };
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
  assertNamedArgs(`${owner} field "${f.name}"`, f.decorators);
  validateVectorField(owner, f, allowId);
  for (const d of f.decorators) {
    if (
      !["id", "unique", "index", "default", "vectorIndex", ...VALIDATION_RULES].includes(d.name)
    ) {
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
  const rules = resolveFieldRules(owner, f);
  if (def?.kind === "literal" && rules.length) {
    const value = f.type.name === "BigInt" ? BigInt(def.value as string) : def.value;
    const broken = checkRules({ type: f.type.name, list, rules }, value)[0];
    if (broken) {
      throw new SchemaValidationError(
        `${owner} field "${f.name}": default ${JSON.stringify(def.value)} breaks @${broken.rule}: it ${broken.message}`,
      );
    }
  }
  const typed = enumDef ? { ...field, enum: enumDef.name, enumValues: enumDef.values } : field;
  const ruled = rules.length ? { ...typed, rules } : typed;
  return def ? { ...ruled, default: def } : ruled;
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
    if (d.kind === "Enum" || d.kind === "Union") continue;
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
  const unionNames = new Set<string>();
  for (const d of doc.declarations) {
    if (nodeNames.has(d.name) || relNames.has(d.name) || enums.has(d.name)) {
      throw new SchemaValidationError(`Duplicate declaration "${d.name}".`);
    }
    if (d.kind === "Union") {
      // A relation field may target it, like a node.
      nodeNames.add(d.name);
      unionNames.add(d.name);
      continue;
    }
    if (d.kind === "Enum") {
      validateEnum(d);
      enums.set(d.name, { name: d.name, values: [...d.values] });
      continue;
    }
    (d.kind === "Node" ? nodeNames : relNames).add(d.name);
    if (d.kind === "Node") {
      validateImplements(doc, d);
      validateModelAttributes(withInheritedFields(doc, d));
    } else {
      validateModelAttributes(d);
    }
  }

  const relationships: ResolvedRelationshipModel[] = [];
  /** Short-form models (`relationship AUTHORED { … }`) by type; their ends are set below. */
  const shortForms = new Map<string, ResolvedRelationshipModel>();
  for (const d of doc.declarations) {
    if (d.kind !== "Relationship") {
      continue;
    }
    const owner = `Relationship "${d.name}"`;
    // An end may be a node, an interface or a union (one edge model for every member).
    for (const end of d.from === undefined ? [] : [d.from, d.to ?? ""]) {
      if (!nodeNames.has(end)) {
        throw new SchemaValidationError(`${owner}: unknown node "${end}".`);
      }
    }
    assertUniqueNames(
      owner,
      d.fields.map((f) => f.name),
    );
    const model: ResolvedRelationshipModel = {
      name: d.name,
      relType: d.relType,
      from: d.from ?? "",
      to: d.to ?? "",
      properties: d.fields.map((f) => resolveScalar(owner, f, false, enums)),
    };
    if (d.from === undefined) shortForms.set(d.relType, model);
    relationships.push(model);
  }
  // A type has one short-form block, or long-form ones (one per pair of ends), not both.
  for (const d of doc.declarations) {
    if (d.kind !== "Relationship" || d.from === undefined || !shortForms.has(d.relType)) continue;
    throw new SchemaValidationError(
      `Relationship "${d.name}": relationship ${d.relType} { … } already types every :${d.relType} edge (use one or the other).`,
    );
  }
  /** Every relation field (own fields of each node and interface), for the checks below. */
  const ends: RelationEnd[] = [];

  const nodes: ResolvedNodeModel[] = [];
  // Index and constraint names share one namespace in Neo4j: track every name the schema implies.
  const indexNames = impliedDdlNames(doc);
  for (const d of doc.declarations) {
    if (d.kind !== "Node") {
      continue;
    }
    const owner = nodeOwner(d);
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
      assertNamedArgs(where, f.decorators);
      if (!nodeNames.has(f.target)) {
        throw new SchemaValidationError(
          `${where}: unknown node "${f.target}" (not a node model, a union or an enum).`,
        );
      }
      const { relType, direction, onDelete, syntax } = relationOf(where, f);
      // A `relationship TYPE { … }` block types every edge of its type.
      const short = shortForms.get(relType);
      // A long-form model names this node, or else one of its interfaces, as the end.
      const edgeModels = (self: string) => {
        const [start, end] = direction === "OUT" ? [self, f.target] : [f.target, self];
        return relationships.filter(
          (r) =>
            !shortForms.has(r.relType) && r.relType === relType && r.from === start && r.to === end,
        );
      };
      let edges = short ? [short] : edgeModels(d.name);
      for (const i of ancestorInterfaces(doc, d)) if (edges.length === 0) edges = edgeModels(i);
      // …or else a union it is a member of (directly or through one of its interfaces).
      for (const u of unionsOf(doc, d)) if (edges.length === 0) edges = edgeModels(u);
      ends.push({
        owner: d.name,
        field: f.name,
        target: f.target,
        relType,
        direction,
        syntax,
      });
      if (edges.length > 1) {
        throw new SchemaValidationError(
          `${where}: several relationship models match (${edges.map((e) => e.name).join(", ")}).`,
        );
      }
      const field: ResolvedRelationField = {
        kind: "relation",
        name: f.name,
        target: f.target,
        relType,
        direction,
        many: f.cardinality === "many",
        optional: f.cardinality === "many" ? false : f.optional,
        ...(edges[0] ? { edge: edges[0].name } : {}),
        ...(onDelete ? { onDelete } : {}),
      };
      // Two fields of one model on the same edges (type, direction, target) would give one delete
      // two rules: they must agree.
      const twin = fields.find(
        (o): o is ResolvedRelationField =>
          o.kind === "relation" &&
          o.relType === field.relType &&
          o.direction === field.direction &&
          o.target === field.target &&
          (o.onDelete ?? "SetNull") !== (field.onDelete ?? "SetNull"),
      );
      if (twin) {
        throw new SchemaValidationError(
          `${where}: onDelete ${field.onDelete ?? "SetNull"} conflicts with field "${twin.name}" (onDelete ${twin.onDelete ?? "SetNull"}) on the same :${field.relType} edges.`,
        );
      }
      fields.push(field);
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
    const compoundUniques: ResolvedCompoundUnique[] = [];
    const compoundIndexes: ResolvedCompoundIndex[] = [];
    const keys = new Set<string>();
    for (const attr of d.attributes ?? []) {
      if (attr.name !== "unique" && attr.name !== "index") continue;
      const fieldsOf = attr.fields ?? [];
      const given = attr.args.find((a) => a.key === "name")?.value;
      const custom = given?.kind === "string" ? given.value : undefined;
      const suffix = attr.name === "unique" ? "unique" : "idx";
      const name = custom ?? sanitizeIndexName(`${d.name}_${fieldsOf.join("_")}_${suffix}`);
      const clash = indexNames.get(name);
      if (clash) {
        throw new SchemaValidationError(
          `${owner} @@${attr.name}: ${attr.name === "unique" ? "constraint" : "index"} name "${name}" is already used by ${clash}.`,
        );
      }
      indexNames.set(name, `@@${attr.name} on ${d.name}`);
      if (attr.name === "index") {
        compoundIndexes.push({ name, fields: fieldsOf });
        continue;
      }
      const key = custom ?? fieldsOf.join("_");
      if (withInheritedFields(doc, d).fields.some((f) => f.name === key) || keys.has(key)) {
        throw new SchemaValidationError(
          `${owner} @@unique: key "${key}" is already a field or another @@unique key (give this one a name: "…").`,
        );
      }
      keys.add(key);
      compoundUniques.push({ name, key, fields: fieldsOf });
    }
    const dynamicLabels = (d.attributes ?? []).find((a) => a.name === "labels")?.fields ?? [];
    nodes.push({
      name: d.name,
      label: d.name,
      ...(d.abstract ? { abstract: true as const } : {}),
      ...(dynamicLabels.length ? { dynamicLabels: [...dynamicLabels] } : {}),
      ...(idField ? { idField } : {}),
      uniqueFields: scalars.filter((f) => f.id || f.unique).map((f) => f.name),
      fields,
      ...(fulltextIndexes.length ? { fulltextIndexes } : {}),
      ...(compoundUniques.length ? { compoundUniques } : {}),
      ...(compoundIndexes.length ? { compoundIndexes } : {}),
    });
  }

  // Unions are checked once every node is known (their members must be nodes).
  for (const d of doc.declarations) if (d.kind === "Union") validateUnion(doc, d);
  checkSameDirectionPairs(ends);
  const used = new Set(
    nodes.flatMap((n) =>
      n.fields.flatMap((f) => (f.kind === "relation" && f.edge ? [f.edge] : [])),
    ),
  );
  for (const r of relationships) {
    if (used.has(r.name)) continue;
    // A type that is not an identifier (`HAS-TAG`) can only be written with @relationship.
    const syntax = /^[A-Za-z_][A-Za-z0-9_]*$/.test(r.relType) ? "out" : "relationship";
    const out = relationSyntaxOf(syntax, r.relType, "OUT");
    const inn = relationSyntaxOf(syntax, r.relType, "IN");
    throw new SchemaValidationError(
      shortForms.has(r.relType)
        ? `Relationship "${r.name}": no relation field uses it (add a field with ${out} or ${inn}, or remove the block).`
        : `Relationship "${r.name}": no relation field uses it (add a field with ${out} on ${r.from} or ${inn} on ${r.to}, or remove the block).`,
    );
  }
  const resolvedRelationships = relationships.map((r) =>
    shortForms.has(r.relType) ? { ...r, ...shortFormEnds(doc, r, ends) } : r,
  );
  return {
    version: SCHEMA_MODEL_VERSION,
    nodes: withUnions(linkInterfaces(nodes, doc), doc),
    relationships: resolvedRelationships,
    ...(enums.size ? { enums: [...enums.values()] } : {}),
  };
}

/** A relation field as the cross-field checks see it. */
type RelationEnd = {
  readonly owner: string;
  readonly field: string;
  readonly target: string;
  readonly relType: string;
  readonly direction: RelationDirection;
  readonly syntax: RelationSyntax;
};

/**
 * Reject `b B @out(T)` on A with `a A @out(T)` on B when they look like a pair (neither has an
 * inverse with the other direction): one of them was meant to be `@in(T)`, and as written they
 * describe two unrelated sets of edges.
 */
function checkSameDirectionPairs(ends: readonly RelationEnd[]): void {
  const flip = (d: RelationDirection): RelationDirection => (d === "OUT" ? "IN" : "OUT");
  const hasInverse = (e: RelationEnd) =>
    ends.some(
      (o) =>
        o.owner === e.target &&
        o.target === e.owner &&
        o.relType === e.relType &&
        o.direction === flip(e.direction),
    );
  ends.forEach((b, i) => {
    if (b.owner === b.target) return;
    const a = ends
      .slice(0, i)
      .find(
        (o) =>
          o.owner === b.target &&
          o.target === b.owner &&
          o.relType === b.relType &&
          o.direction === b.direction,
      );
    if (!a || hasInverse(a) || hasInverse(b)) return;
    const meant = relationSyntaxOf(b.syntax, b.relType, flip(b.direction));
    throw new SchemaValidationError(
      `Node "${b.owner}" field "${b.field}": ${relationSyntaxOf(b.syntax, b.relType, b.direction)} has the same direction as ${a.owner}.${a.field} (${relationSyntaxOf(a.syntax, a.relType, a.direction)}), so they describe different edges; if it is the inverse of ${a.owner}.${a.field}, use ${meant}.`,
    );
  });
}

/**
 * The ends of a short-form model (`relationship AUTHORED { … }`): the start and end nodes of the
 * fields of its type, or the interface or union covering all of them.
 */
function shortFormEnds(
  doc: SchemaDocument,
  r: ResolvedRelationshipModel,
  ends: readonly RelationEnd[],
): { from: string; to: string } {
  const pairs: [string, string][] = [];
  for (const e of ends) {
    if (e.relType !== r.relType) continue;
    const pair: [string, string] =
      e.direction === "OUT" ? [e.owner, e.target] : [e.target, e.owner];
    if (!pairs.some(([f, t]) => f === pair[0] && t === pair[1])) pairs.push(pair);
  }
  /** `name` and every interface or union it belongs to. */
  const covers = (general: string, name: string) => {
    if (general === name) return true;
    const decl = doc.declarations.find((x) => x.name === name);
    if (decl?.kind !== "Node") return false;
    return ancestorInterfaces(doc, decl).includes(general) || unionsOf(doc, decl).includes(general);
  };
  const cover = pairs.find(([f, t]) => pairs.every(([f2, t2]) => covers(f, f2) && covers(t, t2)));
  if (!cover) {
    throw new SchemaValidationError(
      `Relationship "${r.name}": :${r.relType} edges link different pairs of nodes (${pairs.map(([f, t]) => `${f} to ${t}`).join(", ")}); give each pair its own block (relationship Name { type "${r.relType}" from A to B … }), or point the fields at a shared interface or union.`,
    );
  }
  return { from: cover[0], to: cover[1] };
}

/**
 * Give each node implementing interfaces (and each interface extending others) the fields,
 * `@@unique` keys and `@@fulltext` indexes it inherits (first, tagged with the declaring
 * interface in `inheritedFrom`) and every interface it inherits from, directly or not; give
 * each node its labels and each interface the nodes implementing it (directly or through the
 * interfaces extending it).
 */
function linkInterfaces(
  nodes: readonly ResolvedNodeModel[],
  doc: SchemaDocument,
): ResolvedNodeModel[] {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const declOf = new Map<string, NodeDeclaration>();
  for (const d of doc.declarations) if (d.kind === "Node") declOf.set(d.name, d);
  const hasParents = (n: string) => parentInterfaces(declOf.get(n)!).length > 0;
  if (!nodes.some((n) => n.abstract || hasParents(n.name))) return [...nodes];
  const tag = <T extends { readonly inheritedFrom?: string }>(x: T, from: string): T => ({
    ...x,
    inheritedFrom: x.inheritedFrom ?? from,
  });
  /** Items of the parents then `own`, each inherited one once (a diamond reaches it twice). */
  const merge = <T extends { readonly inheritedFrom?: string }>(
    parents: readonly ResolvedNodeModel[],
    pick: (m: ResolvedNodeModel) => readonly T[] | undefined,
    keyOf: (x: T) => string,
    own: readonly T[] | undefined,
  ): T[] => {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const p of parents) {
      for (const x of pick(p) ?? []) {
        const t = tag(x, p.name);
        const key = `${t.inheritedFrom}.${keyOf(t)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
      }
    }
    return [...out, ...(own ?? [])];
  };
  const linked = new Map<string, ResolvedNodeModel>();
  const link = (name: string): ResolvedNodeModel => {
    const done = linked.get(name);
    if (done) return done;
    const n = byName.get(name)!;
    const decl = declOf.get(name)!;
    const direct = parentInterfaces(decl);
    if (direct.length === 0) {
      linked.set(name, n);
      return n;
    }
    const parents = direct.map(link);
    const interfaces = ancestorInterfaces(doc, decl);
    const owner = nodeOwner(decl);
    const fields = merge(
      parents,
      (p) => p.fields,
      (f) => f.name,
      n.fields,
    );
    const compoundUniques = merge(
      parents,
      (p) => p.compoundUniques,
      (c) => c.key,
      n.compoundUniques,
    );
    const keys = new Set<string>();
    for (const c of compoundUniques) {
      if (keys.has(c.key) || fields.some((f) => f.name === c.key)) {
        throw new SchemaValidationError(
          `${owner} @@unique: key "${c.key}" is already a field or another @@unique key (give this one a name: "…").`,
        );
      }
      keys.add(c.key);
    }
    const fulltextIndexes = merge(
      parents,
      (p) => p.fulltextIndexes,
      (i) => i.name,
      n.fulltextIndexes,
    );
    const scalars = fields.filter((f): f is ResolvedScalarField => f.kind === "scalar");
    const idField = scalars.find((f) => f.id)?.name;
    const { label, compoundIndexes } = n;
    // The interfaces' dynamic labels first (in inheritance order), then the model's own.
    const dynamicLabels = [
      ...new Set([...parents.flatMap((p) => p.dynamicLabels ?? []), ...(n.dynamicLabels ?? [])]),
    ];
    const out: ResolvedNodeModel = {
      name,
      label,
      ...(n.abstract ? { abstract: true as const, extends: [...direct] } : {}),
      ...(dynamicLabels.length ? { dynamicLabels } : {}),
      interfaces,
      // An interface is matched by its own label; a node is written and matched with all of them.
      ...(n.abstract ? {} : { labels: [label, ...interfaces.map((i) => byName.get(i)!.label)] }),
      ...(idField ? { idField } : {}),
      uniqueFields: scalars.filter((f) => f.id || f.unique).map((f) => f.name),
      fields,
      ...(fulltextIndexes.length ? { fulltextIndexes } : {}),
      ...(compoundUniques.length ? { compoundUniques } : {}),
      ...(compoundIndexes?.length ? { compoundIndexes } : {}),
    };
    linked.set(name, out);
    return out;
  };
  const all = nodes.map((n) => link(n.name));
  return all.map((n) => {
    if (!n.abstract) return n;
    const implementations = all
      .filter((x) => !x.abstract && (x.interfaces ?? []).includes(n.name))
      .map((x) => x.name);
    const { name, label, ...rest } = n;
    return { name, label, abstract: true, implementations, ...rest };
  });
}

/**
 * Unions `decl` is a member of: named directly, or through an interface it inherits from (the
 * unions of an interface, for an interface).
 */
function unionsOf(doc: SchemaDocument, decl: NodeDeclaration): string[] {
  const names = [decl.name, ...ancestorInterfaces(doc, decl)];
  return doc.declarations
    .filter((u) => u.kind === "Union" && u.members.some((m) => names.includes(m)))
    .map((u) => u.name);
}

/**
 * `nodes` with the `union` declarations added as abstract models (no fields, no label of their
 * own, their members as `implementations`), every model in declaration order.
 */
function withUnions(nodes: readonly ResolvedNodeModel[], doc: SchemaDocument): ResolvedNodeModel[] {
  if (!doc.declarations.some((d) => d.kind === "Union")) return [...nodes];
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const out: ResolvedNodeModel[] = [];
  for (const d of doc.declarations) {
    if (d.kind === "Node") out.push(byName.get(d.name)!);
    else if (d.kind === "Union") {
      // An interface member stands for every node implementing it.
      const expand = (m: string) => {
        const n = byName.get(m)!;
        return n.abstract ? (n.implementations ?? []) : [m];
      };
      const withInterface = d.members.some((m) => byName.get(m)?.abstract);
      out.push({
        name: d.name,
        label: d.name,
        abstract: true,
        union: true,
        implementations: d.members.flatMap(expand),
        ...(withInterface ? { members: [...d.members] } : {}),
        uniqueFields: [],
        fields: [],
      });
    }
  }
  return out;
}

/**
 * Every label of a node model (`["Employee", "Person"]` for `node Employee implements Person`),
 * which its nodes are written and matched with; just `[label]` for an interface or a plain node.
 */
export function nodeLabels(model: ResolvedNodeModel): readonly string[] {
  return model.labels ?? [model.label];
}

/** Look up a node model by name. */
export function getNodeModel(model: SchemaModel, name: string): ResolvedNodeModel {
  const n = model.nodes.find((x) => x.name === name);
  if (!n) {
    throw new Error(`Unknown node model "${name}".`);
  }
  return n;
}
