import {
  applyConstraintStatements,
  constraintStatementsFromSchema,
  indexStatementsFromSchema,
} from "@cyphra/migrator";
import { loadConfig } from "@cyphra/config";
import { clientFromEnv } from "../clientFromEnv.js";
import { parseSchemaAt, readSchemaFileUtf8 } from "../schemaSource.js";

/**
 * Parse `schema.cyphra` and apply generated constraints.
 *
 * @param cwd - Project root.
 */
export async function runPush(cwd: string): Promise<void> {
  const config = await loadConfig(cwd);
  const { rel, raw } = await readSchemaFileUtf8(cwd, config);
  const doc = parseSchemaAt(rel, raw);
  const constraints = constraintStatementsFromSchema(doc, config.provider);
  const indexes = indexStatementsFromSchema(doc, config.provider);
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
