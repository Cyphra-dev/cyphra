import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  PrismaImportError,
  convertPrismaSchema,
  formatPrismaImportReport,
  mergePrismaImport,
  printPrismaImport,
  type PrismaSource,
} from "@cyphra/schema";
import { writeImportedSchema, type ImportOutputOptions } from "./importOutput.js";

export type ImportPrismaOptions = ImportOutputOptions;

/** Printed after the report: the schema is only the first step of a migration. */
export const PRISMA_NEXT_STEPS = [
  "Next: review the report, then move the data (export each table, createMany the nodes, then",
  "connect the edges from the foreign keys) and swap Prisma Client calls for the Cyphra client:",
  "https://www.cyphra.dev/guides/migrate-from-prisma",
].join("\n");

/** The `.prisma` files of a path: the file itself, or every `.prisma` file under a directory. */
async function prismaFiles(abs: string): Promise<string[]> {
  if (!(await stat(abs)).isDirectory()) return [abs];
  const out: string[] = [];
  for (const entry of await readdir(abs, { withFileTypes: true })) {
    const child = path.join(abs, entry.name);
    if (entry.isDirectory() && entry.name !== "migrations" && entry.name !== "node_modules") {
      out.push(...(await prismaFiles(child)));
    } else if (entry.isFile() && entry.name.endsWith(".prisma")) {
      out.push(child);
    }
  }
  return out.sort();
}

/**
 * `cyphra import prisma <schema…>`: convert a Prisma schema (a `schema.prisma` file, several
 * files, or a multi-file schema folder) to `schema.cyphra` and print a report of what was not
 * converted.
 *
 * @returns The process exit code: `0` when the schema was written (even with warnings), `1` when
 * the Prisma schema is invalid or the output cannot be written.
 */
export async function runImportPrisma(
  cwd: string,
  inputs: readonly string[],
  opts: ImportPrismaOptions = {},
): Promise<number> {
  if (opts.merge && opts.force) {
    console.error("Pass either --merge or --force, not both.");
    return 1;
  }
  const sources: PrismaSource[] = [];
  for (const input of inputs) {
    let files: string[];
    try {
      files = await prismaFiles(path.resolve(cwd, input));
    } catch {
      console.error(`Cannot read ${input}.`);
      return 1;
    }
    if (files.length === 0) {
      console.error(`No .prisma file in ${input}.`);
      return 1;
    }
    for (const abs of files) {
      try {
        sources.push({ name: path.relative(cwd, abs) || abs, body: await readFile(abs, "utf8") });
      } catch {
        console.error(`Cannot read ${path.relative(cwd, abs) || abs}.`);
        return 1;
      }
    }
  }

  let result;
  try {
    result = convertPrismaSchema(sources);
  } catch (err) {
    if (err instanceof PrismaImportError) {
      console.error(`Invalid Prisma schema: ${err.message}`);
      return 1;
    }
    throw err;
  }
  const code = await writeImportedSchema(cwd, result, opts, {
    print: printPrismaImport,
    merge: mergePrismaImport,
    report: formatPrismaImportReport,
  });
  if (code === 0) console.warn(`\n${PRISMA_NEXT_STEPS}`);
  return code;
}
