import type {
  Decorator,
  DecoratorArg,
  EnumDeclaration,
  ModelAttribute,
  NodeDeclaration,
  RelationshipDeclaration,
  ScalarNodeField,
  ScalarTypeName,
  SchemaDocument,
} from "./ast.js";
import { SchemaValidationError } from "./errors.js";

/**
 * Built-in scalar type names a field can use as is (`String`, `Int?`, `Json`, …), in the order the
 * docs list them. `Vector(N)` takes a dimension and is not listed. Editor tooling (completion,
 * highlighting) reads this list, so a new type only needs adding here and in the grammar.
 */
export const SCALAR_TYPE_NAMES = [
  "String",
  "Int",
  "Float",
  "Boolean",
  "DateTime",
  "Date",
  "BigInt",
  "Json",
  "LocalDateTime",
  "LocalTime",
  "Time",
  "Duration",
  "Point",
  "CartesianPoint",
] as const satisfies readonly ScalarTypeName[];

/** Largest `Vector(N)` dimension count Neo4j 5 vector indexes accept. */
export const MAX_VECTOR_DIMENSIONS = 4096;

/** Similarity functions accepted by `@vectorIndex(similarity: …)`. */
export const VECTOR_SIMILARITIES = ["cosine", "euclidean"] as const;

/** Index names Cyphra emits unquoted in DDL. */
const INDEX_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Analyzers accepted by `@@fulltext(analyzer: …)`: the built-in list of Neo4j 5
 * (`CALL db.index.fulltext.listAvailableAnalyzers()`).
 */
export const FULLTEXT_ANALYZERS = [
  "arabic",
  "armenian",
  "basque",
  "brazilian",
  "bulgarian",
  "catalan",
  "cjk",
  "classic",
  "czech",
  "danish",
  "dutch",
  "email",
  "english",
  "finnish",
  "french",
  "galician",
  "german",
  "greek",
  "hindi",
  "hungarian",
  "indonesian",
  "irish",
  "italian",
  "keyword",
  "latvian",
  "lithuanian",
  "norwegian",
  "persian",
  "portuguese",
  "romanian",
  "russian",
  "simple",
  "sorani",
  "spanish",
  "standard",
  "standard-folding",
  "standard-no-stop-words",
  "stop",
  "swedish",
  "thai",
  "turkish",
  "unicode_whitespace",
  "url",
  "url_or_email",
  "whitespace",
] as const;

/** Analyzer Neo4j uses when a full-text index sets none (`fulltext.analyzer`). */
export const DEFAULT_FULLTEXT_ANALYZER = "standard-no-stop-words";

/** Model-level attributes `schema.cyphra` understands. */
const MODEL_ATTRIBUTES = ["fulltext", "unique", "index"] as const;

function argsOnce(where: string, attr: string, args: readonly DecoratorArg[]): void {
  const seen = new Set<string>();
  for (const a of args) {
    if (seen.has(a.key)) throw new SchemaValidationError(`${where}: ${attr} ${a.key} given twice.`);
    seen.add(a.key);
  }
}

/**
 * `@@fulltext([a, b], name: "…", analyzer: "…", eventuallyConsistent: false)`: at least one
 * field, each a `String` / `String[]` field of the model, listed once; known arguments only.
 */
