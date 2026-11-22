import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyConstraintStatements,
  constraintStatementsFromSchema,
  CYPHRA_MIGRATION_LABEL,
  dropAllFalkorDBSchema,
  fulltextIndexStatementsFromSchema,
  indexStatementsFromSchema,
  memgraphDropStatement,
  readSchemaObjects,
  runPendingMigrations,
  vectorIndexStatementsFromSchema,
  withMemgraphStorageAccess,
  type LoadedMigration,
  type MigrationDefinition,
} from "@cyphra/migrator";
import type { CyphraClient } from "@cyphra/runtime";
import { parseSchema, type SchemaDocument } from "@cyphra/schema";

/** A `CyphraClient`, or an ORM client (its `$client` is used). */
export type ClientLike = CyphraClient | { readonly $client: CyphraClient };

/** The low-level client of `target`. */
export function lowLevelClient(target: ClientLike): CyphraClient {
  return "$client" in target ? target.$client : target;
}

/**
 * A schema: a path to a `.cyphra` file (string or `file:` URL), the schema source itself, or a
 * parsed document (`parseSchema`).
 */
export type SchemaInput = string | URL | SchemaDocument;

/** Migrations: a directory of `.js` / `.mjs` migration modules, or already loaded migrations. */
export type MigrationsInput = string | URL | readonly LoadedMigration[];

function toPath(p: string | URL): string {
  return p instanceof URL ? fileURLToPath(p) : path.resolve(p);
}

/** Parse `schema` (see {@link SchemaInput}). */
export async function loadSchema(schema: SchemaInput): Promise<SchemaDocument> {
  if (typeof schema === "object" && !(schema instanceof URL)) return schema;
  // Schema source has braces or line breaks; a file path has neither.
  if (typeof schema === "string" && /[{\n]/.test(schema)) return parseSchema(schema);
  return parseSchema(await readFile(toPath(schema), "utf8"));
}

/**
 * Every DDL statement `cyphra push` writes for `schema`: constraints, then range, vector and
 * full-text indexes (in Neo4j's syntax; {@link applySchema} translates them for the dialect).
 */
export function schemaStatements(doc: SchemaDocument): string[] {
  return [
    ...constraintStatementsFromSchema(doc),
    ...indexStatementsFromSchema(doc),
    ...vectorIndexStatementsFromSchema(doc),
    ...fulltextIndexStatementsFromSchema(doc),
  ];
}

/**
 * Load the migrations of a directory the way `cyphra migrate` does: every `.js` / `.mjs` module,
 * sorted by file name, each exporting `defineMigration({ name, up })` by default. A missing
 * directory has no migrations.
 */
export async function loadMigrations(dir: string | URL): Promise<LoadedMigration[]> {
  const root = toPath(dir);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: LoadedMigration[] = [];
  for (const file of entries.filter((f) => f.endsWith(".js") || f.endsWith(".mjs")).sort()) {
    const full = path.join(root, file);
    const checksum = createHash("sha256")
      .update(await readFile(full, "utf8"))
      .digest("hex");
    const mod = (await import(pathToFileURL(full).href)) as { default?: MigrationDefinition };
    const definition = mod.default;
    if (!definition?.name || typeof definition.up !== "function") {
      throw new Error(`Migration ${file} must export default defineMigration({ name, up })`);
    }
    out.push({ name: definition.name, checksum, definition });
  }
  return out;
}

export type ApplySchemaOptions = {
  /** Schema whose constraints and indexes are created (what `cyphra push` does). */
  schema?: SchemaInput;
  /** Migrations to run (what `cyphra migrate deploy` does), before the schema's DDL. */
  migrations?: MigrationsInput;
};

export type ApplySchemaResult = {
  /** Names of the migrations applied by this call. */
  readonly migrations: readonly string[];
  /** Number of DDL statements run for `schema`. */
  readonly statements: number;
};

/**
 * Bring a test database to the state of the app: run pending `migrations` (recorded on
 * `__CyphraMigration`, like `cyphra migrate deploy`), then create the constraints and indexes of
 * `schema` (like `cyphra push`; idempotent). Works on Neo4j, Memgraph and FalkorDB (the DDL is
 * translated for the client's dialect).
 */
export async function applySchema(
  target: ClientLike,
  options: ApplySchemaOptions,
): Promise<ApplySchemaResult> {
  const client = lowLevelClient(target);
  let applied: readonly string[] = [];
  if (options.migrations !== undefined) {
    const loaded =
      typeof options.migrations === "string" || options.migrations instanceof URL
        ? await loadMigrations(options.migrations)
        : options.migrations;
    applied = await runPendingMigrations(client, loaded);
  }
  let statements = 0;
  if (options.schema !== undefined) {
    const ddl = schemaStatements(await loadSchema(options.schema));
    await applyConstraintStatements(client, ddl);
    statements = ddl.length;
  }
  return { migrations: applied, statements };
}

function quoteName(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

/**
 * Drop every constraint and index of the database (Neo4j keeps its built-in LOOKUP indexes),
 * Cyphra's migration constraint included. Data is kept: see {@link wipeDatabase}.
 */
export async function dropSchema(
  target: ClientLike,
): Promise<{ constraints: number; indexes: number }> {
  const client = lowLevelClient(target);
  if (client.dialect === "falkordb") return dropAllFalkorDBSchema(client);
  if (client.dialect === "memgraph") {
    const objects = await readSchemaObjects(client);
    return client.withSession(async (session) => {
      let constraints = 0;
      for (const o of objects) {
        await withMemgraphStorageAccess(() => session.run(memgraphDropStatement(o)));
        if (o.kind === "constraint") constraints++;
      }
      // Cyphra's migration-name constraint (left out of `readSchemaObjects`); absent on a fresh
      // database, where dropping it fails.
      await withMemgraphStorageAccess(() =>
        session.run(`DROP CONSTRAINT ON (m:${CYPHRA_MIGRATION_LABEL}) ASSERT m.name IS UNIQUE`),
      ).catch(() => undefined);
      return { constraints, indexes: objects.length - constraints };
    });
  }
  return client.withSession(async (session) => {
    // Constraints first: an index that backs a constraint cannot be dropped on its own.
    const constraints = (await session.run("SHOW CONSTRAINTS YIELD name")).records.map(
      (r) => r.get("name") as string,
    );
    for (const name of constraints)
      await session.run(`DROP CONSTRAINT ${quoteName(name)} IF EXISTS`);
    const indexes = (
      await session.run(
        "SHOW INDEXES YIELD name, type, owningConstraint WHERE type <> 'LOOKUP' AND owningConstraint IS NULL RETURN name",
      )
    ).records.map((r) => r.get("name") as string);
    for (const name of indexes) await session.run(`DROP INDEX ${quoteName(name)} IF EXISTS`);
    return { constraints: constraints.length, indexes: indexes.length };
  });
}
