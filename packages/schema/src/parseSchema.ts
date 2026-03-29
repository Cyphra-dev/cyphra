import { Buffer } from "node:buffer";
import type { SchemaDocument } from "./ast.js";
import { SchemaValidationError } from "./errors.js";
import { parse as pegParse } from "./generated/parser.js";
import { validateSchema } from "./validate.js";

/** Maximum `.cyphra` source size accepted by {@link parseSchema} (mitigates parser DoS). */
export const MAX_SCHEMA_BYTES = 512 * 1024;

/**
 * Parse a Cyphra schema string into an AST and run semantic validation.
 *
 * @param source - Full contents of a `.cyphra` file (UTF-8).
 * @returns Validated {@link SchemaDocument}.
 * @throws {SyntaxError} From Peggy when the text does not match the grammar (check `location`).
 * @throws {SchemaValidationError} When semantic rules fail.
 *
 * @example
 * ```ts
 * const doc = parseSchema(`
 *   node User {
 *     id String @id @default(cuid())
 *   }
 * `);
 * ```
 */
export function parseSchema(source: string): SchemaDocument {
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > MAX_SCHEMA_BYTES) {
    throw new SchemaValidationError(
      `Schema exceeds maximum size of ${MAX_SCHEMA_BYTES} bytes (got ${bytes}).`,
    );
  }
  const doc = pegParse(source) as SchemaDocument;
  validateSchema(doc);
  return doc;
}
