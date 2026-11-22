/**
 * The CDC subscriptions engine: polls Neo4j Change Data Capture (`db.cdc.query`) and turns node
 * changes into `create` / `update` / `delete` events for the `Subscription` resolvers, like the
 * `Neo4jGraphQLSubscriptionsCDCEngine` of `@neo4j/graphql` v7.
 *
 * CDC needs Neo4j Enterprise Edition (or Aura) with the database in CDC mode
 * (`ALTER DATABASE neo4j SET OPTION txLogEnrichment 'FULL'`). The engine only polls while at
 * least one subscription is open, and starts from the current change position when the first one
 * opens.
 *
 * @packageDocumentation
 */

import type { CyphraClient } from "@cyphra/runtime";
import { GraphQLError } from "graphql";
import neo4j, { isDateTime, isInt, type DateTime, type Driver } from "neo4j-driver";
import type { V7Model } from "../model.js";

type AnyRecord = Record<string, unknown>;

/** Transaction metadata `app` of the statements `@cyphra/graphql` runs (`onlyGraphQLEvents`). */
export const APP_ID = "@cyphra/graphql";

/** A node change, as published to the subscription resolvers. */
export type NodeEvent = {
  readonly event: "create" | "update" | "delete";
  /** The `@node` type whose label set equals the node's labels. */
  readonly typename: string;
  /** Neo4j properties (keys are property names) before and after the change. */
  readonly properties: { readonly old?: AnyRecord; readonly new?: AnyRecord };
  /** Element id of the node. */
  readonly id: string;
  /** Start of the transaction, in milliseconds since the epoch. */
  readonly timestamp: number;
};

export type CDCEngineOptions = {
  /** A `neo4j-driver` driver. */
  driver?: Driver;
  /** Or a Cyphra client (dialect `"neo4j"`). */
  client?: CyphraClient;
  /** Database to read changes from (default database when omitted). */
  database?: string;
  /** v7 option: `{ database }` of the polling queries. */
  queryConfig?: { database?: string };
  /** Milliseconds between two polls (v7 name). Default 1000. */
  pollTime?: number;
  /** Same as `pollTime`. */
  pollInterval?: number;
  /**
   * Only publish changes made by `@cyphra/graphql` mutations (transaction metadata `app`), not
   * other writes to the database. Needs `driver` (statements run through a `CyphraClient` carry no
   * metadata).
   */
  onlyGraphQLEvents?: boolean;
};

type Listener = (event: NodeEvent) => void;
type Runner = (cypher: string, params: AnyRecord) => Promise<AnyRecord[]>;

/** GQL statuses of an outdated or invalid change identifier: the cursor is reset (v7). */
const STALE_CURSOR_STATUSES = new Set(["52N27", "52N28", "52N29", "52N30"]);

function hasGqlStatus(err: unknown, statuses: ReadonlySet<string>): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === "object" && depth < 10; depth++) {
    const status = (cur as { gqlStatus?: unknown }).gqlStatus;
    if (typeof status === "string" && statuses.has(status)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

function isStaleCursor(err: unknown): boolean {
  return (
    hasGqlStatus(err, STALE_CURSOR_STATUSES) ||
    (err as { code?: unknown })?.code === "Neo.ClientError.ChangeDataCapture.InvalidIdentifier"
  );
}

/** The error a subscription gets when the database does not serve CDC. */
export function cdcUnavailable(cause: unknown): GraphQLError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new GraphQLError(
    "GraphQL subscriptions need Neo4j Change Data Capture (CDC): Neo4j Enterprise Edition or Aura, " +
      "with the database in CDC mode (ALTER DATABASE <name> SET OPTION txLogEnrichment 'FULL'). " +
      `Neo4j answered: ${detail}`,
    { originalError: cause instanceof Error ? cause : undefined },
  );
}

/** Neo4j integers become numbers (or strings beyond 2^53), like v7 `serializeNeo4jValue`. */
function serializeValue(value: unknown): unknown {
  if (isInt(value)) return value.inSafeRange() ? value.toNumber() : value.toString();
  if (Array.isArray(value)) return value.map(serializeValue);
  return value;
}

function serializeProperties(props: unknown): AnyRecord | undefined {
  if (!props || typeof props !== "object") return undefined;
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, serializeValue(v)]));
}

