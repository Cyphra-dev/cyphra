import type { MigrationDb } from "./migrationDb.js";

/**
 * Versioned migration: `name` is stable; `up` runs once per database.
 */
export type MigrationDefinition = {
  readonly name: string;
  readonly up: (ctx: { db: MigrationDb }) => Promise<void>;
};

/**
 * Define a migration module default export.
 *
 * @param def - Migration name and `up` handler.
 *
 * @example
 * ```ts
 * export default defineMigration({
 *   name: "001_init",
 *   async up({ db }) {
 *     await db.run`MERGE (n:Example { id: ${"seed-1"} })`;
 *   },
 * });
 * ```
 */
export function defineMigration(def: MigrationDefinition): MigrationDefinition {
  return def;
}
