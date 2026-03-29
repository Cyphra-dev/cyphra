import type { Session } from "neo4j-driver";

/** Neo4j label used to record applied migrations. */
export const CYPHRA_MIGRATION_LABEL = "__CyphraMigration";

/**
 * Ensure uniqueness on migration name (idempotent).
 *
 * @param session - Open session.
 */
export async function ensureMigrationInfrastructure(session: Session): Promise<void> {
  const r = await session.run(`
    CREATE CONSTRAINT cyphra_migration_name_unique IF NOT EXISTS
    FOR (m:__CyphraMigration) REQUIRE m.name IS UNIQUE
  `);
  await r;
}

/**
 * @param session - Open session.
 * @param name - Migration name (e.g. file stem).
 */
export async function isMigrationApplied(session: Session, name: string): Promise<boolean> {
  const result = await session.run(
    `MATCH (m:__CyphraMigration { name: $name }) RETURN m AS m LIMIT 1`,
    { name },
  );
  const q = await result;
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
  session: Session,
  name: string,
  checksum: string,
): Promise<void> {
  const r = await session.run(
    `
    CREATE (m:__CyphraMigration {
      name: $name,
      appliedAt: datetime(),
      checksum: $checksum
    })
    `,
    { name, checksum },
  );
  await r;
}