function timestampOf(metadata: unknown): number {
  const start = (metadata as { txStartTime?: unknown } | undefined)?.txStartTime;
  if (isDateTime(start as object)) return (start as DateTime).toStandardDate().getTime();
  if (typeof start === "string") return Date.parse(start);
  return Date.now();
}

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((l) => set.has(l));
}

/**
 * Change Data Capture subscriptions engine. Pass it as `features.subscriptions` (or pass `true`
 * to create one from `driver` / `client`), and `close()` it on shutdown.
 *
 * @example
 * ```ts
 * const engine = new CDCSubscriptionsEngine({ driver, pollTime: 500 });
 * const schema = compat.v7.makeSchema({ typeDefs, driver, features: { subscriptions: engine } });
 * // …
 * engine.close();
 * ```
 */
export class CDCSubscriptionsEngine {
  private readonly run: Runner;
  private readonly pollTime: number;
  readonly onlyGraphQLEvents: boolean;
  readonly usesClient: boolean;
  private model?: V7Model;
  private labels: string[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly onClose = new Set<() => void>();
  private cursor?: string;
  private starting?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private polling = false;
  /** Incremented when polling stops, so an in-flight poll does not resurrect a stale cursor. */
  private generation = 0;
  private closed = false;

  constructor(opts: CDCEngineOptions) {
    const pollTime = opts.pollTime ?? opts.pollInterval ?? 1000;
    if (!Number.isFinite(pollTime) || pollTime <= 0) {
      throw new TypeError("@cyphra/graphql subscriptions: pollTime must be a positive number.");
    }
    this.pollTime = pollTime;
    this.onlyGraphQLEvents = !!opts.onlyGraphQLEvents;
    const database = opts.queryConfig?.database ?? opts.database;
    if (opts.client) {
      const client = opts.client;
      if (client.dialect !== "neo4j") {
        throw new TypeError(
          `@cyphra/graphql subscriptions use Neo4j Change Data Capture, which dialect "${client.dialect}" does not have.`,
        );
      }
      if (this.onlyGraphQLEvents) {
        throw new TypeError(
          "@cyphra/graphql subscriptions: onlyGraphQLEvents needs `driver` (statements run through a CyphraClient carry no transaction metadata).",
        );
      }
      this.usesClient = true;
      this.run = (cypher, params) =>
        client.withReadTransaction(async (tx) =>
          (await tx.run(cypher, params)).records.map((r) => r.toObject() as AnyRecord),
        );
    } else if (opts.driver) {
      const driver = opts.driver;
      this.usesClient = false;
      this.run = async (cypher, params) =>
        (
          await driver.executeQuery(cypher, params, {
            database,
            routing: neo4j.routing.READ,
          })
        ).records.map((r) => r.toObject() as AnyRecord);
    } else {
      throw new TypeError(
        "@cyphra/graphql subscriptions: pass `driver` (neo4j-driver) or `client` (CyphraClient).",
      );
    }
  }

  /** Called by `makeSchema`: the types events are published for. */
  attach(model: V7Model): void {
    this.model = model;
    this.labels = [...new Set(model.nodes.flatMap((n) => n.labels))];
  }

  /**
   * Starts listening (and polling, for the first listener). Rejects with a clear error when the
   * database does not serve CDC. Returns the function that stops listening.
   */
  async listen(listener: Listener, onClose: () => void): Promise<() => void> {
    if (this.closed) throw new GraphQLError("The subscriptions engine is closed.");
    if (!this.model)
      throw new GraphQLError("The subscriptions engine is not attached to a schema.");
    if (this.cursor === undefined) {
      this.starting ??= this.fetchCurrent()
        .then((id) => {
          this.cursor = id;
        })
        .catch((err: unknown) => {
          throw cdcUnavailable(err);
        })
        .finally(() => {
          this.starting = undefined;
        });
      await this.starting;
    }
    if (this.closed) throw new GraphQLError("The subscriptions engine is closed.");
    this.listeners.add(listener);
    this.onClose.add(onClose);
    this.schedule();
    return () => {
      this.listeners.delete(listener);
      this.onClose.delete(onClose);
      if (this.listeners.size === 0) this.stop();
    };
  }

  /** Stops polling and ends every open subscription. */
  close(): void {
    this.closed = true;
    this.stop();
    const callbacks = [...this.onClose];
    this.listeners.clear();
    this.onClose.clear();
    for (const cb of callbacks) cb();
  }

  private stop(): void {
    this.generation++;
    this.cursor = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.closed || this.timer || this.polling || this.listeners.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.polling = true;
      this.poll()
        .catch((err: unknown) => {
          console.error("[cyphra/graphql] CDC poll failed:", err);
        })
        .finally(() => {
          this.polling = false;
          this.schedule();
        });
    }, this.pollTime);
  }

  private async fetchCurrent(): Promise<string> {
    const rows = await this.run("CALL db.cdc.current() YIELD id RETURN id", {});
    const id = rows[0]?.id;
    if (typeof id !== "string") throw new Error("db.cdc.current() returned no id");
    return id;
  }

  private selectors(): AnyRecord[] {
    const txMetadata = this.onlyGraphQLEvents ? { txMetadata: { app: APP_ID } } : {};
    return this.labels.map((l) => ({ select: "n", labels: [l], ...txMetadata }));
  }

  private async poll(): Promise<void> {
    const generation = this.generation;
    const from = this.cursor;
    if (from === undefined) return;
    let current: string;
    let rows: AnyRecord[];
    try {
      // The position before reading changes: when there are none, everything up to it was seen.
      current = await this.fetchCurrent();
      rows = await this.run(
        "CALL db.cdc.query($from, $selectors) YIELD id, txId, seq, event, metadata " +
          "RETURN id, event, metadata ORDER BY txId ASC, seq ASC",
        { from, selectors: this.selectors() },
      );
    } catch (err) {
      if (isStaleCursor(err)) {
        // Changes between the stale cursor and now are lost (v7 behaviour).
        console.warn("[cyphra/graphql] CDC cursor is no longer valid, restarting from now:", err);
        if (generation === this.generation) this.cursor = await this.fetchCurrent();
        return;
      }
      throw err;
    }
    if (generation !== this.generation) return;
    const last = rows[rows.length - 1];
    this.cursor = last ? (last.id as string) : current;
    for (const row of rows) {
      const event = this.parse(row);
      if (!event) continue;
      for (const listener of [...this.listeners]) listener(event);
    }
  }

  private parse(row: AnyRecord): NodeEvent | undefined {
    const change = row.event as AnyRecord | undefined;
    // Relationship changes are not published (v7 7.x neither).
    if (!change || change.eventType !== "n") return undefined;
    const labels = (change.labels as string[] | undefined) ?? [];
    const node = this.model?.nodes.find((n) => sameLabels(n.labels, labels));
    if (!node) return undefined;
    const state = (change.state ?? {}) as { before?: AnyRecord | null; after?: AnyRecord | null };
    const before = serializeProperties(state.before?.properties);
    const after = serializeProperties(state.after?.properties);
    const base = {
      typename: node.name,
      id: change.elementId as string,
      timestamp: timestampOf(row.metadata),
    };
    switch (change.operation) {
      case "c":
        return { ...base, event: "create", properties: { new: after ?? {} } };
      case "u":
        return { ...base, event: "update", properties: { old: before ?? {}, new: after ?? {} } };
      case "d":
        return { ...base, event: "delete", properties: { old: before ?? {} } };
      default:
        return undefined;
    }
  }
}
