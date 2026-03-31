import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import { runMigrate } from "./commands/migrate.js";
import { runMigrationCreate } from "./commands/migrationCreate.js";
import { runPush } from "./commands/push.js";
import { runSchemaDdl } from "./commands/schemaDdl.js";
import { runSchemaPrint } from "./commands/schemaPrint.js";
import { runDbPull } from "./commands/dbPull.js";
import { readFile } from "node:fs/promises";
import { runSchemaAddFromJson, runSchemaAddInteractive } from "./commands/schemaAdd.js";
import { runValidateSchema } from "./commands/validateSchema.js";
import { loadConfig } from "@cyphra/config";
import { formatCliError } from "./formatCliError.js";

function cliPackageVersion(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(dir, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

const program = new Command();
program
  .name("cyphra")
  .description("Cyphra toolkit for Neo4j (graph provider: neo4j)")
  .version(cliPackageVersion());
program.showHelpAfterError();

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

const dbPullAction = async (opts: { print?: boolean; force?: boolean; sampleSize?: string }) => {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const raw = opts.sampleSize ?? "0";
  const sampleSize = parseInt(raw, 10);
  if (!Number.isFinite(sampleSize) || sampleSize < 0) {
    throw new Error(`Invalid --sample-size: ${JSON.stringify(raw)} (expect non-negative integer)`);
  }
  await runDbPull(cwd, config, { print: opts.print, force: opts.force, sampleSize });
};

program
  .command("db-pull")
  .description("Introspect Neo4j into a draft schema (alias of `cyphra db pull`)")
  .option("--print", "Print draft schema to stdout")
  .option("--force", "Overwrite the configured schema file if it exists")
  .option(
    "--sample-size <n>",
    "Sample up to n nodes per label to list property keys in comments (0 = off)",
    "0",
  )
  .action(dbPullAction);

const dbCmd = program.command("db").description("Database introspection");
dbCmd
  .command("pull")
  .description("Introspect Neo4j labels, rel types, constraints/indexes into a draft schema")
  .option("--print", "Print draft schema to stdout")
  .option("--force", "Overwrite the configured schema file if it exists")
  .option(
    "--sample-size <n>",
    "Sample up to n nodes per label to list property keys in comments (0 = off)",
    "0",
  )
  .action(dbPullAction);

program
  .command("validate")
  .description("Parse and validate schema.cyphra")
  .action(async () => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    await runValidateSchema(cwd, config);
  });

const schemaCmd = program.command("schema").description("Schema utilities");

schemaCmd
  .command("print")
  .description("Pretty-print schema.cyphra to stdout (canonical formatting)")
  .action(async () => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    await runSchemaPrint(cwd, config);
  });

schemaCmd
  .command("ddl")
  .description("Print constraint + range-index DDL for push (no database connection)")
  .action(async () => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    await runSchemaDdl(cwd, config);
  });

schemaCmd
  .command("add")
  .description("Append a node block to schema.cyphra (interactive TTY, or --json for CI)")
  .option("--json <file>", "Path to JSON: { label, fields: [{ name, type, optional?, id?, unique? }] }")
  .action(async (opts: { json?: string }) => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    if (opts.json) {
      const raw = await readFile(opts.json, "utf8");
      const payload = JSON.parse(raw) as unknown;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("--json must contain an object with label and fields");
      }
      await runSchemaAddFromJson(config, payload as Parameters<typeof runSchemaAddFromJson>[1]);
      return;
    }
    await runSchemaAddInteractive(cwd, config);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(formatCliError(err));
  process.exitCode = 1;
});
