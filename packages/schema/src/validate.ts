import type { Decorator, NodeDeclaration, ScalarNodeField, SchemaDocument } from "./ast.js";
import { SchemaValidationError } from "./errors.js";

/** Largest `Vector(N)` dimension count Neo4j 5 vector indexes accept. */
export const MAX_VECTOR_DIMENSIONS = 4096;

/** Similarity functions accepted by `@vectorIndex(similarity: …)`. */
export const VECTOR_SIMILARITIES = ["cosine", "euclidean"] as const;

/** Index names Cyphra emits unquoted in DDL. */
const INDEX_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

/**
 * Applies semantic rules that the grammar cannot express (e.g. a single `@id` per node).
 *
 * @param doc - Parsed document from {@link parseSchema} (parse phase only).
 * @throws {SchemaValidationError} When a rule is violated.
 */
export function validateSchema(doc: SchemaDocument): void {
  for (const decl of doc.declarations) {
    if (decl.kind === "Node") {
      const idCount = countIdFields(decl);
      if (idCount > 1) {
        throw new SchemaValidationError(
          `Node "${decl.name}" must have at most one @id field (found ${idCount}).`,
        );
      }
      for (const f of decl.fields) {
        if (f.kind !== "Scalar") {
          continue;
        }
        validateVectorField(`Node "${decl.name}"`, f, true);
        const idx = decoratorCount(f.decorators, "index");
        if (idx > 1) {
          throw new SchemaValidationError(
            `Node "${decl.name}" field "${f.name}": at most one @index allowed (found ${idx}).`,
          );
        }
        if (idx === 0) {
          continue;
        }
        if (hasDecoratorNamed(f.decorators, "unique")) {
          throw new SchemaValidationError(
            `Node "${decl.name}" field "${f.name}": @index is redundant with @unique (unique constraints are indexed).`,
          );
        }
        if (hasDecoratorNamed(f.decorators, "id")) {
          throw new SchemaValidationError(
            `Node "${decl.name}" field "${f.name}": @index is redundant with @id (id uniqueness is indexed).`,
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
