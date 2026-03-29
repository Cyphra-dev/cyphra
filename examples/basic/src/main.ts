import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  constraintStatementsFromSchema,
  CyphraClient,
  cypher,
  eq,
  indexStatementsFromSchema,
  node,
  parseSchema,
  printSchemaDocument,
  prop,
  schemaIntegrationHints,
  select,
} from "cyphra";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

async function main(): Promise<void> {
  const schemaPath = path.join(projectRoot, "schema.cyphra");
  const source = await readFile(schemaPath, "utf8");
  const doc = parseSchema(source);

  console.log("--- Canonical schema (printSchemaDocument) ---\n");
  console.log(printSchemaDocument(doc));

  const userId = "example-user-id";
  const tagged = cypher`MATCH (u:User) WHERE u.id = ${userId} RETURN u LIMIT 1`;
  console.log("--- Tagged cypher ---");
  console.log(tagged.text);
  console.log("param keys:", Object.keys(tagged.params));

  const u = node("User", "u");
  const built = select()
    .match(`(${u.alias}:${u.label})`)
    .where(eq(prop(u.alias, "id"), userId))
    .returnStar()
    .toCypher();
  console.log("\n--- SelectQuery ---");
  console.log(built.text);
  console.log("param keys:", Object.keys(built.params));

  const hints = schemaIntegrationHints(doc);
  if (hints.length > 0) {
    console.log("\n--- Schema hints (relationship models) ---");
    for (const h of hints) {
      console.log("-", h);
    }
  }

  console.log("\n--- DDL preview: constraints (cyphra push) ---");
  for (const stmt of constraintStatementsFromSchema(doc)) {
    console.log(stmt);
  }
  console.log("\n--- DDL preview: range indexes ---");
  for (const stmt of indexStatementsFromSchema(doc)) {
    console.log(stmt);
  }

  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    console.log("\n(Set NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD for a live `RETURN 1` round-trip.)");
    return;
  }

  const client = new CyphraClient({ uri, user, password });
  try {
    await client.withSession(async (session) => {
      const rows = await client.queryRecords(session, cypher`RETURN 1 AS ok`);
      console.log("\n--- Live query ---");
      console.log(rows);
    });
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
