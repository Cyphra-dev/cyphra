import { CyphraClient } from "@cyphra/runtime";
import { connectionFromEnv, type TestConnection } from "./connection.js";
import { startDatabase, type StartDatabaseOptions, type StartedTestDatabase } from "./container.js";
import { wipeDatabase, type WipeOptions } from "./isolation.js";
import {
  applySchema,
  dropSchema,
  type ApplySchemaResult,
  type MigrationsInput,
  type SchemaInput,
} from "./schema.js";

export type TestDatabaseOptions<Db> = {
  /** Schema whose constraints and indexes {@link TestDatabase.setup} creates (`cyphra push`). */
  schema?: SchemaInput;
  /** Migrations {@link TestDatabase.setup} runs first (`cyphra migrate deploy`). */
  migrations?: MigrationsInput;
  /**
   * The database to use. Default: the one named by the environment ({@link connectionFromEnv}),
   * else a new container ({@link startDatabase} with `container`).
   */
  connection?: TestConnection;
  /**
   * Options of the container started when no database is configured, or `false` to fail instead
   * of starting one (e.g. in CI, where a service container is expected).
   */
  container?: StartDatabaseOptions | false;
  /**
   * The generated `createClient` (from `cyphra.gen.ts`): {@link TestDatabase.db} is then the typed
   * client, sharing the driver of {@link TestDatabase.client}.
   */
  createClient?: (options: { client: CyphraClient }) => Db;
  /**
   * Before applying the schema, delete every node and drop every constraint and index (default
   * `false`). Only for a database the tests own: it also removes what other suites rely on.
   */
  fresh?: boolean;
  /** What {@link TestDatabase.reset} deletes (default: every node but the migration records). */
  wipe?: WipeOptions;
};

/** A test database: connect and migrate in `setup`, wipe in `reset`, disconnect in `teardown`. */
export type TestDatabase<Db> = {
  /**
   * Connect (starting a container if needed), then apply the migrations and the schema. Call it in
   * `beforeAll` (or a global setup).
   */
  setup(): Promise<ApplySchemaResult>;
  /** Delete the test data ({@link wipeDatabase} with `wipe`). Call it in `beforeEach`. */
  reset(options?: WipeOptions): Promise<void>;
  /** Close the clients and stop the container this database started. Call it in `afterAll`. */
  teardown(): Promise<void>;
  /** The connection (after `setup`). */
  readonly connection: TestConnection;
  /** Low-level client (after `setup`). */
  readonly client: CyphraClient;
  /** The typed client made by `createClient` (after `setup`). */
  readonly db: Db;
  /** The container this database started, if any. */
  readonly container: StartedTestDatabase | undefined;
};

/**
 * Framework-agnostic setup for integration tests: works with any runner that has before / after
 * hooks (Vitest, Jest, `node:test`, Mocha).
 *
 * @example
 * ```ts
 * const testDb = createTestDatabase({
 *   schema: new URL("../schema.cyphra", import.meta.url),
 *   migrations: new URL("../migrations", import.meta.url),
 *   createClient,
 * });
 *
 * beforeAll(() => testDb.setup());
 * beforeEach(() => testDb.reset());
 * afterAll(() => testDb.teardown());
 *
 * it("creates a user", async () => {
 *   await testDb.db.user.create({ data: { email: "ada@example.com" } });
 * });
 * ```
 */
export function createTestDatabase<Db = never>(
  options: TestDatabaseOptions<Db> = {},
): TestDatabase<Db> {
  let connection: TestConnection | undefined;
  let client: CyphraClient | undefined;
  let db: Db | undefined;
  let container: StartedTestDatabase | undefined;
  const ready = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) {
      throw new Error(`@cyphra/testing: ${what} is available after setup() (call it in beforeAll)`);
    }
    return value;
  };

  return {
    async setup() {
      connection = options.connection ?? connectionFromEnv();
      if (!connection) {
        if (options.container === false) {
          throw new Error(
            "@cyphra/testing: no test database configured. Set NEO4J_TEST_URI, NEO4J_TEST_USER and NEO4J_TEST_PASSWORD (or FALKORDB_TEST_URL with CYPHRA_TEST_DIALECT=falkordb).",
          );
        }
        container = await startDatabase(options.container);
        connection = container.connection;
      }
      client = new CyphraClient(connection);
      if (options.createClient) db = options.createClient({ client });
      if (options.fresh) {
        await wipeDatabase(client, { keepMigrations: false });
        await dropSchema(client);
      }
      return applySchema(client, { schema: options.schema, migrations: options.migrations });
    },
    async reset(overrides) {
      await wipeDatabase(ready(client, "client"), { ...options.wipe, ...overrides });
    },
    async teardown() {
      const c = client;
      client = undefined;
      db = undefined;
      try {
        await c?.close();
      } finally {
        const started = container;
        container = undefined;
        await started?.stop();
      }
    },
    get connection() {
      return ready(connection, "connection");
    },
    get client() {
      return ready(client, "client");
    },
    get db() {
      if (!options.createClient) {
        throw new Error("@cyphra/testing: pass createClient to createTestDatabase() to get db");
      }
      return ready(db, "db");
    },
    get container() {
      return container;
    },
  };
}