function validateFulltext(where: string, decl: NodeDeclaration, attr: ModelAttribute): void {
  const fields = attr.fields;
  if (!fields || fields.length === 0) {
    throw new SchemaValidationError(
      `${where}: @@fulltext needs a list of String fields, e.g. @@fulltext([title, body]).`,
    );
  }
  const seen = new Set<string>();
  for (const name of fields) {
    if (seen.has(name)) {
      throw new SchemaValidationError(`${where}: @@fulltext lists field "${name}" twice.`);
    }
    seen.add(name);
    const f = decl.fields.find((x) => x.name === name);
    if (!f) {
      throw new SchemaValidationError(`${where}: @@fulltext field "${name}" does not exist.`);
    }
    if (f.kind !== "Scalar" || f.type.name !== "String") {
      throw new SchemaValidationError(
        `${where}: @@fulltext field "${name}" must be a String or String[] field.`,
      );
    }
  }
  argsOnce(where, "@@fulltext", attr.args);
  for (const a of attr.args) {
    if (a.key === "name") {
      if (a.value.kind !== "string" || !INDEX_NAME.test(a.value.value)) {
        throw new SchemaValidationError(
          `${where}: @@fulltext name must be a string of letters, digits and underscores (not starting with a digit).`,
        );
      }
    } else if (a.key === "analyzer") {
      const v = a.value;
      if (
        (v.kind !== "string" && v.kind !== "identifier") ||
        !(FULLTEXT_ANALYZERS as readonly string[]).includes(v.value)
      ) {
        throw new SchemaValidationError(
          `${where}: unknown @@fulltext analyzer ${JSON.stringify(String(v.value))} (expected one of ${FULLTEXT_ANALYZERS.join(", ")}).`,
        );
      }
    } else if (a.key === "eventuallyConsistent") {
      if (a.value.kind !== "boolean") {
        throw new SchemaValidationError(
          `${where}: @@fulltext eventuallyConsistent must be true or false.`,
        );
      }
    } else {
      throw new SchemaValidationError(
        `${where}: unknown @@fulltext argument "${a.key}" (expected name, analyzer, eventuallyConsistent).`,
      );
    }
  }
}

/**
 * `@@unique([a, b], name: "…")` / `@@index([a, b], name: "…")`: at least two fields, each an
 * existing scalar non-list field of the model (not `Json` or `Vector`), listed once; `name` only.
 */
function validateCompound(where: string, decl: NodeDeclaration, attr: ModelAttribute): void {
  const at = `@@${attr.name}`;
  const fields = attr.fields;
  const single = attr.name === "unique" ? "@unique" : "@index";
  if (!fields || fields.length < 2) {
    throw new SchemaValidationError(
      `${where}: ${at} needs a list of at least two fields, e.g. ${at}([a, b]) (for one field, use ${single} on the field).`,
    );
  }
  const seen = new Set<string>();
  for (const name of fields) {
    if (seen.has(name)) {
      throw new SchemaValidationError(`${where}: ${at} lists field "${name}" twice.`);
    }
    seen.add(name);
    const f = decl.fields.find((x) => x.name === name);
    if (!f) {
      throw new SchemaValidationError(`${where}: ${at} field "${name}" does not exist.`);
    }
    if (f.kind !== "Scalar") {
      throw new SchemaValidationError(
        `${where}: ${at} field "${name}" is a relation; only scalar fields can be ${attr.name === "unique" ? "constrained" : "indexed"}.`,
      );
    }
    if (f.type.list || f.type.name === "Json" || f.type.name === "Vector") {
      const t = f.type.name === "Vector" ? "Vector" : `${f.type.name}${f.type.list ? "[]" : ""}`;
      throw new SchemaValidationError(
        `${where}: ${at} field "${name}" must be a single scalar value (not ${t}).`,
      );
    }
  }
  argsOnce(where, at, attr.args);
  for (const a of attr.args) {
    if (a.key !== "name") {
      throw new SchemaValidationError(
        `${where}: unknown ${at} argument "${a.key}" (expected name).`,
      );
    }
    if (a.value.kind !== "string" || !INDEX_NAME.test(a.value.value)) {
      throw new SchemaValidationError(
        `${where}: ${at} name must be a string of letters, digits and underscores (not starting with a digit).`,
      );
    }
  }
}

/**
 * Model-level `@@…` attributes: known names only, on node models, with valid fields and
 * arguments; no two `@@unique` (or two `@@index`) over the same fields.
 */
