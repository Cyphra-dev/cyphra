import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  NeogmaImportError,
  convertNeogmaModels,
  formatNeogmaImportReport,
  mergeNeogmaImport,
  printNeogmaImport,
  type NeogmaSource,
  type TypeScriptApi,
} from "@cyphra/schema";
import { writeImportedSchema, type ImportOutputOptions } from "./importOutput.js";

export type ImportNeogmaOptions = ImportOutputOptions;

/** Printed after the report: the schema is only the first step of a migration. */
export const NEOGMA_NEXT_STEPS = [
  "Next: review the report, run cyphra validate, then cyphra migrate dev for the constraints and",
  "indexes, and port the queries, hooks and methods to the Cyphra client:",
  "https://www.cyphra.dev/cli#import-from-neogma",
].join("\n");

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", ".next"]);
/** Test files and declaration files never define models. */
const SKIP_FILE = /\.d\.[cm]?ts$|\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** Files found in a directory are read only when they mention neogma or TypeBox. */
const MENTIONS = /neogma|typebox|ModelFactory|@Node\(/;

/** Source files of a path: the file itself, or the model files under a directory. */
async function sourceFiles(abs: string): Promise<{ file: string; listed: boolean }[]> {
  if (!(await stat(abs)).isDirectory()) return [{ file: abs, listed: true }];
  const out: { file: string; listed: boolean }[] = [];
  for (const entry of await readdir(abs, { withFileTypes: true })) {
    const child = path.join(abs, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      out.push(...(await sourceFiles(child)));
    } else if (entry.isFile() && SOURCE.test(entry.name) && !SKIP_FILE.test(entry.name)) {
      out.push({ file: child, listed: false });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * `cyphra import neogma <files…>`: read neogma model definitions (decorator classes or
 * `ModelFactory` calls) statically, write `schema.cyphra` and print a report of what was not
 * converted. The model files are parsed, never run.
 *
 * @returns The process exit code: `0` when the schema was written (even with warnings), `1` when
 * a file does not parse, no model is found or the output cannot be written.
 */
export async function runImportNeogma(
  cwd: string,
  inputs: readonly string[],
  opts: ImportNeogmaOptions = {},
): Promise<number> {
  if (opts.merge && opts.force) {
    console.error("Pass either --merge or --force, not both.");
    return 1;
  }
  const sources: NeogmaSource[] = [];
  for (const input of inputs) {
    let files: { file: string; listed: boolean }[];
    try {
      files = await sourceFiles(path.resolve(cwd, input));
    } catch {
      console.error(`Cannot read ${input}.`);
      return 1;
    }
    for (const { file, listed } of files) {
      const name = path.relative(cwd, file) || file;
      let body: string;
      try {
        body = await readFile(file, "utf8");
      } catch {
        console.error(`Cannot read ${name}.`);
        return 1;
      }
      if (listed || MENTIONS.test(body)) sources.push({ name, body });
    }
  }

  // Loaded here, so the other commands do not pay for the TypeScript compiler.
  const typescript = (await import("typescript")).default as TypeScriptApi;
  let result;
  try {
    result = convertNeogmaModels(sources, { typescript });
  } catch (err) {
    if (err instanceof NeogmaImportError) {
      console.error(`Cannot import the neogma models: ${err.message}`);
      return 1;
    }
    throw err;
  }
  const code = await writeImportedSchema(cwd, result, opts, {
    print: printNeogmaImport,
    merge: mergeNeogmaImport,
    report: formatNeogmaImportReport,
  });
  if (code === 0) console.warn(`\n${NEOGMA_NEXT_STEPS}`);
  return code;
}
