/**
 * Traceability matrix: **neo4j-driver** 5.x capabilities vs how Cyphra exposes them.
 * Upstream source of truth for behaviour and types: the official driver (repo mirror may live under `tmp/neo4j-javascript-driver` for local review only).
 *
 * - **first_class** — Wrapped with Cyphra helpers (`CompiledCypher`, default `database`, hooks).
 * **passthrough** — Use {@link CyphraClient.rawDriver} / {@link CyphraClient.session} (full `SessionConfig`).
 * **not_applicable** — Out of scope for this adapter (e.g. Rx API) or app concern only.
 */
export type Neo4jDriverCoverageSupport = "first_class" | "passthrough" | "not_applicable";

export type Neo4jDriverCoverageRow = {
  readonly id: string;
  readonly driverArea: string;
  readonly neo4jDriverApi: string;
  readonly support: Neo4jDriverCoverageSupport;
  readonly cyphraNotes: string;
};

/** Ordered checklist; keep IDs stable when adding rows. */
export const NEO4J_DRIVER_ADAPTER_COVERAGE: readonly Neo4jDriverCoverageRow[] = [
  {
    id: "auth-basic",
    driverArea: "Auth",
    neo4jDriverApi: "neo4j.auth.basic",
    support: "first_class",
    cyphraNotes: "CyphraNeo4j connect options → neo4j.driver(uri, auth.basic(...))",
  },
  {
    id: "driver-config",
    driverArea: "Driver",
    neo4jDriverApi: "Config (timeouts, logging, …)",
    support: "first_class",
    cyphraNotes: "CyphraNeo4jConnectOptions.driverConfig / CyphraClientLegacyOptions.driverConfig",
  },
  {
    id: "driver-inject",
    driverArea: "Driver",
    neo4jDriverApi: "driver() / Driver.close",
    support: "first_class",
    cyphraNotes:
      "Inject Driver via CyphraNeo4jDriverOptions; dispose() only when adapter owns driver",
  },
  {
    id: "session-default-database",
    driverArea: "Session",
    neo4jDriverApi: "driver.session({ database })",
    support: "first_class",
    cyphraNotes: "Adapter database merged by session(); override via SessionConfig",
  },
  {
    id: "session-access-mode",
    driverArea: "Session",
    neo4jDriverApi: "defaultAccessMode: READ | WRITE",
    support: "first_class",
    cyphraNotes: "sessionRead() / sessionWrite(); or session({ defaultAccessMode })",
  },
  {
    id: "session-bookmarks-impersonation-fetch",
    driverArea: "Session",
    neo4jDriverApi:
      "bookmarks, impersonatedUser, fetchSize, bookmarkManager, notificationFilter, auth",
    support: "passthrough",
    cyphraNotes:
      "Pass via session(override) / withSession(fn, override); full SessionConfig supported",
  },
  {
    id: "session-run-autocommit",
    driverArea: "Session",
    neo4jDriverApi: "session.run(query, params, transactionConfig?)",
    support: "first_class",
    cyphraNotes: "runCompiled / runCypher; optional transactionConfig on auto-commit run",
  },
  {
    id: "session-explain-profile",
    driverArea: "Session",
    neo4jDriverApi: "EXPLAIN / PROFILE (prefix on query text)",
    support: "first_class",
    cyphraNotes: "explainCompiled / profileCompiled",
  },
  {
    id: "session-execute-read-write",
    driverArea: "Session",
    neo4jDriverApi: "executeRead / executeWrite",
    support: "first_class",
    cyphraNotes: "withReadTransaction / withWriteTransaction; optional SessionConfig per call",
  },
  {
    id: "tx-managed-run",
    driverArea: "Transaction",
    neo4jDriverApi: "ManagedTransaction.run",
    support: "first_class",
    cyphraNotes: "runCompiledTx / runCypherTx / queryRecordsTx",
  },
  {
    id: "driver-execute-query",
    driverArea: "Driver",
    neo4jDriverApi: "driver.executeQuery (retriable, EagerResult)",
    support: "first_class",
    cyphraNotes:
      "executeCompiledQuery / queryRecordsExecute; merges default database into QueryConfig",
  },
  {
    id: "driver-verify-serverinfo",
    driverArea: "Driver",
    neo4jDriverApi: "verifyConnectivity / getServerInfo / verifyAuthentication / supports*",
    support: "first_class",
    cyphraNotes: "verifyConnectivity / getServerInfo on CyphraClient (optional database override)",
  },
  {
    id: "types-graph-temporal",
    driverArea: "Values",
    neo4jDriverApi: "Integer, DateTime, Point, Node, Path, …",
    support: "passthrough",
    cyphraNotes:
      "Returned in plain maps via toPlainRecords; use neo4j-driver types / is* guards as needed",
  },
  {
    id: "rx-api",
    driverArea: "Rx",
    neo4jDriverApi: "rxSession, RxResult, …",
    support: "not_applicable",
    cyphraNotes: "Use rawDriver.rxSession if needed; not wrapped by CyphraClient",
  },
];
