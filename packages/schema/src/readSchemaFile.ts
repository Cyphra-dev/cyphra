import type { SchemaDocument } from "./ast.js";
import { parseSchema } from "./parseSchema.js";

/**
 * `node:fs/promises`, loaded on first use. The specifier is not a literal so bundlers for edge
 * runtimes (Vercel Edge, Cloudflare Workers), which have no file system, leave it alone: the rest of
 * the package stays free of Node built-ins.
 */
const FS_PROMISES = "node:fs/promises";

/**
 * Read a UTF-8 `.cyphra` file from disk and {@link parseSchema parse} + validate it (Node.js, Deno,
 * Bun).
 *
 * @param path - Absolute or relative file path.
 */
export async function parseSchemaFile(path: string): Promise<SchemaDocument> {
  const { readFile } = (await import(
    /* webpackIgnore: true */ /* @vite-ignore */ FS_PROMISES
  )) as typeof import("node:fs/promises");
  const source = await readFile(path, "utf8");
  return parseSchema(source);
}
