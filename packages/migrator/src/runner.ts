import type { CyphraClient } from "@cyphra/runtime";
import { createMigrationDb } from "./migrationDb.js";
import type { MigrationDefinition } from "./defineMigration.js";
import * as tracker from "./tracker.js";

/** Migration with precomputed checksum (e.g. SHA-256 of source file). */
export type LoadedMigration = {
  readonly name: string;
  readonly checksum: string;
  readonly definition: MigrationDefinition;
};

/**
 * Apply migrations in order, skipping those already recorded on `__CyphraMigration`.
 *
 * @param client - Cyphra client.
 * @param ordered - Migrations sorted lexicographically by `name` (caller responsibility).
 * @returns Names that were applied in this run.
 */
export async function runPendingMigrations(
  client: CyphraClient,
  ordered: readonly LoadedMigration[],
): Promise<readonly string[]> {
  const applied: string[] = [];
  await client.withSession(async (session) => {
    await tracker.ensureMigrationInfrastructure(session);
    for (const m of ordered) {
      if (await tracker.isMigrationApplied(session, m.name)) {
        continue;
      }
      const db = createMigrationDb(client, session);
      await m.definition.up({ db });
      await tracker.recordMigration(session, m.name, m.checksum);
      applied.push(m.name);
    }
  });
  return applied;
}

/**
 * Execute DDL statements (e.g. from {@link constraintStatementsFromSchema}).
 *
 * @param client - Cyphra client.
 * @param statements - Cypher DDL, one statement per string.
 */
export async function applyConstraintStatements(
  client: CyphraClient,
  statements: readonly string[],
): Promise<void> {
  await client.withSession(async (session) => {
    for (const statement of statements) {
      const r = await session.run(statement);
      await r;
    }
  });
}
