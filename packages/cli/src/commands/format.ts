import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatSchema, outInOf, parseSchemaSyntax } from "@cyphra/schema";
import type { CyphraConfig } from "../config.js";

/** Relation fields of `source` written with `@relationship(…)` that have an `@out` / `@in` form. */
export function outInCandidates(source: string): number {
  let n = 0;
  for (const d of parseSchemaSyntax(source).declarations) {
    if (d.kind !== "Node") continue;
    for (const f of d.fields) {
      if (f.kind === "Relational" && f.decorators.some((x) => outInOf(x))) n++;
    }
  }
  return n;
}

/**
 * Reformat `schema.cyphra` in place, keeping comments (`formatSchema`). With `check`, write
 * nothing and return 1 when the file is not formatted (for CI). With `codemod`, also rewrite
 * `@relationship(…)` fields into `@out(…)` / `@in(…)`; without it, a hint says how many could be.
 *
 * @param cwd - Project root (for relative log paths).
 * @param config - Config with absolute schema path.
 * @param opts - `check`: report instead of writing; `codemod`: rewrite older syntax.
 * @returns Process exit code.
 */
export async function runFormat(
  cwd: string,
  config: CyphraConfig,
  opts: { check?: boolean; codemod?: boolean } = {},
): Promise<number> {
  const raw = await readFile(config.schema, "utf8");
  const formatted = formatSchema(raw, { codemod: opts.codemod === true });
  const rel = path.relative(cwd, config.schema);
  const hint = () => {
    const n = opts.codemod ? 0 : outInCandidates(raw);
    if (n) {
      console.log(
        `hint: ${n} relation field${n === 1 ? "" : "s"} use${n === 1 ? "s" : ""} @relationship(…): \`cyphra format --codemod\` rewrites ${n === 1 ? "it" : "them"} into @out(…) / @in(…).`,
      );
    }
  };
  if (formatted === raw) {
    console.log(`${rel} is formatted.`);
    hint();
    return 0;
  }
  if (opts.check) {
    console.error(
      `${rel} is not formatted (run \`cyphra format${opts.codemod ? " --codemod" : ""}\`).`,
    );
    return 1;
  }
  await writeFile(config.schema, formatted, "utf8");
  console.log(`Formatted ${rel}.`);
  hint();
  return 0;
}
