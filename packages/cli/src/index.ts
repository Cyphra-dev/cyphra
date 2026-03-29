#!/usr/bin/env node
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runMigrate } from "./commands/migrate.js";
import { runMigrationCreate } from "./commands/migrationCreate.js";
import { runGenerate } from "./commands/generate.js";
import { runPush } from "./commands/push.js";
import { runSchemaDdl } from "./commands/schemaDdl.js";
import { runSchemaPrint } from "./commands/schemaPrint.js";
import { runValidateSchema } from "./commands/validateSchema.js";
import { loadConfig } from "./config.js";

const program = new Command();
program.name("cyphra").description("Cyphra toolkit for Neo4j").version("0.0.0");

program
  .command("init")
  .description("Create cyphra.json, schema.cyphra, migrations/, .env.example")
  .action(async () => {
    await runInit(process.cwd());
  });

const migrate = program.command("migrate").description("Migration commands");

migrate
  .command("deploy")
  .description("Apply pending migrations")
  .action(async () => {
    await runMigrate(process.cwd(), false);
  });

migrate
  .command("dev")
  .description("Apply pending migrations (verbose)")
  .action(async () => {
    await runMigrate(process.cwd(), true);
  });

program
  .command("migration:create")
  .argument("<name>", "Migration file stem (e.g. add-index)")
  .description("Create a new .mjs migration")
  .action(async (name: string) => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    await runMigrationCreate(cwd, config.migrations, name);
  });

program
  .command("push")
  .description("Push schema constraints to Neo4j")
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
  .command("generate")
  .description("Emit cyphra.gen.ts (labels, relationship types) from the schema")
  .action(async () => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    await runGenerate(cwd, config);
  });

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
