import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LoadedMigration, MigrationDefinition } from "@cyphra/migrator";

function assertDirUnderRoot(dir: string, root: string): void {
  const absRoot = path.resolve(root);
  const absDir = path.resolve(dir);
  const rel = path.relative(absRoot, absDir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Migrations directory must be inside the project root");
  }
}

/**
 * Load sorted `.js` / `.mjs` migration modules from a directory.
 *
 * @param migrationsDir - Absolute migrations directory (from config).
 * @param root - Project root for validation.
 */
export async function loadMigrationsFromDir(
  migrationsDir: string,
  root: string,
): Promise<LoadedMigration[]> {
  assertDirUnderRoot(migrationsDir, root);
  const entries = await readdir(migrationsDir);
  const files = entries.filter((f) => f.endsWith(".js") || f.endsWith(".mjs")).sort();
  const out: LoadedMigration[] = [];
  for (const f of files) {
    const full = path.join(migrationsDir, f);
    const src = await readFile(full, "utf8");
    const checksum = createHash("sha256").update(src).digest("hex");
    const href = pathToFileURL(full).href;
    const mod = (await import(href)) as { default?: MigrationDefinition };
    const def = mod.default;
    if (!def?.name || typeof def.up !== "function") {
      throw new Error(`Migration ${f} must export default defineMigration({ name, up })`);
    }
    out.push({ name: def.name, checksum, definition: def });
  }
  return out;
}
