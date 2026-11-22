import { CyphraClient, detectDialect, type CyphraDialect } from "@cyphra/runtime";

/**
 * Build a {@link CyphraClient} from `NEO4J_URI`, `NEO4J_USERNAME` (or the older `NEO4J_USER`),
 * `NEO4J_PASSWORD` and optional `NEO4J_DATABASE`; for `dialect: "falkordb"`, from `FALKORDB_URL`
 * and `FALKORDB_GRAPH` instead.
 *
 * @param debug - Forwarded to client options.
 * @param dialect - The database's dialect (default `"neo4j"`).
 */
export function clientFromEnv(debug = false, dialect?: CyphraDialect): CyphraClient {
  if (dialect === "falkordb") return falkordbClientFromEnv(debug);
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

/** The FalkorDB server URL of the environment (`FALKORDB_URL`, default `redis://localhost:6379`). */
export function falkordbUrlFromEnv(): string {
  return process.env.FALKORDB_URL || "redis://localhost:6379";
}

/**
 * The FalkorDB graph of the environment (`FALKORDB_GRAPH`). Required: a FalkorDB server holds many
 * graphs, and commands such as `migrate reset` empty the one they are given.
 */
export function falkordbGraphFromEnv(): string {
  const graph = process.env.FALKORDB_GRAPH;
  if (!graph) {
    throw new Error(
      'Set FALKORDB_GRAPH (the graph to use) and FALKORDB_URL (default redis://localhost:6379) in the environment for "dialect": "falkordb"',
    );
  }
  return graph;
}

/**
 * A {@link CyphraClient} on FalkorDB from `FALKORDB_URL` (default `redis://localhost:6379`, with
 * credentials in the URL: `redis://user:password@host:6379`) and `FALKORDB_GRAPH`.
 */
function falkordbClientFromEnv(debug: boolean): CyphraClient {
  return new CyphraClient({
    falkordb: { url: falkordbUrlFromEnv(), graph: falkordbGraphFromEnv() },
    debug,
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
