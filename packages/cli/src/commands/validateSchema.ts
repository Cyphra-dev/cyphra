import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  formatRule,
  parseSchema,
  resolveSchema,
  schemaWarnings,
  validateSchema,
  type ResolvedScalarField,
  type SchemaModel,
  type SchemaWarning,
} from "@cyphra/schema";
import type { CyphraConfig } from "../config.js";

/** Options of {@link runValidateSchema}. */
export type ValidateSchemaOptions = {
  /** Also list the validation rules of every field. */
  readonly verbose?: boolean;
};

/**
 * Lines listing the validation rules of the schema, one per field that has some
 * (`  User.email  @email`), grouped under a header; empty when no field has a rule.
 */
export function describeRules(model: SchemaModel): string[] {
  const rows: [string, string][] = [];
  const add = (owner: string, fields: readonly ResolvedScalarField[]) => {
    for (const f of fields) {
      if (f.rules?.length) rows.push([`${owner}.${f.name}`, f.rules.map(formatRule).join(" ")]);
    }
  };
  for (const n of model.nodes) {
    add(
      n.name,
      n.fields.filter((f): f is ResolvedScalarField => f.kind === "scalar"),
    );
  }
  for (const r of model.relationships) add(r.name, r.properties);
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map(([k]) => k.length));
  return [
    `Validation rules (${rows.length} field${rows.length === 1 ? "" : "s"}):`,
    ...rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`),
  ];
}

/**
 * `warning: schema.cyphra:12:21: …` lines for the {@link schemaWarnings} of a schema.
 *
 * @param file - The schema path to print (relative to the project root).
 */
export function warningLines(file: string, warnings: readonly SchemaWarning[]): string[] {
  return warnings.map((w) => {
    const at = w.loc ? `:${w.loc.start.line}:${w.loc.start.column}` : "";
    return `warning: ${file}${at}: ${w.message}`;
  });
}

/**
 * Parse and semantically validate `schema.cyphra`; print its warnings (on stderr) when it has any.
 *
 * @param cwd - Project root (for relative log paths).
 * @param config - Config with absolute schema path.
 */
export async function runValidateSchema(
  cwd: string,
  config: CyphraConfig,
  options: ValidateSchemaOptions = {},
): Promise<void> {
  const raw = await readFile(config.schema, "utf8");
  const doc = parseSchema(raw, { locations: true });
  validateSchema(doc);
  const model = resolveSchema(doc);
  const rel = path.relative(cwd, config.schema);
  for (const line of warningLines(rel, schemaWarnings(doc))) console.warn(line);
  console.log(`OK — ${rel} (${doc.declarations.length} declaration(s))`);
  if (options.verbose) {
    const lines = describeRules(model);
    console.log(lines.length ? lines.join("\n") : "No validation rules.");
  }
}
