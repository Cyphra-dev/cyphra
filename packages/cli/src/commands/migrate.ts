import { loadConfig } from "../config.js";
import { clientFromEnv } from "../clientFromEnv.js";
import { loadMigrationsFromDir } from "../loadMigrations.js";
import { runPendingMigrations } from "@cyphra/migrator";

/**
 * Apply pending migrations (deploy / dev — same behavior; dev may pass verbose later).
 *
 * @param cwd - Project root.
 * @param verbose - Log applied migration names.
 */
export async function runMigrate(cwd: string, verbose: boolean): Promise<void> {
  const config = await loadConfig(cwd);
  const client = clientFromEnv(verbose);
  try {
    const loaded = await loadMigrationsFromDir(config.migrations, cwd);
    const applied = await runPendingMigrations(client, loaded);
    if (verbose || applied.length > 0) {
      console.log(applied.length ? `Applied: ${applied.join(", ")}` : "No pending migrations");
    }
  } finally {
    await client.close();
  }
}
