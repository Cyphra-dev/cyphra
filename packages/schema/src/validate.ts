import type {
  Decorator,
  DecoratorArg,
  EnumDeclaration,
  ModelAttribute,
  NodeField,
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
const MODEL_ATTRIBUTES = ["fulltext", "unique", "index", "labels"] as const;

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
 * `@@labels([Archived, Featured])`: the dynamic labels a node may carry (added and removed at
 * runtime), at least one, each listed once, no arguments, one `@@labels` per model. Clashes with
 * model names are checked by {@link validateDynamicLabels}, which sees the whole document.
 */
function validateLabelsAttribute(where: string, attr: ModelAttribute, count: number): void {
  const labels = attr.fields;
  if (count > 1) {
    throw new SchemaValidationError(
      `${where}: @@labels is given ${count} times (list every dynamic label in one @@labels([…])).`,
    );
  }
  if (!labels || labels.length === 0) {
    throw new SchemaValidationError(
      `${where}: @@labels needs a list of label names, e.g. @@labels([Archived, Featured]).`,
    );
  }
  const seen = new Set<string>();
  for (const l of labels) {
    if (seen.has(l)) throw new SchemaValidationError(`${where}: @@labels lists ${l} twice.`);
    seen.add(l);
  }
  if (attr.args.length) {
    throw new SchemaValidationError(
      `${where}: @@labels takes no arguments (only the list of labels: @@labels([${labels.join(", ")}])).`,
    );
  }
}

/**
 * Dynamic labels (`@@labels([...])`) cannot be the label of a model (a node or an interface):
 * a node carrying it would also match that model. Labels starting with `__` are reserved.
 */
export function validateDynamicLabels(doc: SchemaDocument, decl: NodeDeclaration): void {
  const models = new Set(doc.declarations.filter((d) => d.kind === "Node").map((d) => d.name));
  for (const attr of decl.attributes ?? []) {
    if (attr.name !== "labels") continue;
    for (const l of attr.fields ?? []) {
      if (models.has(l)) {
        const kind = doc.declarations.find((d) => d.kind === "Node" && d.name === l) as
          NodeDeclaration | undefined;
        throw new SchemaValidationError(
          `${nodeOwner(decl)} @@labels: ${l} is the label of ${kind?.abstract ? "interface" : "node"} ${l}; a dynamic label must not be a model's label${kind?.abstract ? ` (to add the interface to every ${decl.name}, write \`implements ${l}\`)` : ""}.`,
        );
      }
      if (l.startsWith("__")) {
        throw new SchemaValidationError(
          `${nodeOwner(decl)} @@labels: ${l} starts with "__", which is reserved for Cyphra's own labels.`,
        );
      }
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
            : attr.name === "labels"
              ? "dynamic labels are"
              : "composite indexes are";
      throw new SchemaValidationError(
        `${where}: ${what} only supported on node models (not on relationships).`,
      );
    }
    if (attr.name === "fulltext") validateFulltext(owner, decl, attr);
    else if (attr.name === "labels") {
      const count = (decl.attributes ?? []).filter((a) => a.name === "labels").length;
      validateLabelsAttribute(owner, attr, count);
    } else validateCompound(owner, decl, attr);
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

/** Interfaces a declaration names directly: `implements` of a node, `extends` of an interface. */
export function parentInterfaces(decl: NodeDeclaration): readonly string[] {
  return decl.abstract ? (decl.extends ?? []) : (decl.implements ?? []);
}

function interfaceDecl(doc: SchemaDocument, name: string): NodeDeclaration | undefined {
  const d = doc.declarations.find((x) => x.name === name);
  return d?.kind === "Node" && d.abstract ? d : undefined;
}

/**
 * Every interface `decl` inherits from, directly or through the interfaces it extends: each
 * parent, then that parent's own ancestors (depth first, each once). Undeclared names and cycles
 * are skipped (validation reports them).
 */
export function ancestorInterfaces(doc: SchemaDocument, decl: NodeDeclaration): string[] {
  const out: string[] = [];
  const visit = (d: NodeDeclaration) => {
    for (const n of parentInterfaces(d)) {
      if (out.includes(n) || n === decl.name) continue;
      const target = interfaceDecl(doc, n);
      if (!target) continue;
      out.push(n);
      visit(target);
    }
  };
  visit(decl);
  return out;
}

/**
 * The fields `decl` inherits, each with the interface declaring it, in inheritance order (each
 * parent's inherited fields, then its own). A field reached twice through a diamond (`A` extended
 * by `B` and `C`, both implemented by `X`) is listed once.
 */
export function inheritedFieldsOf(
  doc: SchemaDocument,
  decl: NodeDeclaration,
): { readonly field: NodeField; readonly from: string }[] {
  const out: { field: NodeField; from: string }[] = [];
  const seen = new Set<string>();
  const visit = (d: NodeDeclaration, path: readonly string[]) => {
    for (const n of parentInterfaces(d)) {
      const target = interfaceDecl(doc, n);
      if (!target || path.includes(n)) continue;
      visit(target, [...path, n]);
      for (const field of target.fields) {
        const key = `${n}.${field.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ field, from: n });
      }
    }
  };
  visit(decl, [decl.name]);
  return out;
}

/**
 * `node X implements A, B` / `interface B extends A`: every name is a declared `interface` (named
 * once), a node only `implements` and an interface only `extends`, no interface extends itself
 * (directly or through others), no field is declared twice (by the declaration and an interface,
 * or by two interfaces), and at most one `@id` across them.
 */
export function validateImplements(doc: SchemaDocument, decl: NodeDeclaration): void {
  const owner = nodeOwner(decl);
  if (decl.abstract && decl.implements?.length) {
    throw new SchemaValidationError(
      `${owner}: an interface extends other interfaces (write \`interface ${decl.name} extends ${decl.implements.join(", ")}\`).`,
    );
  }
  if (!decl.abstract && decl.extends?.length) {
    throw new SchemaValidationError(
      `${owner}: a node implements interfaces (write \`node ${decl.name} implements ${decl.extends.join(", ")}\`).`,
    );
  }
  const names = parentInterfaces(decl);
  if (names.length === 0) return;
  const verb = decl.abstract ? "extends" : "implements";
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) throw new SchemaValidationError(`${owner}: ${verb} ${n} twice.`);
    seen.add(n);
    const target = doc.declarations.find((d) => d.name === n);
    if (!target || target.kind !== "Node" || !target.abstract) {
      throw new SchemaValidationError(
        `${owner}: ${verb} ${n}, which is not an interface${target ? "" : " (not declared)"}.`,
      );
    }
  }
  if (decl.abstract) {
    // A cycle: walk the `extends` graph from each parent looking for `decl`.
    const cycle = (from: string, path: readonly string[]): string[] | null => {
      if (from === decl.name) return [...path, from];
      if (path.includes(from)) return null;
      for (const n of interfaceDecl(doc, from)?.extends ?? []) {
        const c = cycle(n, [...path, from]);
        if (c) return c;
      }
      return null;
    };
    for (const n of names) {
      const c = cycle(n, [decl.name]);
      if (c) {
        throw new SchemaValidationError(
          `${owner}: interfaces cannot extend themselves (${c.join(" extends ")}).`,
        );
      }
    }
  }
  const fieldFrom = new Map<string, string>();
  let idFrom: string | undefined;
  for (const { field: f, from } of inheritedFieldsOf(doc, decl)) {
    const other = fieldFrom.get(f.name);
    if (other) {
      throw new SchemaValidationError(
        `${owner}: field "${f.name}" is declared by both ${other} and ${from}.`,
      );
    }
    fieldFrom.set(f.name, from);
    if (f.kind === "Scalar" && hasDecoratorNamed(f.decorators, "id")) {
      if (idFrom) {
        throw new SchemaValidationError(
          `${owner}: ${idFrom} and ${from} both declare an @id field (a node has at most one).`,
        );
      }
      idFrom = from;
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
 * `decl` with the fields it inherits from its interfaces (first, in inheritance order), as model
 * attributes see them: `@@unique([email, tenant])` may name inherited fields.
 */
export function withInheritedFields(doc: SchemaDocument, decl: NodeDeclaration): NodeDeclaration {
  if (parentInterfaces(decl).length === 0) return decl;
  const inherited = inheritedFieldsOf(doc, decl).map((x) => x.field);
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
      validateDynamicLabels(doc, decl);
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
