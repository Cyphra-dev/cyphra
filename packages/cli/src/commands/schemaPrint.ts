import { readFile } from "node:fs/promises";
import { parseSchema, printSchemaDocument, validateSchema } from "@cyphra/schema";
import type { CyphraConfig } from "../config.js";

/**
 * Print a canonical `.cyphra` rendering of the schema to stdout.
 *
 * @param config - Config with absolute schema path.
 */
export async function runSchemaPrint(config: CyphraConfig): Promise<void> {
  const raw = await readFile(config.schema, "utf8");
  const doc = parseSchema(raw);
  validateSchema(doc);
  process.stdout.write(printSchemaDocument(doc));
}
