import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SchemaDocument } from "./ast.js";
import { parseSchema } from "./parseSchema.js";

/**
 * Read a UTF-8 `.cyphra` file from disk and {@link parseSchema parse} + validate it.
 *
 * @param filePath - Absolute or relative file path.
 * @throws When the file is missing (`ENOENT`), or when parse/validation fails (message is `<basename>: …` with {@link Error.cause}).
 */
export async function parseSchemaFile(filePath: string): Promise<SchemaDocument> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(`Schema file not found: ${filePath}`);
    }
    throw e;
  }
  const label = path.basename(filePath);
  try {
    return parseSchema(source);
  } catch (e) {
    const inner = e instanceof Error ? e.message : String(e);
    throw new Error(`${label}: ${inner}`, { cause: e });
  }
}
