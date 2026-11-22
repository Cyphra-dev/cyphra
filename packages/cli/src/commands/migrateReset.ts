import { createInterface } from "node:readline/promises";
import type { CyphraClient } from "@cyphra/runtime";
import {
  CYPHRA_MIGRATION_LABEL,
  dropAllFalkorDBSchema,
  memgraphDropStatement,
  readSchemaObjects,
  runPendingMigrations,
  withMemgraphStorageAccess,
} from "@cyphra/migrator";
import { clientForConfig, falkordbGraphFromEnv, falkordbUrlFromEnv } from "../clientFromEnv.js";
import type { CyphraConfig } from "../config.js";
import { loadMigrationsFromDir } from "../loadMigrations.js";
import { runDbSeed } from "./seed.js";

/** Rows per transaction when deleting nodes (`CALL { … } IN TRANSACTIONS OF n ROWS`). */
export const RESET_BATCH_SIZE = 10_000;

export type UriAssessment = {
  /** `true` when the URI points at a local / development database. */
  readonly local: boolean;
  /** Host name as parsed from the URI (empty when the URI could not be parsed). */
  readonly host: string;
  /** Why the URI is not treated as local (absent when `local`). */
  readonly reason?: string;
};

/**
 * Decide whether a Neo4j URI looks like a local development database (`cyphra migrate reset`
 * refuses anything else without `--force`). Local means all of:
 *
 * - the scheme has no TLS suffix (`+s` / `+ssc`: managed and production servers use TLS);
 * - the host is `localhost` (or `*.localhost`), a loopback address (`127.0.0.0/8`, `::1`),
 *   `0.0.0.0`, `host.docker.internal`, or a single-label name without dots (a Docker / Compose
 *   service or container name such as `neo4j`).
 *
 * Everything else (Aura `*.databases.neo4j.io`, any dotted host name, private or public IPs) and
 * URIs that cannot be parsed are treated as production.
 *
 * @param uri - `NEO4J_URI`.
 */
export function assessUri(uri: string): UriAssessment {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return { local: false, host: "", reason: "the URI could not be parsed" };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (/\+(s|ssc)$/.test(scheme) || scheme === "rediss") {
    return { local: false, host, reason: `it uses an encrypted ${scheme}:// connection` };
  }
  if (host.endsWith(".databases.neo4j.io")) {
    return { local: false, host, reason: "it is a Neo4j Aura host" };
  }
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "host.docker.internal" ||
    /^127(\.\d{1,3}){3}$/.test(host);
  if (loopback) return { local: true, host };
  // A dotless name that is not an IP literal: a container or Compose service name.
  if (host !== "" && !host.includes(".") && !host.includes(":")) return { local: true, host };
  return { local: false, host, reason: `${host || "the host"} is not a local host` };
}

export type ResetOptions = {
  /** Skip the confirmation prompt (production URIs are still refused). */
  readonly yes?: boolean;
  /** Skip the confirmation prompt and the production check. */
  readonly force?: boolean;
  /** Do not run the seed command after reapplying migrations. */
  readonly skipSeed?: boolean;
};

export type ResetDecision =
  | { readonly action: "proceed" }
  | { readonly action: "prompt" }
  | { readonly action: "refuse"; readonly message: string };

/**
 * Whether `cyphra migrate reset` may run, must ask first, or must refuse.
 *
 * @param uri - `NEO4J_URI`.
 * @param opts - `--yes` / `--force`.
 * @param interactive - `true` when stdin and stdout are terminals.
 */
export function decideReset(uri: string, opts: ResetOptions, interactive: boolean): ResetDecision {
  const assessment = assessUri(uri);
  if (opts.force) return { action: "proceed" };
  if (!assessment.local) {
    return {
      action: "refuse",
      message:
        `Refusing to reset ${assessment.host || uri}: it does not look like a local database ` +
        `(${assessment.reason}). Pass --force to reset it anyway.`,
    };
  }
  if (opts.yes) return { action: "proceed" };
  if (!interactive) {
    return {
      action: "refuse",
      message:
        "Refusing to reset without confirmation in a non-interactive shell. Pass --yes (or -y).",
    };
  }
  return { action: "prompt" };
}

/** `true` for `y` / `yes` (any case), the only answers that confirm. */
export function isYes(answer: string): boolean {
  return /^(y|yes)$/i.test(answer.trim());
}

/** Ask a yes/no question on the terminal (default: no). */
export async function confirm(
  question: string,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stdout,
  },
): Promise<boolean> {
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    return isYes(await rl.question(`${question} [y/N] `));
  } finally {
    rl.close();
  }
}

