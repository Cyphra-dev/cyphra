import type { CyphraConnectionOptions, CyphraFalkorDBOptions } from "@cyphra/runtime";
import { parseDialect } from "@cyphra/runtime";

/**
 * How to reach a test database: the options a `CyphraClient` (or a generated `createClient`)
 * takes, with the dialect always set.
 */
export type TestConnection =
  | (CyphraConnectionOptions & { dialect: "neo4j" | "memgraph" })
  | (CyphraFalkorDBOptions & { dialect: "falkordb" });

/** Environment variables read by {@link connectionFromEnv} and written by {@link connectionEnv}. */
export const TEST_ENV = {
  uri: "NEO4J_TEST_URI",
  user: "NEO4J_TEST_USER",
  password: "NEO4J_TEST_PASSWORD",
  database: "NEO4J_TEST_DATABASE",
  dialect: "CYPHRA_TEST_DIALECT",
  falkordbUrl: "FALKORDB_TEST_URL",
  falkordbGraph: "FALKORDB_TEST_GRAPH",
} as const;

/** Graph FalkorDB tests use when `FALKORDB_TEST_GRAPH` is not set. */
export const DEFAULT_FALKORDB_GRAPH = "cyphra_test";

type Env = Record<string, string | undefined>;

/**
 * The test database named by the environment, or `undefined` when none is configured:
 *
 * - `CYPHRA_TEST_DIALECT`: `neo4j` (default), `memgraph` or `falkordb`;
 * - Neo4j and Memgraph: `NEO4J_TEST_URI`, `NEO4J_TEST_USER`, `NEO4J_TEST_PASSWORD` (and optionally
 *   `NEO4J_TEST_DATABASE`);
 * - FalkorDB: `FALKORDB_TEST_URL` (`redis://…`) and optionally `FALKORDB_TEST_GRAPH`.
 *
 * @param env - Defaults to `process.env`.
 */
export function connectionFromEnv(env: Env = process.env): TestConnection | undefined {
  const dialect = parseDialect(env[TEST_ENV.dialect] || undefined, TEST_ENV.dialect);
  if (dialect === "falkordb") {
    const url = env[TEST_ENV.falkordbUrl];
    if (!url) return undefined;
    return {
      dialect,
      falkordb: { url, graph: env[TEST_ENV.falkordbGraph] || DEFAULT_FALKORDB_GRAPH },
    };
  }
  const uri = env[TEST_ENV.uri];
  const user = env[TEST_ENV.user];
  const password = env[TEST_ENV.password];
  if (!uri || !user || !password) return undefined;
  const database = env[TEST_ENV.database];
  return { dialect, uri, user, password, ...(database ? { database } : {}) };
}

/** `true` when {@link connectionFromEnv} finds a test database (handy for `describe.skipIf`). */
export function hasTestDatabase(env: Env = process.env): boolean {
  return connectionFromEnv(env) !== undefined;
}

/**
 * The environment variables that describe `connection` (the inverse of
 * {@link connectionFromEnv}): assign them to `process.env` in a global setup so test files, which
 * run in other workers, connect to the same database.
 */
export function connectionEnv(connection: TestConnection): Record<string, string> {
  if (connection.dialect === "falkordb") {
    const { url, host, port, graph } = connection.falkordb;
    return {
      [TEST_ENV.dialect]: "falkordb",
      [TEST_ENV.falkordbUrl]: url ?? `redis://${host ?? "127.0.0.1"}:${port ?? 6379}`,
      [TEST_ENV.falkordbGraph]: graph,
    };
  }
  return {
    [TEST_ENV.dialect]: connection.dialect,
    [TEST_ENV.uri]: connection.uri,
    [TEST_ENV.user]: connection.user,
    [TEST_ENV.password]: connection.password,
    ...(connection.database ? { [TEST_ENV.database]: connection.database } : {}),
  };
}
