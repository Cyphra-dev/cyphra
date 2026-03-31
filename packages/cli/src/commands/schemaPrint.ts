import { printSchemaDocument } from "@cyphra/schema";
import type { CyphraConfig } from "@cyphra/config";
import { parseSchemaAt, readSchemaFileUtf8 } from "../schemaSource.js";

/**
 * Print a canonical `.cyphra` rendering of the schema to stdout.
 *
 * @param cwd - Project root (for error messages).
 * @param config - Config with absolute schema path.
 */
export async function runSchemaPrint(cwd: string, config: CyphraConfig): Promise<void> {
  const { rel, raw } = await readSchemaFileUtf8(cwd, config);
  const doc = parseSchemaAt(rel, raw);
  process.stdout.write(printSchemaDocument(doc));
}
