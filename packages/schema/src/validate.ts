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

/**
 * Applies semantic rules that the grammar cannot express (e.g. a single `@id` per node).
 *
 * @param doc - Parsed document from {@link parseSchema} (parse phase only).
 * @throws {SchemaValidationError} When a rule is violated.
 */
export function validateSchema(doc: SchemaDocument): void {
  for (const decl of doc.declarations) {
    if (decl.kind !== "Node") {
      continue;
    }
    const idCount = countIdFields(decl);
    if (idCount > 1) {
      throw new SchemaValidationError(
        `Node "${decl.name}" must have at most one @id field (found ${idCount}).`,
      );
    }
  }
}
