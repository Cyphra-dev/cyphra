import { CyphraClient, detectDialect, type CyphraDialect } from "@cyphra/runtime";

/**
 * Build a {@link CyphraClient} from `NEO4J_URI`, `NEO4J_USERNAME` (or the older `NEO4J_USER`),
 * `NEO4J_PASSWORD` and optional `NEO4J_DATABASE`.
 *
 * @param debug - Forwarded to client options.
 * @param dialect - The database's dialect (default `"neo4j"`).
 */
export function clientFromEnv(debug = false, dialect?: CyphraDialect): CyphraClient {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USERNAME || process.env.NEO4J_USER;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    throw new Error("Set NEO4J_URI, NEO4J_USERNAME and NEO4J_PASSWORD in the environment");
  }
  return new CyphraClient({
    uri,
    user,
    password,
    database: process.env.NEO4J_DATABASE,
    debug,
    ...(dialect ? { dialect } : {}),
  });
}

/**
 * {@link clientFromEnv} with the dialect of `cyphra.json`, or, when it sets none, the one the
 * server announces (Memgraph's Bolt agent names it; a note suggests setting it, since `migrate
 * dev` writes DDL for the configured dialect without connecting). A server that cannot be
 * reached is left to fail on the command's first statement.
 */
export async function clientForConfig(
  config: { readonly dialect?: CyphraDialect },
  debug = false,
): Promise<CyphraClient> {
  if (config.dialect) return clientFromEnv(debug, config.dialect);
  const client = clientFromEnv(debug);
  let detected: CyphraDialect;
  try {
    detected = await detectDialect(client);
  } catch {
    return client;
  }
  if (detected === "neo4j") return client;
  await client.close();
  console.warn(
    `note: the server is Memgraph; set "dialect": "memgraph" in cyphra.json so that \`cyphra migrate dev\` writes Memgraph DDL.`,
  );
  return clientFromEnv(debug, detected);
}
