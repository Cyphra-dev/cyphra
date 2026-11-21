import type { CyphraClient, CyphraDialect } from "@cyphra/runtime";
import { createMigrationDb } from "./migrationDb.js";
import type { MigrationDefinition } from "./defineMigration.js";
import * as tracker from "./tracker.js";
import { ddlForDialect } from "./memgraph.js";

/** The client's dialect (a client from an older @cyphra/runtime has none: Neo4j). */
export function dialectOf(client: CyphraClient): CyphraDialect {
  return (client as { dialect?: CyphraDialect }).dialect ?? "neo4j";
}

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
    await tracker.ensureMigrationInfrastructure(session, dialectOf(client));
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
    // Cyphra's DDL is written in Neo4j's syntax: translated for Memgraph (statements already in
    // Memgraph's syntax, or not DDL, run as they are).
    for (const statement of ddlForDialect(statements, dialectOf(client))) {
      const r = await session.run(statement);
      await r;
    }
  });
}
