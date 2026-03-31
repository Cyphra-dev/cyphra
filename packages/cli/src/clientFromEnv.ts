import { CyphraClient, CyphraNeo4j } from "@cyphra/runtime";

/**
 * Build a {@link CyphraClient} from `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, optional `NEO4J_DATABASE`.
 *
 * @param debug - Forwarded to client options.
 */
export function clientFromEnv(debug = false): CyphraClient {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER;
  const password = process.env.NEO4J_PASSWORD;
  const pairs = [
    ["NEO4J_URI", uri],
    ["NEO4J_USER", user],
    ["NEO4J_PASSWORD", password],
  ] as const;
  const missing = pairs.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`Missing Neo4j environment variable(s): ${missing.join(", ")}.`);
  }
  const adapter = new CyphraNeo4j({
    uri: uri!,
    user: user!,
    password: password!,
    database: process.env.NEO4J_DATABASE,
  });
  return new CyphraClient({ adapter, debug });
}
