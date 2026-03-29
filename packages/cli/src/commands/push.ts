import { readFile } from "node:fs/promises";
import {
  applyConstraintStatements,
  constraintStatementsFromSchema,
  indexStatementsFromSchema,
} from "@cyphra/migrator";
import { parseSchema } from "@cyphra/schema";
import { loadConfig } from "../config.js";
import { clientFromEnv } from "../clientFromEnv.js";

/**
 * Parse `schema.cyphra` and apply generated constraints.
 *
 * @param cwd - Project root.
 */
export async function runPush(cwd: string): Promise<void> {
  const config = await loadConfig(cwd);
  const source = await readFile(config.schema, "utf8");
  const doc = parseSchema(source);
  const constraints = constraintStatementsFromSchema(doc);
  const indexes = indexStatementsFromSchema(doc);
  const statements = [...constraints, ...indexes];
  const client = clientFromEnv(false);
  try {
    await applyConstraintStatements(client, statements);
    console.log(
      `Applied ${constraints.length} constraint statement(s) and ${indexes.length} range index statement(s)`,
    );
  } finally {
    await client.close();
  }
}
