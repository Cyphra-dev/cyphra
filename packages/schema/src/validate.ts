import type { Decorator, NodeDeclaration, SchemaDocument } from "./ast.js";
import { SchemaValidationError } from "./errors.js";

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
      if (hasDecoratorNamed(f.decorators, "index")) {
        throw new SchemaValidationError(
          `Relationship "${decl.name}" field "${f.name}": @index on relationship properties is not supported yet (use a migration with a relationship index).`,
        );
      }
    }
  }
}
