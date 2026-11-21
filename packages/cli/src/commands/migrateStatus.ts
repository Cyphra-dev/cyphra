import path from "node:path";
import {
  compareSchemaObjects,
  describeSchemaObject,
  expectedSchemaFromModel,
  isDriftFree,
  isEmptyPlan,
  listAppliedMigrations,
  readSchemaObjects,
  replayMigrations,
  type AppliedMigration,
  type DriftReport,
  type LoadedMigration,
  type SchemaObject,
} from "@cyphra/migrator";
import type { CyphraClient } from "@cyphra/runtime";
import type { CyphraConfig } from "../config.js";
import { clientForConfig } from "../clientFromEnv.js";
import { loadMigrationsFromDir } from "../loadMigrations.js";
import { currentModel, planMigration } from "./migrateDev.js";

export type MigrationState = "applied" | "pending" | "modified" | "missing";

export type MigrateStatusOptions = {
  /** Print one JSON document on stdout instead of the human report. */
  readonly json?: boolean;
  /** Compare the database with `schema.cyphra` instead of the applied migrations. */
  readonly schema?: boolean;
};

/** What `cyphra migrate status --json` prints. */
export type MigrateStatusReport = {
  /** `true` when nothing needs attention (exit code 0). */
  readonly inSync: boolean;
  readonly migrations: readonly { readonly name: string; readonly state: MigrationState }[];
  /** Schema changes since the snapshot that no migration captures yet. */
  readonly uncapturedChanges: number;
  readonly drift: {
    /** What the database was compared with. */
    readonly expected: "migrations" | "schema";
    readonly extra: readonly SchemaObject[];
    readonly missing: readonly SchemaObject[];
    readonly changed: DriftReport["changed"];
  };
  readonly warnings: readonly string[];
};

/** Applied migration files in the order they were applied, plus warnings for missing files. */
function appliedFiles(
  applied: readonly AppliedMigration[],
  files: readonly LoadedMigration[],
): { ordered: LoadedMigration[]; warnings: string[] } {
  const byName = new Map(files.map((f) => [f.name, f]));
  const ordered: LoadedMigration[] = [];
  const warnings: string[] = [];
  for (const a of applied) {
    const f = byName.get(a.name);
    if (f) ordered.push(f);
    else {
      warnings.push(
        `Applied migration ${a.name} has no file: the constraints and indexes it created are not expected, so they may show up as extra.`,
      );
    }
  }
  return { ordered, warnings };
}

/**
 * Compute the status report: migration states, uncaptured schema changes and drift between the
 * database's constraints / indexes and the applied migrations (or the schema).
 */
export async function migrateStatusReport(
  cwd: string,
  config: CyphraConfig,
  client: CyphraClient,
  opts: MigrateStatusOptions = {},
): Promise<MigrateStatusReport> {
  const { plan } = await planMigration(config);
  const files = await loadMigrationsFromDir(config.migrations, cwd);
  const applied = await client.withSession((s) => listAppliedMigrations(s));
  const appliedByName = new Map(applied.map((a) => [a.name, a]));
  const fileNames = new Set(files.map((f) => f.name));

  const migrations: { name: string; state: MigrationState }[] = [];
  for (const f of files) {
    const a = appliedByName.get(f.name);
    const state: MigrationState = !a
      ? "pending"
      : a.checksum && a.checksum !== f.checksum
        ? "modified"
        : "applied";
    migrations.push({ name: f.name, state });
  }
  for (const a of applied) {
    if (!fileNames.has(a.name)) migrations.push({ name: a.name, state: "missing" });
  }

  const warnings: string[] = [];
  let expected: SchemaObject[];
  if (opts.schema) {
    expected = expectedSchemaFromModel(await currentModel(config), client.dialect);
  } else {
    const { ordered, warnings: missing } = appliedFiles(applied, files);
    warnings.push(...missing);
    for (const m of migrations) {
      if (m.state === "modified") {
        warnings.push(
          `Migration ${m.name} was edited after it was applied: its current file is replayed.`,
        );
      }
    }
    const replay = await replayMigrations(ordered);
    warnings.push(...replay.warnings);
    expected = replay.objects;
  }
  const drift = compareSchemaObjects(expected, await readSchemaObjects(client));

  const uncapturedChanges = plan.steps.length;
  const inSync =
    isEmptyPlan(plan) && migrations.every((m) => m.state === "applied") && isDriftFree(drift);
  return {
    inSync,
    migrations,
    uncapturedChanges,
    drift: { expected: opts.schema ? "schema" : "migrations", ...drift },
    warnings,
  };
}

