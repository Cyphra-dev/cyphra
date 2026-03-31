import { parseSchemaAt, readSchemaFileUtf8 } from "../schemaSource.js";
import type { CyphraConfig } from "@cyphra/config";

/**
 * Parse and semantically validate `schema.cyphra`.
 *
 * @param cwd - Project root (for relative log paths).
 * @param config - Config with absolute schema path.
 */
export async function runValidateSchema(cwd: string, config: CyphraConfig): Promise<void> {
  const { rel, raw } = await readSchemaFileUtf8(cwd, config);
  const doc = parseSchemaAt(rel, raw);
  console.log(`OK — ${rel} (${doc.declarations.length} declaration(s))`);
}
