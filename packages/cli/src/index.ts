#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { runDev } from "./commands/dev.js";
import { runFormat } from "./commands/format.js";
import { runGenerate } from "./commands/generate.js";
import { runImportGraphql } from "./commands/importGraphql.js";
import { runInit } from "./commands/init.js";
import { runMigrate } from "./commands/migrate.js";
import { createMigrationFromSchema, runMigrateDiff } from "./commands/migrateDev.js";
import { runMigrateStatus } from "./commands/migrateStatus.js";
import { runMigrationCreate } from "./commands/migrationCreate.js";
import { runPull } from "./commands/pull.js";
import { runPush } from "./commands/push.js";
import { runSchemaDdl } from "./commands/schemaDdl.js";
import { runSchemaPrint } from "./commands/schemaPrint.js";
import { runValidateSchema } from "./commands/validateSchema.js";
import { loadConfig } from "./config.js";

// Load ./.env (Node 20.12+) so NEO4J_* settings written by `cyphra dev` are picked up.
try {
  process.loadEnvFile?.(".env");
} catch {
  // no .env: rely on the environment
}

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command();
program
  .name("cyphra")
  .description("Cyphra: typed ORM, migrations and tooling for Neo4j")
  .version(version);

program
  .command("init")
  .description(
    "Create cyphra.json, schema.cyphra, migrations/ and .env.example (existing files are kept)",
  )
  .action(async () => {
    await runInit(process.cwd());
  });

program
  .command("dev")
  .description("Run a local Neo4j 5 in Docker for this project and write .env")
  .option("--stop", "stop the container")
  .option("--reset", "remove the container and its data volume")
  .option("--port <port>", "host Bolt port (default 7687)", (v) => Number(v))
  .option("--http-port <port>", "host HTTP/browser port (default 7474)", (v) => Number(v))
  .option("--image <image>", "Docker image (default neo4j:5)")
  .action(
    async (opts: {
      stop?: boolean;
      reset?: boolean;
      port?: number;
      httpPort?: number;
      image?: string;
    }) => {
      await runDev(process.cwd(), opts);
    },
  );

const migrate = program.command("migrate").description("Migration commands");

migrate
  .command("dev")
  .description(
    "Generate a migration from schema changes since the last one, then apply pending migrations",
  )
  .option("-n, --name <name>", "migration name (default: schema)")
  .option("--create-only", "write the migration without applying it")
  .action(async (opts: { name?: string; createOnly?: boolean }) => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    await createMigrationFromSchema(cwd, config, opts.name);
    if (!opts.createOnly) await runMigrate(cwd, true);
  });

migrate
  .command("diff")
  .description("Print the migration `migrate dev` would generate (no database, no files written)")
  .action(async () => {
    await runMigrateDiff(await loadConfig(process.cwd()));
  });

migrate
  .command("deploy")
  .description("Apply pending migrations")
  .action(async () => {
    await runMigrate(process.cwd(), false);
  });

migrate
  .command("status")
  .description("Show applied / pending / modified migrations and uncaptured schema changes")
  .action(async () => {
    const cwd = process.cwd();
    const ok = await runMigrateStatus(cwd, await loadConfig(cwd));
    if (!ok) process.exitCode = 1;
  });

program
  .command("migration:create")
  .argument("<name>", "Migration file stem (e.g. add-index)")
  .description("Create an empty .mjs migration to write by hand")
  .action(async (name: string) => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    await runMigrationCreate(cwd, config.migrations, name, config.runtimeImport);
  });

program
  .command("pull")
  .description("Introspect the database and write schema.cyphra")
  .option("--force", "overwrite an existing schema file")
  .option("--print", "write the schema to stdout instead of the schema file")
  .action(async (opts: { force?: boolean; print?: boolean }) => {
    const cwd = process.cwd();
    await runPull(cwd, await loadConfig(cwd), opts);
  });

program
  .command("push")
  .description("Apply schema constraints and indexes directly (prototyping; prefer migrate dev)")
  .action(async () => {
    await runPush(process.cwd());
  });

program
  .command("validate")
  .description("Parse and validate schema.cyphra")
  .action(async () => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    await runValidateSchema(cwd, config);
  });

program
  .command("format")
  .description("Reformat schema.cyphra in place, keeping comments")
  .option("--check", "exit with 1 instead of writing when the schema is not formatted")
  .action(async (opts: { check?: boolean }) => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    process.exitCode = await runFormat(cwd, config, opts);
  });

program
  .command("generate")
  .description("Generate the typed client (cyphra.gen.ts) from the schema")
  .action(async () => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    await runGenerate(cwd, config);
  });

const importCmd = program.command("import").description("Import a schema from another tool");

importCmd
  .command("graphql")
  .argument("<typeDefs...>", "@neo4j/graphql v7 type definitions (.graphql files)")
  .description(
    "Convert @neo4j/graphql v7 type definitions to schema.cyphra and report what was not converted",
  )
  .option("-o, --out <path>", "schema file to write (default: schema from cyphra.json)")
  .option("--merge", "merge into the existing schema, keeping its models, fields and comments")
  .option("--force", "overwrite an existing schema file")
  .option("--print", "write the schema to stdout instead of a file")
  .action(
    async (
      files: string[],
      opts: { out?: string; merge?: boolean; force?: boolean; print?: boolean },
    ) => {
      process.exitCode = await runImportGraphql(process.cwd(), files, opts);
    },
  );

const schemaCmd = program.command("schema").description("Schema utilities");

schemaCmd
  .command("print")
  .description("Pretty-print schema.cyphra to stdout (canonical formatting)")
  .action(async () => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    await runSchemaPrint(config);
  });

schemaCmd
  .command("ddl")
  .description("Print constraint + range-index DDL for push (no database connection)")
  .action(async () => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    await runSchemaDdl(config);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
