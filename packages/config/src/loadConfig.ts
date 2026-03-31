import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertGraphProviderId,
  DEFAULT_GRAPH_PROVIDER,
  type CyphraUserConfig,
  type GraphProviderId,
} from "@cyphra/core";
import { createJiti } from "jiti";
import { resolveUnderRoot } from "./paths.js";

export type CyphraConfig = {
  readonly provider: GraphProviderId;
  readonly schema: string;
  readonly migrations: string;
};

async function fileExists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return false;
    throw e;
  }
}

function fileExistsSync(file: string): boolean {
  return existsSync(file);
}

/**
 * `migrations: "./dir"` or `migrations: { path: "./dir" }`.
 */
export function coerceMigrationsPath(migrations: unknown, ctx: string): string {
  if (typeof migrations === "string") {
    return migrations;
  }
  if (migrations && typeof migrations === "object" && !Array.isArray(migrations)) {
    const p = (migrations as Record<string, unknown>).path;
    if (typeof p === "string") {
      return p;
    }
  }
  throw new Error(`${ctx}: migrations must be a string or { path: string }`);
}

function providerFromRecord(rec: Record<string, unknown>): GraphProviderId | undefined {
  if (typeof rec.provider === "string") {
    return assertGraphProviderId(rec.provider);
  }
  const ds = rec.datasource;
  if (ds && typeof ds === "object" && !Array.isArray(ds)) {
    const p = (ds as Record<string, unknown>).provider;
    if (typeof p === "string") {
      return assertGraphProviderId(p);
    }
  }
  return undefined;
}

function migrationsRelativePath(user: CyphraUserConfig): string {
  if (typeof user.migrations === "string") {
    return user.migrations;
  }
  return user.migrations.path;
}

function resolveProvider(user: CyphraUserConfig): GraphProviderId | undefined {
  if (user.provider !== undefined) {
    return user.provider;
  }
  return user.datasource?.provider;
}

function normalizeUserConfig(
  cwd: string,
  user: CyphraUserConfig,
): Omit<CyphraConfig, "provider"> & { provider?: GraphProviderId } {
  return {
    schema: resolveUnderRoot(cwd, user.schema),
    migrations: resolveUnderRoot(cwd, migrationsRelativePath(user)),
    provider: resolveProvider(user),
  };
}

function finalizeConfig(
  cwd: string,
  user: CyphraUserConfig,
): CyphraConfig {
  const n = normalizeUserConfig(cwd, user);
  const provider: GraphProviderId = n.provider ?? DEFAULT_GRAPH_PROVIDER;
  return {
    provider,
    schema: n.schema,
    migrations: n.migrations,
  };
}

function userConfigFromRecord(rec: Record<string, unknown>, ctx: string): CyphraUserConfig {
  const schema = rec.schema;
  if (typeof schema !== "string") {
    throw new Error(`${ctx}: schema must be a string`);
  }
  const migrations = coerceMigrationsPath(rec.migrations, ctx);
  return {
    schema,
    migrations,
    provider: providerFromRecord(rec),
    targetNeo4j: typeof rec.targetNeo4j === "string" ? rec.targetNeo4j : undefined,
  };
}

const CONFIG_TS_NAMES = [
  "cyphra.config.ts",
  "cyphra.config.mts",
  "cyphra.config.cts",
  "cyphra.config.js",
  "cyphra.config.mjs",
  "cyphra.config.cjs",
] as const;

function loadTsConfigFile(configPath: string, basename: string): CyphraUserConfig {
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
  });
  const mod = jiti(configPath) as { default?: unknown } & Record<string, unknown>;
  const raw = (mod.default ?? mod) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${basename} must export a config object (use defineCyphraConfig)`);
  }
  return userConfigFromRecord(raw as Record<string, unknown>, basename);
}

/**
 * Load `cyphra.config.ts` / `.mts` / `.js` / `.mjs` / `.cjs` if present, else `cyphra.json`.
 *
 * @param cwd - Project root (absolute).
 */
export async function loadConfig(cwd: string): Promise<CyphraConfig> {
  for (const name of CONFIG_TS_NAMES) {
    const configPath = path.join(cwd, name);
    if (await fileExists(configPath)) {
      const user = loadTsConfigFile(configPath, name);
      return finalizeConfig(cwd, user);
    }
  }

  return loadJsonConfig(cwd);
}

/**
 * Synchronous variant of {@link loadConfig} for Node runtimes (e.g. lazy `CyphraClient.orm`).
 *
 * @param cwd - Project root (absolute).
 */
export function loadConfigSync(cwd: string): CyphraConfig {
  for (const name of CONFIG_TS_NAMES) {
    const configPath = path.join(cwd, name);
    if (fileExistsSync(configPath)) {
      const user = loadTsConfigFile(configPath, name);
      return finalizeConfig(cwd, user);
    }
  }

  return loadJsonConfigSync(cwd);
}

async function loadJsonConfig(cwd: string): Promise<CyphraConfig> {
  const configPath = path.join(cwd, "cyphra.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(
        `No cyphra.json or cyphra.config.ts in ${cwd}. Run \`cyphra init\` or add cyphra.config.ts.`,
      );
    }
    throw e;
  }
  return parseJsonConfigString(cwd, configPath, raw);
}

function loadJsonConfigSync(cwd: string): CyphraConfig {
  const configPath = path.join(cwd, "cyphra.json");
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(
        `No cyphra.json or cyphra.config.ts in ${cwd}. Run \`cyphra init\` or add cyphra.config.ts.`,
      );
    }
    throw e;
  }
  return parseJsonConfigString(cwd, configPath, raw);
}

function parseJsonConfigString(cwd: string, configPath: string, raw: string): CyphraConfig {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${configPath}: ${e.message}`);
    }
    throw e;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("cyphra.json must be a JSON object");
  }
  const rec = data as Record<string, unknown>;
  const user = userConfigFromRecord(rec, "cyphra.json");
  return finalizeConfig(cwd, user);
}
