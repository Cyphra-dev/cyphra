import { constraintStatementsFromSchema, indexStatementsFromSchema } from "@cyphra/migrator";
import type { CyphraConfig } from "@cyphra/config";
import { parseSchemaAt, readSchemaFileUtf8 } from "../schemaSource.js";

/**
 * Print `CREATE CONSTRAINT` / `CREATE RANGE INDEX` lines for the schema (same order as `cyphra push`).
 * Does not connect to Neo4j.
 *
 * @param cwd - Project root (for error messages).
 * @param config - Config with absolute schema path.
 */
export async function runSchemaDdl(cwd: string, config: CyphraConfig): Promise<void> {
  const { rel, raw } = await readSchemaFileUtf8(cwd, config);
  const doc = parseSchemaAt(rel, raw);
  for (const stmt of constraintStatementsFromSchema(doc, config.provider)) {
    console.log(stmt);
  }
  for (const stmt of indexStatementsFromSchema(doc, config.provider)) {
    console.log(stmt);
  }
}
