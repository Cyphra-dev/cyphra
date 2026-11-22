import { CyphraClient, type CyphraDialect } from "@cyphra/runtime";
import { connectionEnv, DEFAULT_FALKORDB_GRAPH, type TestConnection } from "./connection.js";

/** Images {@link startDatabase} runs when no `image` is given (the versions Cyphra's CI uses). */
export const DEFAULT_IMAGES: Readonly<Record<CyphraDialect, string>> = {
  neo4j: "neo4j:5-community",
  memgraph: "memgraph/memgraph:3.14.0",
  falkordb: "falkordb/falkordb:v4.22.3",
};

/** Password of the `neo4j` user in a Neo4j container started without `password`. */
export const DEFAULT_NEO4J_PASSWORD = "cyphra-test-password";

export type StartDatabaseOptions = {
  /** `neo4j` (default), `memgraph` or `falkordb`. */
  dialect?: CyphraDialect;
  /** Docker image (default: {@link DEFAULT_IMAGES} for the dialect). */
  image?: string;
  /** Neo4j only: password of the `neo4j` user (at least 8 characters). */
  password?: string;
  /** Neo4j only: plugins to install (`NEO4J_PLUGINS`), e.g. `["apoc"]`. */
  plugins?: readonly string[];
  /** FalkorDB only: the graph the connection uses (default `cyphra_test`). */
  graph?: string;
  /** Extra environment variables of the container (e.g. Neo4j `NEO4J_server_memory_*`). */
  env?: Readonly<Record<string, string>>;
  /** Container name (default: chosen by Docker). */
  name?: string;
  /**
   * Keep the container running after the tests and reuse it next time (Testcontainers' reuse,
   * which also needs `TESTCONTAINERS_REUSE_ENABLE=true`). `stop()` then leaves it running.
   */
  reuse?: boolean;
  /** How long to wait for the database to accept queries (default 180 s: plugins download first). */
  startupTimeoutMs?: number;
};

/** A database running in a container, ready for queries. */
export type StartedTestDatabase = {
  readonly dialect: CyphraDialect;
  /** Options for `CyphraClient` / a generated `createClient`. */
  readonly connection: TestConnection;
  /** `NEO4J_TEST_URI` & co. for this database (see {@link connectionEnv}). */
  readonly env: Record<string, string>;
  /** Docker container id. */
  readonly containerId: string;
  /** Stop and remove the container (left running when started with `reuse`). */
  stop(): Promise<void>;
};

type Testcontainers = typeof import("testcontainers");

async function loadTestcontainers(): Promise<Testcontainers> {
  try {
    return await import("testcontainers");
  } catch (e) {
    throw new Error(
      "@cyphra/testing: startDatabase() needs the `testcontainers` package. Install it with `npm i -D testcontainers` (Docker must be running), or point the tests at an existing database with NEO4J_TEST_URI / NEO4J_TEST_USER / NEO4J_TEST_PASSWORD.",
      { cause: e },
    );
  }
}

/**
 * Start Neo4j (default), Memgraph or FalkorDB in a Docker container with Testcontainers and wait
 * until it answers queries. Needs Docker and the `testcontainers` package.
 *
 * @example
 * ```ts
 * const database = await startDatabase({ plugins: ["apoc"] });
 * const db = createClient(database.connection);
 * // …
 * await db.$disconnect();
 * await database.stop();
 * ```
 */
export async function startDatabase(
  options: StartDatabaseOptions = {},
): Promise<StartedTestDatabase> {
  const dialect = options.dialect ?? "neo4j";
  const { GenericContainer, Wait } = await loadTestcontainers();
  const timeout = options.startupTimeoutMs ?? 180_000;
  const port = dialect === "falkordb" ? 6379 : 7687;
  let container = new GenericContainer(options.image ?? DEFAULT_IMAGES[dialect])
    .withExposedPorts(port)
    .withStartupTimeout(timeout);
  const env: Record<string, string> = {};
  const password = options.password ?? DEFAULT_NEO4J_PASSWORD;
  if (dialect === "neo4j") {
    env.NEO4J_AUTH = `neo4j/${password}`;
    if (options.plugins?.length) env.NEO4J_PLUGINS = JSON.stringify(options.plugins);
    container = container.withWaitStrategy(Wait.forLogMessage(/Started\./));
  } else if (dialect === "memgraph") {
    container = container.withWaitStrategy(Wait.forListeningPorts());
  } else {
    container = container.withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/));
  }
  container = container.withEnvironment({ ...env, ...options.env });
  if (options.name) container = container.withName(options.name);
  if (options.reuse) container = container.withReuse();

  const started = await container.start();
  const host = started.getHost();
  const mapped = started.getMappedPort(port);
  const connection: TestConnection =
    dialect === "falkordb"
      ? {
          dialect,
          falkordb: {
            url: `redis://${host}:${mapped}`,
            graph: options.graph ?? DEFAULT_FALKORDB_GRAPH,
          },
        }
      : {
          dialect,
          uri: `bolt://${host}:${mapped}`,
          // Memgraph accepts any credentials while authentication is off.
          user: dialect === "neo4j" ? "neo4j" : "memgraph",
          password: dialect === "neo4j" ? password : "memgraph",
        };
  try {
    await waitUntilReady(connection, timeout);
  } catch (e) {
    if (!options.reuse) await started.stop().catch(() => undefined);
    throw e;
  }
  return {
    dialect,
    connection,
    env: connectionEnv(connection),
    containerId: started.getId(),
    async stop() {
      if (!options.reuse) await started.stop();
    },
  };
}

/**
 * Run `RETURN 1` until the database answers (a container's log line or open port can come before
 * the database accepts sessions).
 */
export async function waitUntilReady(
  connection: TestConnection,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let delay = 250; ; delay = Math.min(delay * 2, 2_000)) {
    const client = new CyphraClient(connection);
    try {
      await client.withSession((session) => session.run("RETURN 1 AS ok"));
      return;
    } catch (e) {
      if (Date.now() + delay > deadline) {
        throw new Error(`@cyphra/testing: the database did not become ready in ${timeoutMs} ms`, {
          cause: e,
        });
      }
    } finally {
      await client.close().catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
