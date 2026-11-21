import { readFile } from "node:fs/promises";
import {
  ddlForDialect,
  constraintStatementsFromSchema,
  fulltextIndexStatementsFromSchema,
  indexStatementsFromSchema,
  vectorIndexStatementsFromSchema,
} from "@cyphra/migrator";
import { parseSchema } from "@cyphra/schema";
import type { CyphraConfig } from "../config.js";

/**
 * Print `CREATE CONSTRAINT` / `CREATE RANGE INDEX` / `CREATE VECTOR INDEX` / `CREATE FULLTEXT INDEX` lines for the schema (same order as `cyphra push`).
 * Does not connect to the database; written in Memgraph's syntax with `"dialect": "memgraph"`.
 *
 * @param config - Config with absolute schema path.
 */
export async function runSchemaDdl(config: CyphraConfig): Promise<void> {
  const source = await readFile(config.schema, "utf8");
  const doc = parseSchema(source);
  const statements = [
    ...constraintStatementsFromSchema(doc),
    ...indexStatementsFromSchema(doc),
    ...vectorIndexStatementsFromSchema(doc),
    ...fulltextIndexStatementsFromSchema(doc),
  ];
  // Memgraph's syntax when cyphra.json sets "dialect": "memgraph".
  for (const stmt of ddlForDialect(statements, config.dialect ?? "neo4j")) {
    console.log(stmt);
  }
}
