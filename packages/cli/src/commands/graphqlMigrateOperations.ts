import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { migrate } from "@cyphra/graphql";
import type { DocumentStatus, DefinitionTranslation } from "@cyphra/graphql";
import {
  expandFiles,
  extractDocuments,
  loadMigrationContext,
  locate,
  type MigrationSourceOptions,
} from "./graphqlMigrate.js";

/** Options of {@link runGraphqlMigrateOperations}. */
export type GraphqlMigrateOperationsOptions = MigrationSourceOptions & {
  /** Print what would change; write nothing. */
  readonly dryRun?: boolean;
  /** Write nothing; exit with 1 when a v7 operation is left (translatable or not). */
  readonly check?: boolean;
  /** More template tags / functions holding documents (`doc` for `doc<T>(\`…\`)`). */
  readonly tag?: readonly string[];
  /** Do not write `# cyphra: …` comments. */
  readonly comments?: boolean;
  /** Print the report as JSON. */
  readonly json?: boolean;
};

/** One document of the report. */
type ReportDocument = {
  file: string;
  location: string;
  status: DocumentStatus | "skipped";
  operations: string[];
  issues: { kind: string; message: string; location: string }[];
  output?: string;
};

function operationLabel(d: DefinitionTranslation): string {
  return d.name ?? `(anonymous ${d.kind})`;
}

/**
 * `cyphra graphql migrate-operations <files…>`: rewrite the v7 operations of `.graphql` files and
 * of `gql` / `graphql` templates into native operations, and report what cannot be translated,
 * with its location. `--dry-run` prints the new documents, `--check` fails when v7 operations are
 * left (for CI).
 *
 * @returns The exit code: `0`; with `--check`, `1` when a v7 operation is left.
 */
export async function runGraphqlMigrateOperations(
  cwd: string,
  patterns: readonly string[],
  opts: GraphqlMigrateOperationsOptions = {},
): Promise<number> {
  const { ctx, configFile } = await loadMigrationContext(cwd, opts);
  const files = await expandFiles(cwd, patterns);
  const tags = (opts.tag ?? []).flatMap((t) => t.split(",")).filter(Boolean);
  const report: ReportDocument[] = [];
  const rewritten: string[] = [];
  for (const abs of files) {
    const file = path.relative(cwd, abs) || abs;
    const text = await readFile(abs, "utf8");
    const docs = extractDocuments(abs, text, tags);
    let out = "";
    let cursor = 0;
    for (const d of docs) {
      if (d.skipped) {
        // Only report templates that look like v7 operations.
        report.push({
          file,
          location: locate(file, text, d.start),
          status: "skipped",
          operations: [],
          issues: [{ kind: "blocking", message: d.skipped, location: locate(file, text, d.start) }],
        });
        continue;
      }
      if (!d.text.trim()) continue;
      const t = migrate.translateDocument(ctx, d.text, { comments: opts.comments ?? true });
      const at = (loc?: number) => locate(file, text, d.start + (loc ?? 0));
      report.push({
        file,
        location: at(t.definitions[0]?.loc),
        status: t.status,
        operations: t.definitions.filter((x) => x.kind === "operation").map(operationLabel),
        issues: t.issues.map((i) => ({ kind: i.kind, message: i.message, location: at(i.loc) })),
        ...(t.changed ? { output: t.output } : {}),
      });
      if (t.changed) {
        out += text.slice(cursor, d.start) + t.output;
        cursor = d.end;
      }
    }
    if (cursor > 0) {
      out += text.slice(cursor);
      rewritten.push(file);
      if (!opts.dryRun && !opts.check) await writeFile(abs, out);
    }
  }

  const count = (s: ReportDocument["status"]) => report.filter((r) => r.status === s).length;
  const left = report.filter(
    (r) => r.status === "translated" || r.status === "blocked" || r.status === "skipped",
  );
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          config: configFile ?? null,
          documents: report,
          summary: {
            translated: count("translated"),
            blocked: count("blocked"),
            native: count("native"),
            invalid: count("invalid"),
            skipped: count("skipped"),
            files: rewritten,
          },
        },
        null,
        2,
      ),
    );
  } else {
    if (!configFile) {
      console.log(
        "No graphql.config.ts: translated against a native API with every operation on (pass --config to use the API's own config).\n",
      );
    }
    const STATUS: Record<ReportDocument["status"], string> = {
      translated: "translated",
      blocked: "NOT TRANSLATED",
      native: "already native",
      invalid: "not a v7 document",
      skipped: "skipped",
    };
    for (const r of report) {
      if (r.status === "native") continue;
      const ops = r.operations.length ? ` ${r.operations.join(", ")}` : "";
      console.log(`${r.location}  ${STATUS[r.status]}${ops}`);
      for (const i of r.issues) {
        const kind =
          i.kind === "blocking" ? "cannot translate" : i.kind === "known" ? "differs" : "note";
        console.log(`  ${i.location}  ${kind}: ${i.message}`);
      }
      if (opts.dryRun && r.output !== undefined && r.status === "translated") {
        console.log(`${r.output.replace(/^/gm, "  | ")}`);
      }
    }
    const withNotes = report.filter((r) => r.status === "translated" && r.issues.length).length;
    const parts = [
      `${count("translated")} translated${withNotes ? ` (${withNotes} with notes)` : ""}`,
      `${count("blocked")} not translated`,
      ...(count("skipped") ? [`${count("skipped")} skipped`] : []),
      ...(count("native") ? [`${count("native")} already native`] : []),
      ...(count("invalid") ? [`${count("invalid")} not v7 documents`] : []),
    ];
    const verb = opts.dryRun || opts.check ? "would be rewritten" : "rewritten";
    console.log(
      `\n${report.length} document${report.length === 1 ? "" : "s"} in ${files.length} file${files.length === 1 ? "" : "s"}: ${parts.join(", ")}. ${rewritten.length} file${rewritten.length === 1 ? "" : "s"} ${verb}.`,
    );
  }
  if (opts.check) return left.length ? 1 : 0;
  return 0;
}
