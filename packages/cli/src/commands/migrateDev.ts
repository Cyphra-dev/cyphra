import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EMPTY_SCHEMA_MODEL,
  diffSchemaModels,
  isEmptyPlan,
  renderMigrationSource,
  type MigrationPlan,
} from "@cyphra/migrator";
import { parseSchema, resolveSchema, type SchemaModel } from "@cyphra/schema";
import type { CyphraConfig } from "../config.js";

/** File (inside the migrations directory) holding the schema as of the latest migration. */
export const SNAPSHOT_FILE = "schema.snapshot.json";

export async function readSnapshot(config: CyphraConfig): Promise<SchemaModel | null> {
  try {
    const raw = await readFile(path.join(config.migrations, SNAPSHOT_FILE), "utf8");
    return JSON.parse(raw) as SchemaModel;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function currentModel(config: CyphraConfig): Promise<SchemaModel> {
  return resolveSchema(parseSchema(await readFile(config.schema, "utf8")));
}

/** Plan the migration between the snapshot and the current schema. */
export async function planMigration(
  config: CyphraConfig,
): Promise<{ plan: MigrationPlan; next: SchemaModel; first: boolean }> {
  const prev = await readSnapshot(config);
  const next = await currentModel(config);
  return { plan: diffSchemaModels(prev ?? EMPTY_SCHEMA_MODEL, next), next, first: prev === null };
}

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function printWarnings(plan: MigrationPlan): void {
  for (const w of plan.warnings) console.warn(`warning: ${w}`);
  const destructive = plan.steps.filter((s) => s.kind === "destructive").length;
  if (destructive) {
    console.warn(
      `warning: ${destructive} destructive step(s) were generated commented-out; uncomment them to apply.`,
    );
  }
}

/** `cyphra migrate diff`: print the migration that `migrate dev` would generate. */
export async function runMigrateDiff(config: CyphraConfig): Promise<void> {
  const { plan } = await planMigration(config);
  if (isEmptyPlan(plan)) {
    console.log("No schema changes since the last migration.");
    return;
  }
  console.log(
    renderMigrationSource(plan, { name: "preview", runtimeImport: config.runtimeImport }),
  );
  printWarnings(plan);
}

/**
 * `cyphra migrate dev`: write a migration for schema changes since the last snapshot (if any).
 *
 * @returns Path of the created migration, or `null` when the schema is unchanged.
 */
export async function createMigrationFromSchema(
  cwd: string,
  config: CyphraConfig,
  name: string | undefined,
): Promise<string | null> {
  const { plan, next } = await planMigration(config);
  if (isEmptyPlan(plan)) {
    console.log("No schema changes since the last migration.");
    return null;
  }
  const safe = (name ?? "schema").replace(/[^a-zA-Z0-9_-]/g, "_") || "schema";
  const stem = `${timestamp()}_${safe}`;
  await mkdir(config.migrations, { recursive: true });
  const file = path.join(config.migrations, `${stem}.mjs`);
  await writeFile(
    file,
    renderMigrationSource(plan, { name: stem, runtimeImport: config.runtimeImport }),
    { encoding: "utf8", flag: "wx" },
  );
  await writeFile(
    path.join(config.migrations, SNAPSHOT_FILE),
    JSON.stringify(next, null, 2) + "\n",
    "utf8",
  );
  console.log(`Created ${path.relative(cwd, file)} (${plan.steps.length} step(s))`);
  printWarnings(plan);
  return file;
}