/** Quote a schema object name for `DROP … \`name\``. */
function quoteName(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

export type ResetCounts = {
  readonly constraints: number;
  readonly indexes: number;
  readonly nodes: number;
};

/**
 * Drop every constraint and index (except the built-in LOOKUP token indexes) and delete every node
 * and relationship, in batches. This also removes the `__CyphraMigration` bookkeeping nodes.
 *
 * @param client - Client bound to the database to reset (`NEO4J_DATABASE`).
 */
export async function resetDatabase(client: CyphraClient): Promise<ResetCounts> {
  if (client.dialect === "memgraph") return resetMemgraph(client);
  if (client.dialect === "falkordb") return resetFalkorDB(client);
  return client.withSession(async (session) => {
    // Constraints first: an index that backs a constraint cannot be dropped on its own.
    const constraints = (await session.run("SHOW CONSTRAINTS YIELD name")).records.map(
      (r) => r.get("name") as string,
    );
    for (const name of constraints) {
      await session.run(`DROP CONSTRAINT ${quoteName(name)} IF EXISTS`);
    }
    // Range, text, point, vector and full-text indexes. LOOKUP indexes are kept: Neo4j creates
    // them by default and they speed up label and relationship type scans.
    const indexes = (
      await session.run(
        "SHOW INDEXES YIELD name, type, owningConstraint WHERE type <> 'LOOKUP' AND owningConstraint IS NULL RETURN name",
      )
    ).records.map((r) => r.get("name") as string);
    for (const name of indexes) {
      await session.run(`DROP INDEX ${quoteName(name)} IF EXISTS`);
    }
    // `session.run` is an auto-commit (implicit) transaction, which IN TRANSACTIONS requires.
    const deleted = await session.run(
      `MATCH (n) CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF ${RESET_BATCH_SIZE} ROWS`,
    );
    const nodes = deleted.summary.counters.updates().nodesDeleted;
    return { constraints: constraints.length, indexes: indexes.length, nodes };
  });
}

/**
 * {@link resetDatabase} on Memgraph: its constraints and property indexes have no name, so each
 * one is dropped by its definition (as read by `SHOW … INFO`).
 */
async function resetMemgraph(client: CyphraClient): Promise<ResetCounts> {
  const objects = await readSchemaObjects(client);
  return client.withSession(async (session) => {
    let constraints = 0;
    let indexes = 0;
    for (const o of objects) {
      await withMemgraphStorageAccess(() => session.run(memgraphDropStatement(o)));
      if (o.kind === "constraint") constraints++;
      else indexes++;
    }
    // Cyphra's migration-name constraint (left out of `readSchemaObjects`).
    await withMemgraphStorageAccess(() =>
      session.run(`DROP CONSTRAINT ON (m:${CYPHRA_MIGRATION_LABEL}) ASSERT m.name IS UNIQUE`),
    );
    const [row] = (await session.run("MATCH (n) RETURN count(n) AS c")).records;
    const c = row?.get("c") as { toNumber?: () => number } | number | undefined;
    const nodes = typeof c === "object" && c?.toNumber ? c.toNumber() : Number(c ?? 0);
    // Memgraph cannot DELETE inside CALL { } IN TRANSACTIONS: its batching directive instead.
    await session.run(`USING PERIODIC COMMIT ${RESET_BATCH_SIZE} MATCH (n) DETACH DELETE n`);
    return { constraints, indexes, nodes };
  });
}

/**
 * {@link resetDatabase} on FalkorDB: every constraint and index of the graph is dropped by its
 * definition (constraints first), then every node of the graph is deleted in one statement
 * (FalkorDB has no batched commits). Other graphs of the server are left alone.
 */
async function resetFalkorDB(client: CyphraClient): Promise<ResetCounts> {
  const { constraints, indexes } = await dropAllFalkorDBSchema(client);
  return client.withSession(async (session) => {
    const [row] = (await session.run("MATCH (n) DETACH DELETE n RETURN count(n) AS c")).records;
    const c = row?.get("c") as { toNumber?: () => number } | number | undefined;
    const nodes = typeof c === "object" && c?.toNumber ? c.toNumber() : Number(c ?? 0);
    return { constraints, indexes, nodes };
  });
}

export type ResetDeps = {
  readonly interactive?: boolean;
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly client?: () => CyphraClient;
};

/**
 * `cyphra migrate reset`: after confirmation, empty the database (data, constraints, indexes and
 * migration records), reapply every migration, then run the seed command unless `skipSeed`.
 *
 * @param cwd - Project root.
 * @param config - Loaded config.
 * @param opts - Command flags.
 * @param deps - Overrides for tests (terminal detection, prompt, client).
 * @returns Process exit code.
 */
export async function runMigrateReset(
  cwd: string,
  config: CyphraConfig,
  opts: ResetOptions,
  deps: ResetDeps = {},
): Promise<number> {
  const falkordb = config.dialect === "falkordb";
  const uri = falkordb ? falkordbUrlFromEnv() : process.env.NEO4J_URI;
  if (!uri) throw new Error("Set NEO4J_URI, NEO4J_USERNAME and NEO4J_PASSWORD in the environment");
  const interactive = deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const decision = decideReset(uri, opts, interactive);
  if (decision.action === "refuse") {
    console.error(decision.message);
    return 1;
  }
  const database = falkordb
    ? `graph ${falkordbGraphFromEnv()}`
    : process.env.NEO4J_DATABASE || "the default database";
  const host = assessUri(uri).host || uri;
  if (decision.action === "prompt") {
    const ask = deps.confirm ?? ((q: string) => confirm(q));
    const ok = await ask(
      `Reset ${database} on ${host}? All data, constraints and indexes will be deleted.`,
    );
    if (!ok) {
      console.error("Reset cancelled.");
      return 1;
    }
  }

  // Load migrations before deleting anything, so a broken migration file fails early.
  const loaded = await loadMigrationsFromDir(config.migrations, cwd);
  const client = deps.client ? deps.client() : await clientForConfig(config);
  try {
    const counts = await resetDatabase(client);
    console.log(
      `Reset ${database} on ${host}: deleted ${counts.nodes} node(s), ` +
        `dropped ${counts.constraints} constraint(s) and ${counts.indexes} index(es).`,
    );
    const applied = await runPendingMigrations(client, loaded);
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "No migrations to apply");
  } finally {
    await client.close();
  }

  if (opts.skipSeed) return 0;
  if (!config.seed) {
    console.log('No "seed" in cyphra.json: skipping seed.');
    return 0;
  }
  return runDbSeed(cwd, config);
}
