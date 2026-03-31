import type { CyphraDriverClient } from "@cyphra/core";
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
 * @throws With `Migration "<name>" failed during up()` or a recording error; original error is {@link Error.cause}.
 */
export async function runPendingMigrations(
  client: CyphraDriverClient,
  ordered: readonly LoadedMigration[],
): Promise<readonly string[]> {
  const applied: string[] = [];
  await client.withSession(async (session) => tracker.ensureMigrationInfrastructure(session));
  for (const m of ordered) {
    if (
      await client.withSession(async (session) => {
        return tracker.isMigrationApplied(session, m.name);
      })
    ) {
      continue;
    }

    const didApply = await client.withWriteTransaction(async (tx) => {
      if (await tracker.isMigrationApplied(tx, m.name)) {
        return false;
      }
      const db = createMigrationDb(client, tx);
      try {
        await m.definition.up({ db });
      } catch (e) {
        throw new Error(`Migration "${m.name}" failed during up()`, { cause: e });
      }
      try {
        await tracker.recordMigration(tx, m.name, m.checksum);
      } catch (e) {
        throw new Error(
          `Migration "${m.name}" ran but recording on ${tracker.CYPHRA_MIGRATION_LABEL} failed`,
          { cause: e },
        );
      }
      return true;
    });
    if (didApply) {
      applied.push(m.name);
    }
  }
  return applied;
}

/**
 * Execute DDL statements (e.g. from {@link constraintStatementsFromSchema}).
 * On failure, throws with message `DDL failed (<preview>)` and the driver error as {@link Error.cause}.
 *
 * @param client - Cyphra client.
 * @param statements - Cypher DDL, one statement per string.
 */
export async function applyConstraintStatements(
  client: CyphraDriverClient,
  statements: readonly string[],
): Promise<void> {
  await client.withSession(async (session) => {
    for (const statement of statements) {
      try {
        const r = session.run(statement);
        await (r as PromiseLike<unknown>);
      } catch (e) {
        const preview = statement.length > 160 ? `${statement.slice(0, 160)}…` : statement;
        throw new Error(`DDL failed (${preview})`, { cause: e });
      }
    }
  });
}
