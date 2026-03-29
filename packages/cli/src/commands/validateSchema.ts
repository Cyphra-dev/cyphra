import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseSchema, validateSchema } from "@cyphra/schema";
import type { CyphraConfig } from "../config.js";

/**
 * Parse and semantically validate `schema.cyphra`.
 *
 * @param cwd - Project root (for relative log paths).
 * @param config - Config with absolute schema path.
 */
export async function runValidateSchema(cwd: string, config: CyphraConfig): Promise<void> {
  const raw = await readFile(config.schema, "utf8");
  const doc = parseSchema(raw);
  validateSchema(doc);
  const rel = path.relative(cwd, config.schema);
  console.log(`OK — ${rel} (${doc.declarations.length} declaration(s))`);
}
