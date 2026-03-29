import { CyphraClient } from "@cyphra/runtime";

/**
 * Build a {@link CyphraClient} from `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, optional `NEO4J_DATABASE`.
 *
 * @param debug - Forwarded to client options.
 */
export function clientFromEnv(debug = false): CyphraClient {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    throw new Error("Set NEO4J_URI, NEO4J_USER, and NEO4J_PASSWORD in the environment");
  }
  return new CyphraClient({
    uri,
    user,
    password,
    database: process.env.NEO4J_DATABASE,
    debug,
  });
}
