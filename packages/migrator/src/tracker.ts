import type { CyphraManagedTransaction, CyphraSession } from "@cyphra/core";

/** Neo4j label used to record applied migrations. */
export const CYPHRA_MIGRATION_LABEL = "__CyphraMigration";

type CypherRunner = Pick<CyphraSession, "run"> | Pick<CyphraManagedTransaction, "run">;

/**
 * Ensure uniqueness on migration name (idempotent).
 *
 * @param session - Open session.
 */
export async function ensureMigrationInfrastructure(session: CypherRunner): Promise<void> {
  const r = session.run(`
    CREATE CONSTRAINT cyphra_migration_name_unique IF NOT EXISTS
    FOR (m:__CyphraMigration) REQUIRE m.name IS UNIQUE
  `);
  await (r as PromiseLike<unknown>);
}

/**
 * @param session - Open session.
 * @param name - Migration name (e.g. file stem).
 */
export async function isMigrationApplied(session: CypherRunner, name: string): Promise<boolean> {
  const result = session.run(`MATCH (m:__CyphraMigration { name: $name }) RETURN m AS m LIMIT 1`, {
    name,
  });
  const q = await (result as PromiseLike<{ records: readonly unknown[] }>);
  return q.records.length > 0;
}

/**
 * Persist a successful migration.
 *
 * @param session - Open session.
 * @param name - Migration name.
 * @param checksum - Content checksum (e.g. SHA-256 hex).
 */
export async function recordMigration(
  session: CypherRunner,
  name: string,
  checksum: string,
): Promise<void> {
  const r = session.run(
    `
    CREATE (m:__CyphraMigration {
      name: $name,
      appliedAt: datetime(),
      checksum: $checksum
    })
    `,
    { name, checksum },
  );
  await (r as PromiseLike<unknown>);
}
