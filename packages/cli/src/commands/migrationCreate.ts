import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function migrationFileBody(name: string, runtimeImport: string): string {
  return `import { defineMigration } from ${JSON.stringify(runtimeImport)};

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
  runtimeImport = "cyphra",
): Promise<void> {
  const safe = stem.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `${safe}.mjs`;
  const full = path.join(migrationsDir, fileName);
  await mkdir(migrationsDir, { recursive: true });
  await writeFile(full, migrationFileBody(safe, runtimeImport), { encoding: "utf8", flag: "wx" });
  console.log(`Created ${path.relative(cwd, full)}`);
}
