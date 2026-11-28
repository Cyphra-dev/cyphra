/**
 * The CDC subscriptions engine: reads Neo4j Change Data Capture (`db.cdc.query`) through the
 * shared CDC reader (`native/cdc.ts`, also the native API's) and turns node changes into
 * `create` / `update` / `delete` events for the `Subscription` resolvers, like the
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
import { isDateTime, isInt, type DateTime, type Driver } from "neo4j-driver";
import { CDCReader, cdcUnavailable, type Change } from "../../native/cdc.js";
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

export { cdcUnavailable };

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

function timestampOf(start: unknown): number {
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
 * to create one from `driver` / `client`), and `close()` it on shutdown. It reads changes through
 * the shared CDC reader (the native API's `CDCReader`).
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
  private readonly reader: CDCReader;
  readonly onlyGraphQLEvents: boolean;
  readonly usesClient: boolean;
  private model?: V7Model;
  private labels: string[] = [];
  private closed = false;

  constructor(opts: CDCEngineOptions) {
    const pollTime = opts.pollTime ?? opts.pollInterval ?? 1000;
    if (!Number.isFinite(pollTime) || pollTime <= 0) {
      throw new TypeError("@cyphra/graphql subscriptions: pollTime must be a positive number.");
    }
    this.onlyGraphQLEvents = !!opts.onlyGraphQLEvents;
    const database = opts.queryConfig?.database ?? opts.database;
    const internals = {
      // Only the changes of `@cyphra/graphql`'s statements (their transaction metadata).
      ...(this.onlyGraphQLEvents ? { txMetadata: { app: APP_ID } } : {}),
      plainErrors: true,
    };
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
      this.reader = new CDCReader({ client, pollInterval: pollTime }, internals);
    } else if (opts.driver) {
      this.usesClient = false;
      this.reader = new CDCReader(
        { driver: opts.driver, database, pollInterval: pollTime },
        internals,
      );
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
    try {
      return await this.reader.listen(
        { labels: this.labels, types: [] },
        (changes) => {
          for (const change of changes) {
            const event = this.event(change);
            if (event) listener(event);
          }
        },
        onClose,
      );
    } catch (err) {
      if (this.closed) throw new GraphQLError("The subscriptions engine is closed.");
      throw err;
    }
  }

  /** Stops polling and ends every open subscription. */
  close(): void {
    this.closed = true;
    this.reader.close();
  }

  /** The event of a node change of a `@node` type (relationship changes are not published, v7). */
  private event(change: Change): NodeEvent | undefined {
    if (change.kind !== "node") return undefined;
    const node = this.model?.nodes.find((n) => sameLabels(n.labels, change.labels));
    if (!node) return undefined;
    const before = serializeProperties(change.before);
    const after = serializeProperties(change.after);
    const base = {
      typename: node.name,
      id: change.elementId,
      timestamp: timestampOf(change.txStartTime),
    };
    switch (change.operation) {
      case "c":
        return { ...base, event: "create", properties: { new: after ?? {} } };
      case "u":
        return { ...base, event: "update", properties: { old: before ?? {}, new: after ?? {} } };
      case "d":
        return { ...base, event: "delete", properties: { old: before ?? {} } };
    }
  }
}
