import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  constraintStatementsFromSchema,
  fulltextIndexStatementsFromSchema,
  indexStatementsFromSchema,
  parseSchema,
  vectorIndexStatementsFromSchema,
} from "cyphra";
import type { Db } from "./cyphra.gen.js";

const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schema.cyphra");

/**
 * Create the constraints and the vector and full-text indexes of schema.cyphra (what
 * `cyphra push` does), then wait until every index is ONLINE: a query against an index that is
 * still populating fails or misses nodes.
 */
export async function applySchema(db: Db): Promise<void> {
  const doc = parseSchema(await readFile(schemaPath, "utf8"));
  const statements = [
    ...constraintStatementsFromSchema(doc),
    ...indexStatementsFromSchema(doc),
    ...vectorIndexStatementsFromSchema(doc),
    ...fulltextIndexStatementsFromSchema(doc),
  ];
  await db.$client.withSession(async (session) => {
    for (const statement of statements) await session.run(statement);
    await session.run("CALL db.awaitIndexes(300)");
  });
}
