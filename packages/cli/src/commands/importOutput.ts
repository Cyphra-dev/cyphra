import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseSchema, resolveSchema, type ImportIssue, type ImportResult } from "@cyphra/schema";
import { loadConfig } from "../config.js";

/** Options shared by the `cyphra import …` commands. */
export type ImportOutputOptions = {
  /** Output schema path (default: `schema` from cyphra.json, else `./schema.cyphra`). */
  out?: string;
  /** Merge into the existing schema instead of writing a new one. */
  merge?: boolean;
  /** Overwrite an existing output file. */
  force?: boolean;
  /** Write the schema to stdout instead of a file. */
  print?: boolean;
};

/** How one importer prints, merges and reports. */
export type ImportFormat = {
  readonly print: (result: ImportResult) => string;
  readonly merge: (
    existing: string,
    result: ImportResult,
  ) => { source: string; issues: ImportIssue[] };
  readonly report: (issues: readonly ImportIssue[]) => string;
};

export async function exists(file: string): Promise<boolean> {
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
 * Write (or merge, or print) an imported schema and print its report on stderr.
 *
 * @returns The process exit code: `0` when the schema was written (even with warnings), `1` when
 * the output cannot be written or merged.
 */
export async function writeImportedSchema(
  cwd: string,
  result: ImportResult,
  opts: ImportOutputOptions,
  format: ImportFormat,
): Promise<number> {
  const out = opts.out ? path.resolve(cwd, opts.out) : await defaultOut(cwd);
  const rel = path.relative(cwd, out) || out;
  let source: string;
  const issues = [...result.issues];
  if (opts.merge && (await exists(out))) {
    try {
      const merged = format.merge(await readFile(out, "utf8"), result);
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
    source = format.print(result);
  }
  // The output must round-trip through our own parser and resolver.
  resolveSchema(parseSchema(source));

  if (opts.print) {
    process.stdout.write(source);
  } else {
    await writeFile(out, source, "utf8");
    const decls = result.document.declarations;
    const nodes = decls.filter((d) => d.kind === "Node").length;
    const rels = decls.filter((d) => d.kind === "Relationship").length;
    console.log(
      `${opts.merge ? "Merged into" : "Wrote"} ${rel} (${nodes} node(s), ${rels} relationship model(s))`,
    );
  }
  const report = format.report(issues);
  if (report) {
    // stderr, so `--print > schema.cyphra` keeps the schema clean.
    console.warn(`\n${report}`);
  } else {
    console.warn("Everything was converted.");
  }
  return 0;
}
