import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveUnderRoot } from "./paths.js";

export type CyphraConfig = {
  readonly schema: string;
  readonly migrations: string;
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
  if (typeof schema !== "string" || typeof migrations !== "string") {
    throw new Error('cyphra.json requires string fields "schema" and "migrations"');
  }
  return {
    schema: resolveUnderRoot(cwd, schema),
    migrations: resolveUnderRoot(cwd, migrations),
  };
}
