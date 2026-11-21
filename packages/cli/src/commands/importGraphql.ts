import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  GraphQLImportError,
  convertGraphQLTypeDefs,
  formatImportReport,
  mergeImportedSchema,
  printImportedSchema,
} from "@cyphra/graphql";
import { writeImportedSchema, type ImportOutputOptions } from "./importOutput.js";

export type ImportGraphqlOptions = ImportOutputOptions;

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
  return writeImportedSchema(cwd, result, opts, {
    print: printImportedSchema,
    merge: mergeImportedSchema,
    report: formatImportReport,
  });
}
