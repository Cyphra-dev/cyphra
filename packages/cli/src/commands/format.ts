import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatSchema } from "@cyphra/schema";
import type { CyphraConfig } from "../config.js";

/**
 * Reformat `schema.cyphra` in place, keeping comments (`formatSchema`). With `check`, write
 * nothing and return 1 when the file is not formatted (for CI).
 *
 * @param cwd - Project root (for relative log paths).
 * @param config - Config with absolute schema path.
 * @param opts - `check`: report instead of writing.
 * @returns Process exit code.
 */
export async function runFormat(
  cwd: string,
  config: CyphraConfig,
  opts: { check?: boolean } = {},
): Promise<number> {
  const raw = await readFile(config.schema, "utf8");
  const formatted = formatSchema(raw);
  const rel = path.relative(cwd, config.schema);
  if (formatted === raw) {
    console.log(`${rel} is formatted.`);
    return 0;
  }
  if (opts.check) {
    console.error(`${rel} is not formatted (run \`cyphra format\`).`);
    return 1;
  }
  await writeFile(config.schema, formatted, "utf8");
  console.log(`Formatted ${rel}.`);
  return 0;
}
