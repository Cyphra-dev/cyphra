import { readFile } from "node:fs/promises";
import { constraintStatementsFromSchema, indexStatementsFromSchema } from "@cyphra/migrator";
import { parseSchema } from "@cyphra/schema";
import type { CyphraConfig } from "../config.js";

/**
 * Print `CREATE CONSTRAINT` / `CREATE RANGE INDEX` lines for the schema (same order as `cyphra push`).
 * Does not connect to Neo4j.
 *
 * @param config - Config with absolute schema path.
 */
export async function runSchemaDdl(config: CyphraConfig): Promise<void> {
  const source = await readFile(config.schema, "utf8");
  const doc = parseSchema(source);
  for (const stmt of constraintStatementsFromSchema(doc)) {
    console.log(stmt);
  }
  for (const stmt of indexStatementsFromSchema(doc)) {
    console.log(stmt);
  }
}