export function validateModelAttributes(decl: NodeDeclaration | RelationshipDeclaration): void {
  const owner = decl.kind === "Node" ? nodeOwner(decl) : `Relationship "${decl.name}"`;
  for (const attr of decl.attributes ?? []) {
    const where = `${owner} @@${attr.name}`;
    if (!(MODEL_ATTRIBUTES as readonly string[]).includes(attr.name)) {
      throw new SchemaValidationError(
        `${owner}: unknown model attribute @@${attr.name} (expected ${MODEL_ATTRIBUTES.map((a) => `@@${a}`).join(", ")}).`,
      );
    }
    if (decl.kind !== "Node") {
      const what =
        attr.name === "fulltext"
          ? "full-text indexes are"
          : attr.name === "unique"
            ? "composite uniqueness constraints are"
            : "composite indexes are";
      throw new SchemaValidationError(
        `${where}: ${what} only supported on node models (not on relationships).`,
      );
    }
    if (attr.name === "fulltext") validateFulltext(owner, decl, attr);
    else validateCompound(owner, decl, attr);
  }
  // Uniqueness does not depend on field order; a composite index does (it serves its prefixes).
  const uniques = new Set<string>();
  const ordered = new Set<string>();
  const indexes = new Set<string>();
  for (const attr of decl.attributes ?? []) {
    if (attr.name !== "unique") continue;
    const set = JSON.stringify([...(attr.fields ?? [])].sort());
    if (uniques.has(set)) {
      throw new SchemaValidationError(
        `${owner} @@unique: fields [${(attr.fields ?? []).join(", ")}] are already covered by another @@unique.`,
      );
    }
    uniques.add(set);
    ordered.add(JSON.stringify(attr.fields ?? []));
  }
  for (const attr of decl.attributes ?? []) {
    if (attr.name !== "index") continue;
    const list = JSON.stringify(attr.fields ?? []);
    if (indexes.has(list) || ordered.has(list)) {
      throw new SchemaValidationError(
        `${owner} @@index: fields [${(attr.fields ?? []).join(", ")}] are already indexed by ${ordered.has(list) ? "a @@unique (its constraint has an index)" : "another @@index"}.`,
      );
    }
    indexes.add(list);
  }
}

/**
 * `Vector(N)` fields and `@vectorIndex(...)`: dimensions in range, vectors only on node fields,
 * no other decorator on a vector, valid index arguments.
 */
export function validateVectorField(owner: string, f: ScalarNodeField, onNode: boolean): void {
  const where = `${owner} field "${f.name}"`;
  const vectorIndexes = decoratorCount(f.decorators, "vectorIndex");
  if (f.type.name !== "Vector") {
    if (vectorIndexes > 0) {
      throw new SchemaValidationError(`${where}: @vectorIndex is only valid on Vector(N) fields.`);
    }
    return;
  }
  if (!onNode) {
    throw new SchemaValidationError(
      `${where}: Vector fields are only supported on node models (not on relationship properties).`,
    );
  }
  const dims = f.type.dimensions;
  if (dims === undefined || !Number.isInteger(dims) || dims < 1 || dims > MAX_VECTOR_DIMENSIONS) {
    throw new SchemaValidationError(
      `${where}: Vector dimensions must be an integer from 1 to ${MAX_VECTOR_DIMENSIONS} (got ${String(dims)}).`,
    );
  }
  for (const d of f.decorators) {
    if (d.name !== "vectorIndex") {
      throw new SchemaValidationError(
        `${where}: @${d.name} is not valid on a Vector field (only @vectorIndex is).`,
      );
    }
  }
  if (vectorIndexes > 1) {
    throw new SchemaValidationError(
      `${where}: at most one @vectorIndex allowed (found ${vectorIndexes}).`,
    );
  }
  const dec = f.decorators.find((d) => d.name === "vectorIndex");
  if (!dec) return;
  for (const a of dec.args) {
    if (a.key === "similarity") {
      if (
        a.value.kind !== "identifier" ||
        !(VECTOR_SIMILARITIES as readonly string[]).includes(a.value.value)
      ) {
        throw new SchemaValidationError(
          `${where}: @vectorIndex similarity must be ${VECTOR_SIMILARITIES.join(" or ")}.`,
        );
      }
    } else if (a.key === "quantization") {
      if (a.value.kind !== "boolean") {
        throw new SchemaValidationError(
          `${where}: @vectorIndex quantization must be true or false.`,
        );
      }
    } else if (a.key === "name") {
      if (a.value.kind !== "string" || !INDEX_NAME.test(a.value.value)) {
        throw new SchemaValidationError(
          `${where}: @vectorIndex name must be a string of letters, digits and underscores (not starting with a digit).`,
        );
      }
    } else {
      throw new SchemaValidationError(
        `${where}: unknown @vectorIndex argument "${a.key}" (expected similarity, name, quantization).`,
      );
    }
  }
  for (const key of ["similarity", "name", "quantization"]) {
    if (dec.args.filter((a) => a.key === key).length > 1) {
      throw new SchemaValidationError(`${where}: @vectorIndex ${key} given twice.`);
    }
  }
}

