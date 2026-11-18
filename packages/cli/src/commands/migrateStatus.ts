import { isEmptyPlan, listAppliedMigrations } from "@cyphra/migrator";
import type { CyphraConfig } from "../config.js";
import { clientFromEnv } from "../clientFromEnv.js";
import { loadMigrationsFromDir } from "../loadMigrations.js";
import { planMigration } from "./migrateDev.js";

/**
 * `cyphra migrate status`: pending / applied migrations, edited-after-apply files, and schema changes
 * not yet captured in a migration. Exits non-zero when something needs attention.
 */
export async function runMigrateStatus(cwd: string, config: CyphraConfig): Promise<boolean> {
  let ok = true;
  const { plan } = await planMigration(config);
  if (!isEmptyPlan(plan)) {
    ok = false;
    console.log(
      `Schema has ${plan.steps.length} change(s) not captured in a migration: run \`cyphra migrate dev\`.`,
    );
  }

  const files = await loadMigrationsFromDir(config.migrations, cwd);
  const client = clientFromEnv(false);
  try {
    const applied = await client.withSession((s) => listAppliedMigrations(s));
    const appliedByName = new Map(applied.map((a) => [a.name, a]));
    const fileNames = new Set(files.map((f) => f.name));

    for (const f of files) {
      const a = appliedByName.get(f.name);
      if (!a) {
        ok = false;
        console.log(`pending   ${f.name}`);
      } else if (a.checksum && a.checksum !== f.checksum) {
        ok = false;
        console.log(`modified  ${f.name} (changed after it was applied)`);
      } else {
        console.log(`applied   ${f.name}`);
      }
    }
    for (const a of applied) {
      if (!fileNames.has(a.name)) {
        ok = false;
        console.log(`missing   ${a.name} (applied, but no file in ${config.migrations})`);
      }
    }
    if (files.length === 0 && applied.length === 0) console.log("No migrations yet.");
  } finally {
    await client.close();
  }
  return ok;
}