const MIGRATION_NOTES: Record<MigrationState, string> = {
  applied: "",
  pending: "",
  modified: " (changed after it was applied)",
  missing: " (applied, but no file in the migrations directory)",
};

/** Human-readable drift lines (shared with `migrate dev`'s warning). */
export function driftLines(drift: DriftReport): string[] {
  const lines: string[] = [];
  const label = (o: SchemaObject) => `${o.kind} ${o.name ?? "(unnamed)"}`;
  for (const o of drift.extra) {
    lines.push(`extra     ${label(o)}: ${describeSchemaObject(o)}`);
  }
  for (const o of drift.missing) {
    lines.push(`missing   ${label(o)}: ${describeSchemaObject(o)}`);
  }
  for (const c of drift.changed) {
    lines.push(`changed   ${label(c.expected)}: ${c.differences.join("; ")} (expected → actual)`);
  }
  return lines;
}

/** Number of drift entries in a report. */
export function driftCount(drift: DriftReport): number {
  return drift.extra.length + drift.missing.length + drift.changed.length;
}

function printReport(cwd: string, config: CyphraConfig, r: MigrateStatusReport): void {
  if (r.uncapturedChanges > 0) {
    console.log(
      `Schema has ${r.uncapturedChanges} change(s) not captured in a migration: run \`cyphra migrate dev\`.\n`,
    );
  }
  const dir = path.relative(cwd, config.migrations) || ".";
  if (r.migrations.length === 0) console.log("No migrations yet.");
  else {
    console.log(`Migrations (${dir}):`);
    for (const m of r.migrations) {
      console.log(`  ${m.state.padEnd(9)} ${m.name}${MIGRATION_NOTES[m.state]}`);
    }
  }
  const against = r.drift.expected === "schema" ? "the schema" : "the applied migrations";
  const count = driftCount(r.drift);
  console.log("");
  if (count === 0) {
    console.log(`No drift: the database's constraints and indexes match ${against}.`);
  } else {
    console.log(`Drift (database vs ${against}):`);
    for (const line of driftLines(r.drift)) console.log(`  ${line}`);
    console.log(
      `\n${count} drift issue(s). Capture intended changes in a migration (\`cyphra migration:create\`) or revert them in the database; in development, \`cyphra migrate reset\` rebuilds the database from the migrations.`,
    );
  }
  for (const w of r.warnings) console.warn(`warning: ${w}`);
}

/**
 * `cyphra migrate status`: pending / applied / modified / missing migrations, schema changes not
 * yet captured in a migration, and drift between the database's constraints and indexes and the
 * applied migrations.
 *
 * @returns `true` when everything is in sync (exit code 0), `false` otherwise (exit code 1).
 */
export async function runMigrateStatus(
  cwd: string,
  config: CyphraConfig,
  opts: MigrateStatusOptions = {},
): Promise<boolean> {
  const client = await clientForConfig(config);
  try {
    const report = await migrateStatusReport(cwd, config, client, opts);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printReport(cwd, config, report);
    return report.inSync;
  } finally {
    await client.close();
  }
}

/**
 * Warn (on stderr) when the database has drifted from the applied migrations. Used by
 * `cyphra migrate dev` before it generates a migration; silent when no database is configured
 * or reachable.
 */
export async function warnOnDrift(cwd: string, config: CyphraConfig): Promise<void> {
  if (!process.env.NEO4J_URI) return;
  let client: CyphraClient;
  try {
    client = await clientForConfig(config);
  } catch {
    return;
  }
  try {
    const files = await loadMigrationsFromDir(config.migrations, cwd);
    const applied = await client.withSession((s) => listAppliedMigrations(s));
    const { ordered } = appliedFiles(applied, files);
    const { objects } = await replayMigrations(ordered);
    const drift = compareSchemaObjects(objects, await readSchemaObjects(client));
    const count = driftCount(drift);
    if (count === 0) return;
    console.warn(
      `warning: the database has drifted from the applied migrations (${count} difference(s)):`,
    );
    for (const line of driftLines(drift)) console.warn(`  ${line}`);
    console.warn(
      "warning: the new migration only covers schema changes. In development, `cyphra migrate reset` rebuilds the database from the migrations; see `cyphra migrate status`.",
    );
  } catch (err) {
    console.warn(
      `note: drift check skipped (${err instanceof Error ? err.message : String(err)}).`,
    );
  } finally {
    await client.close();
  }
}
