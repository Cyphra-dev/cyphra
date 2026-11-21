import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveUnderRoot } from "./paths.js";

export type CyphraConfig = {
  readonly schema: string;
  readonly migrations: string;
  /** Absolute path for `cyphra generate` output (default `./cyphra.gen.ts`). */
  readonly generate: string;
  /** Module the generated client imports from (default `"cyphra"`). */
  readonly runtimeImport: string;
  /**
   * Shell command run by `cyphra db seed` and after `cyphra migrate reset` (e.g. `"tsx seed.ts"`),
   * from the project root. Absent when not configured.
   */
  readonly seed?: string;
};

/**
 * Load `cyphra.json` from the working directory.
 *
 * @param cwd - Current working directory (absolute).
 */
export async function loadConfig(cwd: string): Promise<CyphraConfig> {
  const configPath = path.join(cwd, "cyphra.json");
  const raw = await readFile(configPath, "utf8");
  const data = JSON.parse(raw) as unknown;
  if (!data || typeof data !== "object") {
    throw new Error("cyphra.json must be a JSON object");
  }
  const schema = (data as Record<string, unknown>).schema;
  const migrations = (data as Record<string, unknown>).migrations;
  const generateRaw = (data as Record<string, unknown>).generate;
  if (typeof schema !== "string" || typeof migrations !== "string") {
    throw new Error('cyphra.json requires string fields "schema" and "migrations"');
  }
  const generatePath = typeof generateRaw === "string" ? generateRaw : "./cyphra.gen.ts";
  const runtimeImportRaw = (data as Record<string, unknown>).runtimeImport;
  if (runtimeImportRaw !== undefined && typeof runtimeImportRaw !== "string") {
    throw new Error('cyphra.json "runtimeImport" must be a string');
  }
  const seedRaw = (data as Record<string, unknown>).seed;
  if (seedRaw !== undefined && (typeof seedRaw !== "string" || seedRaw.trim() === "")) {
    throw new Error('cyphra.json "seed" must be a non-empty command string (e.g. "tsx seed.ts")');
  }
  return {
    schema: resolveUnderRoot(cwd, schema),
    migrations: resolveUnderRoot(cwd, migrations),
    generate: resolveUnderRoot(cwd, generatePath),
    runtimeImport: runtimeImportRaw ?? "cyphra",
    ...(seedRaw !== undefined ? { seed: seedRaw.trim() } : {}),
  };
}
