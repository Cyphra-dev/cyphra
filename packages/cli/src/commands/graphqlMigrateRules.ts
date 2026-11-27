import { writeFile } from "node:fs/promises";
import path from "node:path";
import { migrate } from "@cyphra/graphql";
import { loadMigrationContext, type MigrationSourceOptions } from "./graphqlMigrate.js";

/** Options of {@link runGraphqlMigrateRules}. */
export type GraphqlMigrateRulesOptions = MigrationSourceOptions & {
  /** Write the draft to this file instead of stdout. */
  readonly out?: string;
  /** Module exporting the generated `CyphraTypeMap` (types the draft against the client). */
  readonly typeMap?: string;
  /** Print `{ code, entries, drafted, partial, todo }` as JSON. */
  readonly json?: boolean;
};

/**
 * `cyphra graphql migrate-rules <typeDefs…>`: draft the native `rules` / `authenticated` config
 * from the v7 `@authorization` / `@authentication` directives, as TypeScript to review. What the
 * native API cannot express is a `TODO(cyphra)` comment, never code. Nothing is applied.
 *
 * @returns The exit code: `0`.
 */
export async function runGraphqlMigrateRules(
  cwd: string,
  files: readonly string[],
  opts: GraphqlMigrateRulesOptions = {},
): Promise<number> {
  const { ctx } = await loadMigrationContext(cwd, { ...opts, typedefs: files });
  const draft = migrate.draftRules(ctx, { typeMapModule: opts.typeMap });
  if (opts.json) {
    console.log(JSON.stringify(draft, null, 2));
    return 0;
  }
  if (opts.out) {
    await writeFile(path.resolve(cwd, opts.out), draft.code);
  } else {
    process.stdout.write(draft.code);
  }
  const total = draft.entries.length;
  const summary = `${total} v7 rule${total === 1 ? "" : "s"}: ${draft.drafted} drafted, ${draft.partial} partly drafted, ${draft.todo} TODO.`;
  // The summary goes to stderr when the draft is on stdout, so `> rules.ts` keeps a valid module.
  if (opts.out) console.log(`Wrote ${opts.out}. ${summary} Review every rule before using it.`);
  else console.error(`\n${summary} Review every rule before using it.`);
  return 0;
}
