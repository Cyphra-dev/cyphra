import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseSchema, resolveSchema } from "@cyphra/schema";
import { loadConfig } from "../config.js";
import {
  GraphQLImportError,
  convertGraphQLTypeDefs,
  formatImportReport,
  mergeImportedSchema,
  printImportedSchema,
} from "../import/graphql/index.js";

export type ImportGraphqlOptions = {
  /** Output schema path (default: `schema` from cyphra.json, else `./schema.cyphra`). */
  out?: string;
  /** Merge into the existing schema instead of writing a new one. */
  merge?: boolean;
  /** Overwrite an existing output file. */
  force?: boolean;
  /** Write the schema to stdout instead of a file. */
  print?: boolean;
};

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

async function defaultOut(cwd: string): Promise<string> {
  if (await exists(path.join(cwd, "cyphra.json"))) return (await loadConfig(cwd)).schema;
  return path.join(cwd, "schema.cyphra");
}

/**
 * `cyphra import graphql <files…>`: convert `@neo4j/graphql` v7 type definitions to
 * `schema.cyphra` and print a report of what was not converted.
 *
 * @returns The process exit code: `0` when the schema was written (even with warnings), `1` when
 * the type definitions are invalid or the output cannot be written.
 */
export async function runImportGraphql(
  cwd: string,
  files: readonly string[],
  opts: ImportGraphqlOptions = {},
): Promise<number> {
  if (opts.merge && opts.force) {
    console.error("Pass either --merge or --force, not both.");
    return 1;
  }
  const sources = [];
  for (const f of files) {
    const abs = path.resolve(cwd, f);
    try {
      sources.push({ name: path.relative(cwd, abs) || f, body: await readFile(abs, "utf8") });
    } catch {
      console.error(`Cannot read ${f}.`);
      return 1;
    }
  }

  let result;
  try {
    result = convertGraphQLTypeDefs(sources);
  } catch (err) {
    if (err instanceof GraphQLImportError) {
      console.error(`Invalid type definitions: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const out = opts.out ? path.resolve(cwd, opts.out) : await defaultOut(cwd);
  const rel = path.relative(cwd, out) || out;
  let source: string;
  const issues = [...result.issues];
  if (opts.merge && (await exists(out))) {
    try {
      const merged = mergeImportedSchema(await readFile(out, "utf8"), result);
      source = merged.source;
      issues.push(...merged.issues);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  } else {
    if (!opts.print && !opts.merge && !opts.force && (await exists(out))) {
      console.error(`${rel} already exists: pass --merge to add to it or --force to overwrite it.`);
      return 1;
    }
    source = printImportedSchema(result);
  }
  // The output must round-trip through our own parser and resolver.
  resolveSchema(parseSchema(source));

  if (opts.print) {
    process.stdout.write(source);
  } else {
    await writeFile(out, source, "utf8");
    const decls = result.document.declarations;
    const nodes = decls.filter((d) => d.kind === "Node").length;
    console.log(
      `${opts.merge ? "Merged into" : "Wrote"} ${rel} (${nodes} node(s), ${decls.length - nodes} relationship model(s))`,
    );
  }
  const report = formatImportReport(issues);
  if (report) {
    // stderr, so `--print > schema.cyphra` keeps the schema clean.
    console.warn(`\n${report}`);
  } else {
    console.warn("Everything was converted.");
  }
  return 0;
}
