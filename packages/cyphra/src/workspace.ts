import { loadConfig, type CyphraConfig } from "@cyphra/config";
import { parseSchemaFile, validateSchema, type SchemaDocument } from "@cyphra/schema";
import { CyphraClient, CyphraNeo4j } from "@cyphra/runtime";

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (v === undefined || v === "") {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return v;
}

export type CyphraWorkspace = {
  readonly config: CyphraConfig;
  readonly doc: SchemaDocument;
  readonly client: CyphraClient;
};

/**
 * Load project **`cyphra.config.ts`** / **`cyphra.json`**, parse and validate the **`.cyphra`** schema,
 * and build a **`CyphraClient`** from **`NEO4J_URI`**, **`NEO4J_USER`**, **`NEO4J_PASSWORD`** (optional **`NEO4J_DATABASE`**).
 *
 * Uses the same config resolution as the **`cyphra`** CLI. Caller should **`await client.close()`** when done.
 */
export async function loadCyphraWorkspace(
  cwd: string,
  options?: { readonly env?: NodeJS.ProcessEnv },
): Promise<CyphraWorkspace> {
  const env = options?.env ?? process.env;
  const config = await loadConfig(cwd);
  const doc = await parseSchemaFile(config.schema);
  validateSchema(doc);
  const client = new CyphraClient({
    adapter: new CyphraNeo4j({
      uri: requireEnv(env, "NEO4J_URI"),
      user: requireEnv(env, "NEO4J_USER"),
      password: requireEnv(env, "NEO4J_PASSWORD"),
      database: env.NEO4J_DATABASE,
    }),
  });
  return { config, doc, client };
}
