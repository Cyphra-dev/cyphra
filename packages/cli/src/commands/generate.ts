import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseSchema, renderCyphraGenSource, validateSchema } from "@cyphra/schema";
import type { CyphraConfig } from "../config.js";

/**
 * Emit `cyphra.gen.ts` (or configured path) from the schema file.
 *
 * @param cwd - Project root.
 * @param config - Loaded config with absolute schema and output paths.
 */
export async function runGenerate(cwd: string, config: CyphraConfig): Promise<void> {
  const source = await readFile(config.schema, "utf8");
  const doc = parseSchema(source);
  validateSchema(doc);
  const out = renderCyphraGenSource(doc);
  await writeFile(config.generate, out, "utf8");
  console.log(`Wrote ${path.relative(cwd, config.generate)}`);
}
