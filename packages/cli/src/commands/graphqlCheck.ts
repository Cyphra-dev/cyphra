import { readFile } from "node:fs/promises";
import path from "node:path";
import { compat, type TypeDefsIssue } from "@cyphra/graphql";

/** Options of {@link runGraphqlCheck}. */
export type GraphqlCheckOptions = {
  /** Print `{ files, issues }` as JSON instead of the text report. */
  readonly json?: boolean;
};

/** `user.graphql:3:5` / `user.graphql` / `User.name`: where an issue is, for the text report. */
function position(issue: TypeDefsIssue): string {
  const { source, line, column, type, field } = issue.location;
  if (line !== undefined) {
    return `${source ?? "<typeDefs>"}:${line}${column !== undefined ? `:${column}` : ""}`;
  }
  return source ?? (type ? (field ? `${type}.${field}` : type) : "<typeDefs>");
}

/**
 * `cyphra graphql check <files…>`: list every construct of `@neo4j/graphql` v7 type definitions that
 * `compat.v7.makeSchema` does not serve (or that v7 rejects too), in one run, without a database.
 * The files are checked together, like the type definitions of one `makeSchema` call.
 *
 * @returns The process exit code: `0` when `makeSchema` accepts the type definitions, `1` when
 * there are issues or a file cannot be read.
 */
export async function runGraphqlCheck(
  cwd: string,
  files: readonly string[],
  opts: GraphqlCheckOptions = {},
): Promise<number> {
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
  const issues = compat.v7.checkTypeDefs(sources);
  if (opts.json) {
    console.log(JSON.stringify({ files: sources.map((s) => s.name), issues }, null, 2));
    return issues.length ? 1 : 0;
  }
  const fileCount = `${sources.length} file${sources.length === 1 ? "" : "s"}`;
  if (!issues.length) {
    console.log(`OK — compat.v7.makeSchema accepts the type definitions (${fileCount}).`);
    return 0;
  }
  const rows = issues.map((i) => [position(i), i.code, i.message] as const);
  const width = Math.max(...rows.map(([p]) => p.length));
  const codeWidth = Math.max(...rows.map(([, c]) => c.length));
  for (const [p, code, message] of rows) {
    console.log(`${p.padEnd(width)}  ${code.padEnd(codeWidth)}  ${message}`);
  }
  const count = (code: string) => issues.filter((i) => i.code === code).length;
  const kinds = [
    [count("UNSUPPORTED"), "unsupported by @cyphra/graphql"],
    [count("INVALID"), "invalid for @neo4j/graphql 7"],
    [count("SYNTAX"), "syntax error"],
  ]
    .filter(([n]) => n)
    .map(([n, what]) => `${n} ${what}`);
  console.log(
    `\n${issues.length} issue${issues.length === 1 ? "" : "s"} in ${fileCount} (${kinds.join(", ")}).`,
  );
  return 1;
}
