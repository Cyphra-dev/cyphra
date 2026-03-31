import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseSchema, type SchemaDocument } from "@cyphra/schema";
import type { CyphraConfig } from "@cyphra/config";

/** Best-effort path for CLI messages (relative to project root when inside it). */
export function schemaRelativePath(cwd: string, config: CyphraConfig): string {
  const rel = path.relative(cwd, config.schema);
  return rel.length > 0 ? rel : path.basename(config.schema);
}

/**
 * Read the configured schema file as UTF-8, with ENOENT mapped to a clear message.
 */
export async function readSchemaFileUtf8(
  cwd: string,
  config: CyphraConfig,
): Promise<{ rel: string; raw: string }> {
  const rel = schemaRelativePath(cwd, config);
  try {
    const raw = await readFile(config.schema, "utf8");
    return { rel, raw };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(`Schema file not found: ${rel} (${config.schema})`);
    }
    throw e;
  }
}

/**
 * {@link parseSchema} with errors prefixed by the schema path shown to the user.
 */
export function parseSchemaAt(rel: string, raw: string): SchemaDocument {
  try {
    return parseSchema(raw);
  } catch (e) {
    const inner = e instanceof Error ? e.message : String(e);
    throw new Error(`${rel}: ${inner}`, { cause: e });
  }
}
