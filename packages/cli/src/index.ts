#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { runDev } from "./commands/dev.js";
import { runFormat } from "./commands/format.js";
import { runGenerate, runGenerateWatch, withZodFlags } from "./commands/generate.js";
import { runGraphqlCheck } from "./commands/graphqlCheck.js";
import { runGraphqlPrint } from "./commands/graphqlPrint.js";
import { runImportGraphql } from "./commands/importGraphql.js";
import { runImportNeogma } from "./commands/importNeogma.js";
import { runImportPrisma } from "./commands/importPrisma.js";
import { runInit } from "./commands/init.js";
import { runMigrate } from "./commands/migrate.js";
import { createMigrationFromSchema, runMigrateDiff } from "./commands/migrateDev.js";
import { runMigrateStatus, warnOnDrift } from "./commands/migrateStatus.js";
import { runMigrateReset } from "./commands/migrateReset.js";
import { runMigrationCreate } from "./commands/migrationCreate.js";
import { runPull } from "./commands/pull.js";
import { runPush } from "./commands/push.js";
import { runSchemaDdl } from "./commands/schemaDdl.js";
import { runSchemaPrint } from "./commands/schemaPrint.js";
import { runDbSeed } from "./commands/seed.js";
import { DEFAULT_STUDIO_HOST, DEFAULT_STUDIO_PORT, runStudio } from "./commands/studio.js";
import { runValidateSchema } from "./commands/validateSchema.js";
import { DEFAULT_ZOD_OUTPUT, loadConfig } from "./config.js";

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
  .option("-w, --watch", "once Neo4j is ready, regenerate the client on schema changes")
  .action(
    async (opts: {
      stop?: boolean;
      reset?: boolean;
      port?: number;
      httpPort?: number;
      image?: string;
      watch?: boolean;
    }) => {
      const cwd = process.cwd();
      // Read the config first so a broken cyphra.json fails before Docker starts.
      const config = opts.watch && !opts.stop && !opts.reset ? await loadConfig(cwd) : null;
      await runDev(cwd, opts);
      if (config) {
        await runGenerateWatch(cwd, config);
        console.log("Neo4j keeps running; stop it with `cyphra dev --stop`.");
      }
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
    await warnOnDrift(cwd, config);
    await createMigrationFromSchema(cwd, config, opts.name);
    if (!opts.createOnly) await runMigrate(cwd, true);
  });

