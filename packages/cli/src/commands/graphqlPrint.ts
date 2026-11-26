import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { native, type GraphQLConfig } from "@cyphra/graphql";
import { parseSchema, resolveSchema, validateSchema } from "@cyphra/schema";
import { buildSchema, findBreakingChanges, findDangerousChanges } from "graphql";
import ts from "typescript";
import type { CyphraConfig } from "../config.js";

/** Options of {@link runGraphqlPrint}. */
export type GraphqlPrintOptions = {
  /** The API's config module (default: `graphql.config.ts`, `.mts`, `.js` or `.mjs` if present). */
  readonly config?: string;
  /** Export of the config module holding the config (default: `default`, else the only export). */
  readonly export?: string;
  /** Write the SDL to this file instead of stdout. */
  readonly out?: string;
  /** Compare with the committed file (`out`, default `schema.graphql`) instead of writing it. */
  readonly check?: boolean;
};

const DEFAULT_CONFIGS = [
  "graphql.config.ts",
  "graphql.config.mts",
  "graphql.config.js",
  "graphql.config.mjs",
];

/**
 * Import a config module. A `.ts` / `.mts` file Node cannot import (no type stripping) is
 * transpiled next to itself (so its relative imports resolve), imported, then removed.
 */
async function importModule(file: string): Promise<Record<string, unknown>> {
  const url = pathToFileURL(file).href;
  try {
    return (await import(url)) as Record<string, unknown>;
  } catch (err) {
    const code = (err as { code?: string }).code;
    const isTs = /\.m?ts$/.test(file);
    if (!isTs || (code !== "ERR_UNKNOWN_FILE_EXTENSION" && !(err instanceof SyntaxError)))
      throw err;
  }
  const source = await readFile(file, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
    fileName: file,
  }).outputText;
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.mjs`);
  await writeFile(tmp, js);
  try {
    return (await import(pathToFileURL(tmp).href)) as Record<string, unknown>;
  } finally {
    await rm(tmp, { force: true });
  }
}

/** The config the module exports: `name`, `default`, or its only export. */
function pickExport(mod: Record<string, unknown>, file: string, name?: string): GraphQLConfig {
  if (name !== undefined) {
    if (!(name in mod)) throw new Error(`${file} has no export "${name}".`);
    return mod[name] as GraphQLConfig;
  }
  if (mod.default !== undefined) return mod.default as GraphQLConfig;
  const keys = Object.keys(mod).filter((k) => typeof mod[k] === "object" && mod[k] !== null);
  if (keys.length === 1) return mod[keys[0]!] as GraphQLConfig;
  throw new Error(
    `${file} exports ${keys.length ? keys.join(", ") : "no config"}: pass --export <name> (the defineGraphQL config).`,
  );
}

/**
 * `cyphra graphql print`: the SDL of the native GraphQL API for `schema.cyphra` and the API's
 * config, sorted (the contract to commit). `--out` writes it to a file; `--check` compares it with
 * the committed file and lists breaking and dangerous changes (for CI).
 *
 * @returns The process exit code: `0`, or `1` when `--check` finds a difference or on an error.
 */
export async function runGraphqlPrint(
  cwd: string,
  config: CyphraConfig,
  opts: GraphqlPrintOptions = {},
): Promise<number> {
  const doc = parseSchema(await readFile(config.schema, "utf8"));
  validateSchema(doc);
  const model = resolveSchema(doc);

  let apiConfig: GraphQLConfig | undefined;
  const configFile = opts.config
    ? path.resolve(cwd, opts.config)
    : DEFAULT_CONFIGS.map((f) => path.join(cwd, f)).find((f) => existsSync(f));
  if (configFile) {
    if (!existsSync(configFile)) {
      console.error(`Cannot find ${opts.config}.`);
      return 1;
    }
    apiConfig = pickExport(
      await importModule(configFile),
      path.relative(cwd, configFile),
      opts.export,
    );
  }
  const sdl = native.printSchema(model, apiConfig);

  if (!opts.check) {
    if (opts.out) {
      await writeFile(path.resolve(cwd, opts.out), sdl);
      console.log(`Wrote ${opts.out}.`);
    } else process.stdout.write(sdl);
    return 0;
  }

  const committedPath = path.resolve(cwd, opts.out ?? "schema.graphql");
  const rel = path.relative(cwd, committedPath);
  if (!existsSync(committedPath)) {
    console.error(`${rel} does not exist: run cyphra graphql print --out ${rel} and commit it.`);
    return 1;
  }
  const committed = await readFile(committedPath, "utf8");
  if (committed === sdl) {
    console.log(`OK — ${rel} is up to date.`);
    return 0;
  }
  console.log(`${rel} differs from the API generated from the schema and config.`);
  try {
    const before = buildSchema(committed);
    const after = buildSchema(sdl);
    const breaking = findBreakingChanges(before, after);
    const dangerous = findDangerousChanges(before, after);
    for (const c of breaking) console.log(`  BREAKING  ${c.description}`);
    for (const c of dangerous) console.log(`  DANGEROUS ${c.description}`);
    if (!breaking.length && !dangerous.length) console.log("  (additive or cosmetic changes only)");
  } catch (err) {
    console.log(`  (cannot compare: ${err instanceof Error ? err.message : String(err)})`);
  }
  console.log(`Run cyphra graphql print --out ${rel} to update it.`);
  return 1;
}
