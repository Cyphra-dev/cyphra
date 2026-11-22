import type { Session } from "neo4j-driver";
import type { CyphraDialect } from "@cyphra/runtime";

/** Cyphra's migration-name constraint on FalkorDB (a Redis command the transport runs). */
export const FALKORDB_MIGRATION_CONSTRAINT =
  "GRAPH.CONSTRAINT CREATE UNIQUE NODE `__CyphraMigration` PROPERTIES 1 `name`";

/** Neo4j label used to record applied migrations. */
export const CYPHRA_MIGRATION_LABEL = "__CyphraMigration";

/**
 * Ensure uniqueness on migration name (idempotent).
 *
 * @param session - Open session.
 * @param dialect - `"memgraph"` writes Memgraph's (unnamed) constraint, `"falkordb"` FalkorDB's.
 */
export async function ensureMigrationInfrastructure(
  session: Session,
  dialect: CyphraDialect = "neo4j",
): Promise<void> {
  if (dialect === "falkordb") {
    // No IF NOT EXISTS on FalkorDB: an existing constraint is fine.
    await session.run(FALKORDB_MIGRATION_CONSTRAINT).catch((e: unknown) => {
      if (!/already exists/i.test(e instanceof Error ? e.message : String(e))) throw e;
    });
    return;
  }
  if (dialect === "memgraph") {
    await session.run(`CREATE CONSTRAINT ON (m:${CYPHRA_MIGRATION_LABEL}) ASSERT m.name IS UNIQUE`);
    return;
  }
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
 * @param dialect - `"falkordb"` records `appliedAt` as epoch milliseconds (`timestamp()`):
 *   FalkorDB has no zoned datetime and stores times at a precision of one second.
 */
export async function recordMigration(
  session: Session,
  name: string,
  checksum: string,
  dialect: CyphraDialect = "neo4j",
): Promise<void> {
  const r = await session.run(
    `
    CREATE (m:__CyphraMigration {
      name: $name,
      appliedAt: ${dialect === "falkordb" ? "timestamp()" : "datetime()"},
      checksum: $checksum
    })
    `,
    { name, checksum },
  );
  await r;
}

export type AppliedMigration = {
  readonly name: string;
  readonly checksum: string | null;
  readonly appliedAt: Date | null;
};

/**
 * List applied migrations, oldest first.
 *
 * @param session - Open session.
 */
export async function listAppliedMigrations(session: Session): Promise<AppliedMigration[]> {
  const result = await session.run(
    `MATCH (m:__CyphraMigration) RETURN m.name AS name, m.checksum AS checksum, m.appliedAt AS appliedAt ORDER BY m.appliedAt, m.name`,
  );
  return result.records.map((r) => {
    const at = r.get("appliedAt") as
      { toStandardDate?: () => Date; toNumber?: () => number } | number | null;
    let appliedAt: Date | null = null;
    // FalkorDB: epoch milliseconds (an integer).
    if (typeof at === "number") appliedAt = new Date(at);
    else if (at?.toStandardDate) appliedAt = at.toStandardDate();
    else if (at?.toNumber) appliedAt = new Date(at.toNumber());
    return {
      name: r.get("name") as string,
      checksum: (r.get("checksum") as string | null) ?? null,
      appliedAt,
    };
  });
}
