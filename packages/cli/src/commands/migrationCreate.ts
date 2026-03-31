import { stat, writeFile } from "node:fs/promises";
import path from "node:path";

function migrationFileBody(name: string): string {
  return `import { defineMigration } from "@cyphra/migrator";

export default defineMigration({
  name: ${JSON.stringify(name)},
  async up({ db }) {
    await db.run\`RETURN 1 AS ok\`;
  },
});
`;
}

/**
 * Create a new `.mjs` migration stub under `migrations/`.
 *
 * @param cwd - Project root.
 * @param migrationsDir - Absolute migrations directory.
 * @param stem - File stem used for file name and migration `name`.
 */
export async function runMigrationCreate(
  cwd: string,
  migrationsDir: string,
  stem: string,
): Promise<void> {
  const trimmed = stem.trim();
  if (!trimmed) {
    throw new Error("Migration name must not be empty.");
  }
  if (!/[a-zA-Z0-9]/.test(trimmed)) {
    throw new Error(
      `Migration name must contain at least one letter or digit (got ${JSON.stringify(stem)})`,
    );
  }
  const safe = trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `${safe}.mjs`;
  const full = path.join(migrationsDir, fileName);
  let alreadyThere = false;
  try {
    await stat(full);
    alreadyThere = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (alreadyThere) {
    throw new Error(`Migration file already exists: ${path.relative(cwd, full)}`);
  }
  await writeFile(full, migrationFileBody(safe), "utf8");
  console.log(`Created ${path.relative(cwd, full)}`);
}