function hasDecoratorNamed(decorators: readonly Decorator[], name: string): boolean {
  return decorators.some((d) => d.name === name);
}

function countIdFields(node: NodeDeclaration): number {
  let n = 0;
  for (const f of node.fields) {
    if (f.kind === "Scalar" && hasDecoratorNamed(f.decorators, "id")) {
      n += 1;
    }
  }
  return n;
}

function decoratorCount(decorators: readonly Decorator[], name: string): number {
  return decorators.filter((d) => d.name === name).length;
}

/** Built-in type names, which an `enum` cannot reuse. */
const BUILTIN_TYPES: readonly string[] = [...SCALAR_TYPE_NAMES, "Vector"];

/** `enum X { … }`: not a built-in type name, at least one value, no duplicate value. */
export function validateEnum(decl: EnumDeclaration): void {
  const where = `Enum "${decl.name}"`;
  if (BUILTIN_TYPES.includes(decl.name)) {
    throw new SchemaValidationError(`${where}: ${decl.name} is a built-in type name.`);
  }
  if (decl.values.length === 0) {
    throw new SchemaValidationError(`${where}: an enum needs at least one value.`);
  }
  const seen = new Set<string>();
  for (const v of decl.values) {
    if (seen.has(v)) throw new SchemaValidationError(`${where}: duplicate value ${v}.`);
    seen.add(v);
  }
}

/** `Node "X"` or `Interface "X"`: how errors name a node declaration. */
export function nodeOwner(decl: NodeDeclaration): string {
  return `${decl.abstract ? "Interface" : "Node"} "${decl.name}"`;
}

/**
 * `node X implements A, B`: every name is a declared `interface` (named once), interfaces do not
 * implement others, no field is declared twice (by the node and an interface, or by two
 * interfaces), and at most one `@id` across them.
 */
export function validateImplements(doc: SchemaDocument, decl: NodeDeclaration): void {
  const names = decl.implements ?? [];
  if (names.length === 0) return;
  const owner = nodeOwner(decl);
  if (decl.abstract) {
    throw new SchemaValidationError(
      `${owner}: an interface cannot implement other interfaces (implements ${names.join(", ")}).`,
    );
  }
  const seen = new Set<string>();
  const fieldFrom = new Map<string, string>();
  let idFrom: string | undefined;
  for (const n of names) {
    if (seen.has(n)) throw new SchemaValidationError(`${owner}: implements ${n} twice.`);
    seen.add(n);
    const target = doc.declarations.find((d) => d.name === n);
    if (!target || target.kind !== "Node" || !target.abstract) {
      throw new SchemaValidationError(
        `${owner}: implements ${n}, which is not an interface${target ? "" : " (not declared)"}.`,
      );
    }
    for (const f of target.fields) {
      const other = fieldFrom.get(f.name);
      if (other) {
        throw new SchemaValidationError(
          `${owner}: field "${f.name}" is declared by both ${other} and ${n}.`,
        );
      }
      fieldFrom.set(f.name, n);
      if (f.kind === "Scalar" && hasDecoratorNamed(f.decorators, "id")) {
        if (idFrom) {
          throw new SchemaValidationError(
            `${owner}: ${idFrom} and ${n} both declare an @id field (a node has at most one).`,
          );
        }
        idFrom = n;
      }
    }
  }
  for (const f of decl.fields) {
    const from = fieldFrom.get(f.name);
    if (from) {
      throw new SchemaValidationError(
        `${owner} field "${f.name}": already inherited from interface ${from} (inherited fields cannot be redeclared).`,
      );
    }
    if (idFrom && f.kind === "Scalar" && hasDecoratorNamed(f.decorators, "id")) {
      throw new SchemaValidationError(
        `${owner} field "${f.name}": @id conflicts with the @id inherited from ${idFrom}.`,
      );
    }
  }
}

