import type { ParseSchemaOptions, SchemaDocument } from "./ast.js";
import { SchemaValidationError } from "./errors.js";
import { parse as pegParse } from "./generated/parser.js";
import { validateSchema } from "./validate.js";

/** Maximum `.cyphra` source size accepted by {@link parseSchema} (mitigates parser DoS). */
export const MAX_SCHEMA_BYTES = 512 * 1024;

/**
 * Parse a Cyphra schema string into an AST without semantic validation (grammar only). Editor
 * tooling uses it with `{ locations: true }` to get source ranges even for a schema that fails
 * {@link validateSchema}.
 *
 * @param source - Full contents of a `.cyphra` file (UTF-8).
 * @param options - `locations: true` records source ranges and comments.
 * @throws {SyntaxError} From Peggy when the text does not match the grammar (check `location`).
 * @throws {SchemaValidationError} When the source exceeds {@link MAX_SCHEMA_BYTES}.
 */
export function parseSchemaSyntax(source: string, options?: ParseSchemaOptions): SchemaDocument {
  const bytes = new TextEncoder().encode(source).byteLength;
  if (bytes > MAX_SCHEMA_BYTES) {
    throw new SchemaValidationError(
      `Schema exceeds maximum size of ${MAX_SCHEMA_BYTES} bytes (got ${bytes}).`,
    );
  }
  return pegParse(source, { locations: options?.locations === true }) as SchemaDocument;
}

/**
 * Parse a Cyphra schema string into an AST and run semantic validation.
 *
 * @param source - Full contents of a `.cyphra` file (UTF-8).
 * @param options - `locations: true` records source ranges and comments on the AST.
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
export function parseSchema(source: string, options?: ParseSchemaOptions): SchemaDocument {
  const doc = parseSchemaSyntax(source, options);
  validateSchema(doc);
  return doc;
}