migrate
  .command("reset")
  .description(
    "Delete all data, constraints and indexes, reapply every migration, then run the seed (local databases only)",
  )
  .option("-y, --yes", "skip the confirmation prompt")
  .option("--force", "skip the prompt and reset even a database that does not look local")
  .option("--skip-seed", "do not run the seed command afterwards")
  .action(async (opts: { yes?: boolean; force?: boolean; skipSeed?: boolean }) => {
    const cwd = process.cwd();
    process.exitCode = await runMigrateReset(cwd, await loadConfig(cwd), opts);
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
  .description(
    "Show applied / pending / modified migrations, uncaptured schema changes and drift between the database's constraints and indexes and the applied migrations (exit 0 in sync, 1 otherwise, 2 on error)",
  )
  .option("--json", "print the report as JSON")
  .option("--schema", "compare the database with schema.cyphra instead of the applied migrations")
  .action(async (opts: { json?: boolean; schema?: boolean }) => {
    const cwd = process.cwd();
    try {
      const ok = await runMigrateStatus(cwd, await loadConfig(cwd), opts);
      process.exitCode = ok ? 0 : 1;
    } catch (err) {
      // 2, like `git diff --exit-code`: CI can tell "out of sync" (1) from "could not check".
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 2;
    }
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
  .option(
    "--interface <labels...>",
    "read these labels as interfaces where the data leaves it ambiguous (e.g. nodes always labelled :Employee:Person)",
  )
  .action(async (opts: { force?: boolean; print?: boolean; interface?: string[] }) => {
    const cwd = process.cwd();
    await runPull(cwd, await loadConfig(cwd), {
      ...opts,
      interfaces: (opts.interface ?? []).flatMap((l) => l.split(",")).filter(Boolean),
    });
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
  .option("-v, --verbose", "also list the validation rules of every field")
  .action(async (opts: { verbose?: boolean }) => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    await runValidateSchema(cwd, config, opts);
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
  .description("Generate the typed client (cyphra.gen.ts) and, if configured, zod schemas")
  .option("-w, --watch", "regenerate whenever the schema file changes")
  .option(
    "--zod [output]",
    `also write zod schemas of the models (default: generators.zod.output in cyphra.json, else ${DEFAULT_ZOD_OUTPUT})`,
  )
  .option(
    "--zod-coerce",
    "zod schemas read ISO 8601 strings as Dates and decimal strings as bigints",
  )
  .option(
    "--zod-omit-generated",
    "leave generated fields (@id with a default, now(), cuid(), uuid()) out of zod input schemas",
  )
  .action(
    async (opts: {
      watch?: boolean;
      zod?: string | boolean;
      zodCoerce?: boolean;
      zodOmitGenerated?: boolean;
    }) => {
      const cwd = process.cwd();
      const config = withZodFlags(cwd, await loadConfig(cwd), opts);
      if (opts.watch) await runGenerateWatch(cwd, config);
      else await runGenerate(cwd, config);
    },
  );

const dbCmd = program.command("db").description("Database commands");

dbCmd
  .command("seed")
  .description('Run the "seed" command from cyphra.json (e.g. "tsx seed.ts")')
  .action(async () => {
    const cwd = process.cwd();
    process.exitCode = await runDbSeed(cwd, await loadConfig(cwd));
  });

program
  .command("studio")
  .description(
    "Browse and edit the database in a local web UI built from schema.cyphra (models, relations, raw Cypher)",
  )
  .option("--port <port>", `port to listen on (default ${DEFAULT_STUDIO_PORT})`, (v) => Number(v))
  .option(
    "--host <host>",
    `address to bind (default ${DEFAULT_STUDIO_HOST}; anything else exposes the studio to the network)`,
  )
  .option("--no-open", "do not open the browser")
  .option("--read-only", "browse only: no edits, creates, deletes or Cypher writes")
  .action(async (opts: { port?: number; host?: string; open?: boolean; readOnly?: boolean }) => {
    const studio = await runStudio(await loadConfig(process.cwd()), opts, version);
    const stop = () => {
      void studio.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

const importCmd = program.command("import").description("Import a schema from another tool");

importCmd
  .command("graphql")
  // Optional for commander only: `--url a.graphql` hands the file to the option (see below).
  .argument("[typeDefs...]", "@neo4j/graphql v7 type definitions (.graphql files)")
  .description(
    "Convert @neo4j/graphql v7 type definitions to schema.cyphra and report what was not converted",
  )
  .option("-o, --out <path>", "schema file to write (default: schema from cyphra.json)")
  .option("--merge", "merge into the existing schema, keeping its models, fields and comments")
  .option("--force", "overwrite an existing schema file")
  .option("--print", "write the schema to stdout instead of a file")
  .option(
    "--url [uri]",
    "read the database's uniqueness constraints to mark the fields they cover @id / @unique (no value: NEO4J_URI and the credentials of the environment, like cyphra pull)",
  )
  .option(
    "--id-fields <fields>",
    "mark these fields @id without a database: Type.field, comma-separated or repeated (Type: a @node type, a shared label or an interface)",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option(
    "--add-interface-labels",
    "map GraphQL interfaces to Cyphra interfaces even when their implementations do not carry the interface's label (the label must then be added to the existing nodes)",
  )
  .action(
    async (
      files: string[],
      opts: {
        out?: string;
        merge?: boolean;
        force?: boolean;
        print?: boolean;
        url?: string | true;
        idFields?: string[];
        addInterfaceLabels?: boolean;
      },
    ) => {
      // `--url a.graphql`: the optional value took a file, not a URI.
      let url = opts.url;
      if (typeof url === "string" && !url.includes("://")) {
        files = [url, ...files];
        url = true;
      }
      if (files.length === 0) {
        console.error("Give the type definitions files: cyphra import graphql <typeDefs...>");
        process.exitCode = 1;
        return;
      }
      process.exitCode = await runImportGraphql(process.cwd(), files, {
        ...opts,
        url,
        idFields: (opts.idFields ?? []).flatMap((f) => f.split(",")).filter(Boolean),
      });
    },
  );

importCmd
  .command("prisma")
  .argument("<schema...>", "Prisma schema: schema.prisma, several .prisma files or a schema folder")
  .description(
    "Convert a Prisma schema to schema.cyphra (foreign keys become edges) and report what was not converted",
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
      process.exitCode = await runImportPrisma(process.cwd(), files, opts);
    },
  );

importCmd
  .command("neogma")
  .argument("<models...>", "neogma model files (.ts, .js) or folders holding them")
  .description(
    "Convert neogma models (decorator classes or ModelFactory) to schema.cyphra and report what was not converted",
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
      process.exitCode = await runImportNeogma(process.cwd(), files, opts);
    },
  );

const graphqlCmd = program
  .command("graphql")
  .description("GraphQL: the native API's contract and @neo4j/graphql v7 compatibility");

graphqlCmd
  .command("print")
  .description(
    "Print the SDL of the native GraphQL API (schema.cyphra + graphql.config.ts), sorted; --check compares it with the committed file and lists breaking changes (exit 1 when they differ)",
  )
  .option(
    "--config <file>",
    "the API's config module (default: graphql.config.ts / .mts / .js / .mjs if present)",
  )
  .option("--export <name>", "export of the config module (default: default, else its only export)")
  .option(
    "-o, --out <file>",
    "write the SDL to this file (with --check: the file to compare, default schema.graphql)",
  )
  .option("--check", "fail when the committed SDL differs, listing breaking and dangerous changes")
  .action(async (opts: { config?: string; export?: string; out?: string; check?: boolean }) => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    process.exitCode = await runGraphqlPrint(cwd, config, opts);
  });

graphqlCmd
  .command("check")
  .argument("<typeDefs...>", "@neo4j/graphql v7 type definitions (.graphql files)")
  .description(
    "List every construct compat.v7.makeSchema does not serve (or v7 rejects), in one run, without a database; exits with 1 when there are issues",
  )
  .option("--json", "print { files, issues } as JSON (issues: code, message, location)")
  .action(async (files: string[], opts: { json?: boolean }) => {
    process.exitCode = await runGraphqlCheck(process.cwd(), files, opts);
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