/**
 * `decl` with the fields it inherits from the interfaces it implements (first, in `implements`
 * order), as model attributes see them: `@@unique([email, tenant])` may name inherited fields.
 */
export function withInheritedFields(doc: SchemaDocument, decl: NodeDeclaration): NodeDeclaration {
  if (!decl.implements?.length) return decl;
  const inherited = decl.implements.flatMap((n) => {
    const d = doc.declarations.find((x) => x.name === n);
    return d?.kind === "Node" ? d.fields : [];
  });
  return { ...decl, fields: [...inherited, ...decl.fields] };
}

/**
 * Applies semantic rules that the grammar cannot express (e.g. a single `@id` per node).
 *
 * @param doc - Parsed document from {@link parseSchema} (parse phase only).
 * @throws {SchemaValidationError} When a rule is violated.
 */
export function validateSchema(doc: SchemaDocument): void {
  for (const decl of doc.declarations) {
    if (decl.kind === "Enum") {
      validateEnum(decl);
      continue;
    }
    if (decl.kind === "Node") {
      validateImplements(doc, decl);
      validateModelAttributes(withInheritedFields(doc, decl));
    } else {
      validateModelAttributes(decl);
    }
    if (decl.kind === "Node") {
      const idCount = countIdFields(decl);
      if (idCount > 1) {
        throw new SchemaValidationError(
          `${nodeOwner(decl)} must have at most one @id field (found ${idCount}).`,
        );
      }
      for (const f of decl.fields) {
        if (f.kind !== "Scalar") {
          continue;
        }
        validateVectorField(nodeOwner(decl), f, true);
        const idx = decoratorCount(f.decorators, "index");
        if (idx > 1) {
          throw new SchemaValidationError(
            `${nodeOwner(decl)} field "${f.name}": at most one @index allowed (found ${idx}).`,
          );
        }
        if (idx === 0) {
          continue;
        }
        if (hasDecoratorNamed(f.decorators, "unique")) {
          throw new SchemaValidationError(
            `${nodeOwner(decl)} field "${f.name}": @index is redundant with @unique (unique constraints are indexed).`,
          );
        }
        if (hasDecoratorNamed(f.decorators, "id")) {
          throw new SchemaValidationError(
            `${nodeOwner(decl)} field "${f.name}": @index is redundant with @id (id uniqueness is indexed).`,
          );
        }
      }
      continue;
    }

    for (const f of decl.fields) {
      validateVectorField(`Relationship "${decl.name}"`, f, false);
      const idx = decoratorCount(f.decorators, "index");
      const uniq = decoratorCount(f.decorators, "unique");
      if (idx > 1) {
        throw new SchemaValidationError(
          `Relationship "${decl.name}" field "${f.name}": at most one @index allowed (found ${idx}).`,
        );
      }
      if (uniq > 1) {
        throw new SchemaValidationError(
          `Relationship "${decl.name}" field "${f.name}": at most one @unique allowed (found ${uniq}).`,
        );
      }
      if (idx > 0 && uniq > 0) {
        throw new SchemaValidationError(
          `Relationship "${decl.name}" field "${f.name}": @index is redundant with @unique (unique constraints are indexed).`,
        );
      }
      if (hasDecoratorNamed(f.decorators, "id")) {
        throw new SchemaValidationError(
          `Relationship "${decl.name}" field "${f.name}": @id is only valid on node scalar fields.`,
        );
      }
    }
  }
}
