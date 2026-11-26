/**
 * The engine clients `compat.v7` runs translated operations on: an ORM client over the v7
 * {@link EngineSchema}, returning raw driver values (shaped by the v7 decoders, like the compat
 * compiler's results).
 *
 * - With `makeSchema({ client })`: on that client, so its `query` events, spans, missing-index
 *   warnings and hooks cover these statements.
 * - With `makeSchema({ driver })`: on a client over the driver whose transactions carry the same
 *   session options (`database`, the request's `context.sessionConfig`) and metadata (`app`, read
 *   by CDC subscriptions' `onlyGraphQLEvents`) as the compat compiler's.
 *
 * @packageDocumentation
 */

import {
  CyphraClient,
  createOrm,
  withRawValues,
  type ManagedTransaction,
  type SchemaModel,
} from "@cyphra/runtime";
import neo4j, { type Driver, type SessionConfig as DriverSessionConfig } from "neo4j-driver";
import type { ExecutorOptions, SessionConfig } from "../execute.js";
import { APP_ID } from "../subscriptions/engine.js";

/** Transaction metadata of every statement (CDC `onlyGraphQLEvents` selects on `app`). */
const TX_CONFIG = { metadata: { app: APP_ID } };

type SessionOptions = Pick<DriverSessionConfig, "database" | "impersonatedUser" | "auth">;

/**
 * A `CyphraClient` over a driver whose sessions use `options` (the compat executors' session
 * options) and whose transactions carry the compat metadata.
 */
class CompatDriverClient extends CyphraClient {
  constructor(
    driver: Driver,
    private readonly options: SessionOptions,
  ) {
    super({ driver, database: options.database });
  }

  private open(mode: "READ" | "WRITE") {
    return this.rawDriver.session({ ...this.options, defaultAccessMode: neo4j.session[mode] });
  }

  override async withReadTransaction<T>(fn: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    const session = this.open("READ");
    try {
      return await session.executeRead(fn, TX_CONFIG);
    } finally {
      await session.close();
    }
  }

  override async withWriteTransaction<T>(fn: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    const session = this.open("WRITE");
    try {
      return await session.executeWrite(fn, TX_CONFIG);
    } finally {
      await session.close();
    }
  }
}

/** The defined entries of a request's `sessionConfig`. */
function definedEntries(sessionConfig: SessionConfig | undefined): [string, unknown][] {
  return sessionConfig ? Object.entries(sessionConfig).filter(([, v]) => v !== undefined) : [];
}

/** Session options whose clients are kept (others get a client per request). */
const MAX_CACHED = 16;

/** ORM clients per session options, created on first use. */
export class EngineClients {
  private readonly cache = new Map<string, object>();

  constructor(
    private readonly schema: SchemaModel,
    private readonly opts: ExecutorOptions,
  ) {}

  private create(client: CyphraClient): object {
    const orm = createOrm(this.schema, { client });
    if (this.opts.debug && client instanceof CompatDriverClient) {
      // Same log line as the compat executors (parameter keys, never values).
      client.on("query", (e) =>
        console.debug(
          "[cyphra/graphql] cypher:",
          e.text,
          "param keys:",
          Object.keys(e.params ?? {}),
        ),
      );
    }
    return withRawValues(orm);
  }

  /**
   * The client for a request with `sessionConfig`, or `undefined` when the compat compiler must
   * run it: a `CyphraClient` owns its sessions (the compat executors report the error), and an
   * engine client must speak Neo4j's Cypher like the compat compiler.
   */
  for(sessionConfig: SessionConfig | undefined): object | undefined {
    const set = definedEntries(sessionConfig);
    if (this.opts.client) {
      if (set.length) return undefined;
      const dialect = (this.opts.client as { dialect?: string }).dialect ?? "neo4j";
      if (dialect !== "neo4j") return undefined;
      let orm = this.cache.get("");
      if (!orm) {
        orm = this.create(this.opts.client);
        this.cache.set("", orm);
      }
      return orm;
    }
    if (!this.opts.driver) return undefined;
    // Like the compat executors: the request's options spread over the default database.
    const options: SessionOptions = {
      database: this.opts.database,
      ...(Object.fromEntries(set) as SessionOptions),
    };
    // Credentials are per request: never cached.
    if (options.auth !== undefined) {
      return this.create(new CompatDriverClient(this.opts.driver, options));
    }
    const key = JSON.stringify([options.database ?? null, options.impersonatedUser ?? null]);
    let orm = this.cache.get(key);
    if (!orm) {
      orm = this.create(new CompatDriverClient(this.opts.driver, options));
      if (this.cache.size < MAX_CACHED) this.cache.set(key, orm);
    }
    return orm;
  }
}
