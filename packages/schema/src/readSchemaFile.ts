import { readFile } from "node:fs/promises";
import type { SchemaDocument } from "./ast.js";
import { parseSchema } from "./parseSchema.js";

/**
 * Read a UTF-8 `.cyphra` file from disk and {@link parseSchema parse} + validate it.
 *
 * @param path - Absolute or relative file path.
 */
export async function parseSchemaFile(path: string): Promise<SchemaDocument> {
  const source = await readFile(path, "utf8");
  return parseSchema(source);
}
