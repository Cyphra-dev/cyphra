/**
 * The Change Data Capture reader of the native API's subscriptions: one poller per server
 * (`db.cdc.query` from a cursor), fanning batches of node and relationship changes out to the
 * subscriptions listening. It is the reader of `compat.v7`'s `CDCSubscriptionsEngine` (#76) made
 * independent of a type model: listeners say which labels and relationship types they want, and
 * get the raw changes of each poll (properties as the driver gives them), in commit order.
 *
 * CDC needs Neo4j Enterprise Edition (or Aura) with the database in CDC mode
 * (`ALTER DATABASE neo4j SET OPTION txLogEnrichment 'FULL'`). The reader only polls while at
 * least one subscription is open, and starts from the current change position when the first one
 * opens.
 *
 * @experimental
 * @packageDocumentation
 */

import { GraphQLError } from "graphql";
import neo4j, { type Driver } from "neo4j-driver";
import { cdcUnavailable } from "../v7/subscriptions/engine.js";

type AnyRecord = Record<string, unknown>;

/** One end of a relationship change. */
export type ChangeEndpoint = {
  readonly elementId: string;
  readonly labels: readonly string[];
  /**
   * The node's properties when the batch was read (raw driver values), `undefined` when the node
   * no longer exists.
   */
  readonly properties?: AnyRecord;
};

/** A node created (`c`), updated (`u`) or deleted (`d`). */
export type NodeChange = {
  readonly kind: "node";
  readonly operation: "c" | "u" | "d";
  readonly elementId: string;
  /** Labels after the change (before it, for a delete). */
  readonly labels: readonly string[];
  /** Properties before the change (updates and deletes), raw driver values. */
  readonly before?: AnyRecord;
  /** Properties after the change (creates and updates), raw driver values. */
  readonly after?: AnyRecord;
};

/** A relationship created (`c`), updated (`u`) or deleted (`d`). */
export type RelationshipChange = {
  readonly kind: "relationship";
  readonly operation: "c" | "u" | "d";
  readonly elementId: string;
  readonly type: string;
  readonly start: ChangeEndpoint;
  readonly end: ChangeEndpoint;
  readonly before?: AnyRecord;
  readonly after?: AnyRecord;
};

export type Change = NodeChange | RelationshipChange;

/** What a listener wants: changes of nodes with one of `labels`, of relationships of `types`. */
export type ChangeInterest = {
  readonly labels: readonly string[];
  readonly types: readonly string[];
};

/** Options of {@link CDCReader}. */
export type CDCReaderOptions = {
  /** A `neo4j-driver` driver. */
  readonly driver?: Driver;
  /**
   * Or a Cyphra client: the ORM client (`createClient(…)`, its connection is used) or a
   * `CyphraClient`, on Neo4j.
   */
  readonly client?: object;
  /** Database to read changes from (default database when omitted; with `driver` only). */
  readonly database?: string;
  /** Milliseconds between two polls. Default 1000. */
  readonly pollInterval?: number;
};

type Listener = {
  readonly interest: ChangeInterest;
  readonly onBatch: (changes: readonly Change[]) => void;
  readonly onClose: () => void;
};
type Runner = (cypher: string, params: AnyRecord) => Promise<AnyRecord[]>;

/** GQL statuses of an outdated or invalid change identifier: the cursor is reset (v7). */
const STALE_CURSOR_STATUSES = new Set(["52N27", "52N28", "52N29", "52N30"]);

function isStaleCursor(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === "object" && depth < 10; depth++) {
    const status = (cur as { gqlStatus?: unknown }).gqlStatus;
    if (typeof status === "string" && STALE_CURSOR_STATUSES.has(status)) return true;
    if ((cur as { code?: unknown }).code === "Neo.ClientError.ChangeDataCapture.InvalidIdentifier")
      return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

type TxClient = {
  readonly dialect?: string;
  withReadTransaction<T>(
    fn: (tx: { run(c: string, p: AnyRecord): Promise<{ records: unknown[] }> }) => Promise<T>,
  ): Promise<T>;
};

function runnerOf(opts: CDCReaderOptions): Runner {
  if (opts.client) {
    const orm = (opts.client as { $client?: unknown }).$client;
    const client = (orm ?? opts.client) as Partial<TxClient>;
    if (typeof client.withReadTransaction !== "function") {
      throw new TypeError(
        "native.CDCReader: client must be a Cyphra client (createClient(…) or a CyphraClient).",
      );
    }
    if (client.dialect !== undefined && client.dialect !== "neo4j") {
      throw new TypeError(
        `native.CDCReader: subscriptions use Neo4j Change Data Capture, which dialect "${client.dialect}" does not have.`,
      );
    }
    const c = client as TxClient;
    return (cypher, params) =>
      c.withReadTransaction(async (tx) =>
        (await tx.run(cypher, params)).records.map(
          (r) => (r as { toObject(): AnyRecord }).toObject() as AnyRecord,
        ),
      );
  }
  if (opts.driver) {
    const driver = opts.driver;
    return async (cypher, params) =>
      (
        await driver.executeQuery(cypher, params, {
          database: opts.database,
          routing: neo4j.routing.READ,
        })
      ).records.map((r) => r.toObject() as AnyRecord);
  }
  throw new TypeError(
    "native.CDCReader: pass `driver` (neo4j-driver) or `client` (Cyphra client).",
  );
}

function propertiesOf(state: unknown): AnyRecord | undefined {
  const props = (state as { properties?: unknown } | null | undefined)?.properties;
  return props && typeof props === "object" ? (props as AnyRecord) : undefined;
}

function operationOf(v: unknown): "c" | "u" | "d" | undefined {
  return v === "c" || v === "u" || v === "d" ? v : undefined;
}

/**
 * Reads Neo4j Change Data Capture for the native API's subscriptions: pass it to
 * `native.makeSchema({ subscriptions })`, and `close()` it on shutdown. One reader serves every
 * subscription of a server (and several schemas).
 *
 * @example
 * ```ts
 * const cdc = new native.CDCReader({ client: db, pollInterval: 500 });
 * const schema = native.makeSchema({ client: db, config: api, subscriptions: cdc });
 * // On shutdown: stops polling and ends the open subscriptions.
 * cdc.close();
 * ```
 *
 * @experimental
 */
export class CDCReader {
  private readonly run: Runner;
  private readonly pollInterval: number;
  private readonly listeners = new Set<Listener>();
  private cursor?: string;
  private starting?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private polling = false;
  /** Incremented when polling stops, so an in-flight poll does not resurrect a stale cursor. */
  private generation = 0;
  private closed = false;

  constructor(options: CDCReaderOptions) {
    const pollInterval = options.pollInterval ?? 1000;
    if (!Number.isFinite(pollInterval) || pollInterval <= 0) {
      throw new TypeError("native.CDCReader: pollInterval must be a positive number.");
    }
    this.pollInterval = pollInterval;
    this.run = runnerOf(options);
  }

  /**
   * Starts listening (and polling, for the first listener). Rejects with a clear error when the
   * database does not serve CDC. Returns the function that stops listening.
   */
  async listen(
    interest: ChangeInterest,
    onBatch: (changes: readonly Change[]) => void,
    onClose: () => void,
  ): Promise<() => void> {
    if (this.closed) throw new GraphQLError("The CDC reader is closed.");
    if (this.cursor === undefined) {
      this.starting ??= this.fetchCurrent()
        .then((id) => {
          this.cursor = id;
        })
        .catch((err: unknown) => {
          const e = cdcUnavailable(err);
          throw new GraphQLError(e.message, {
            originalError: e.originalError ?? undefined,
            extensions: { code: "CDC_UNAVAILABLE" },
          });
        })
        .finally(() => {
          this.starting = undefined;
        });
      await this.starting;
    }
    if (this.closed) throw new GraphQLError("The CDC reader is closed.");
    const listener: Listener = { interest, onBatch, onClose };
    this.listeners.add(listener);
    this.schedule();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  /** Stops polling and ends every open subscription. */
  close(): void {
    this.closed = true;
    this.stop();
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const l of listeners) l.onClose();
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
    }, this.pollInterval);
  }

  private async fetchCurrent(): Promise<string> {
    const rows = await this.run("CALL db.cdc.current() YIELD id RETURN id", {});
    const id = rows[0]?.id;
    if (typeof id !== "string") throw new Error("db.cdc.current() returned no id");
    return id;
  }

  /** The selectors of every listener's interest. */
  private selectors(): AnyRecord[] {
    const labels = new Set<string>();
    const types = new Set<string>();
    for (const l of this.listeners) {
      for (const x of l.interest.labels) labels.add(x);
      for (const x of l.interest.types) types.add(x);
    }
    return [
      ...[...labels].sort().map((l) => ({ select: "n", labels: [l] })),
      ...[...types].sort().map((t) => ({ select: "r", type: t })),
    ];
  }

  private async poll(): Promise<void> {
    const generation = this.generation;
    const from = this.cursor;
    if (from === undefined) return;
    const selectors = this.selectors();
    if (selectors.length === 0) return;
    let current: string;
    let rows: AnyRecord[];
    try {
      // The position before reading changes: when there are none, everything up to it was seen.
      current = await this.fetchCurrent();
      rows = await this.run(
        "CALL db.cdc.query($from, $selectors) YIELD id, txId, seq, event " +
          "RETURN id, event ORDER BY txId ASC, seq ASC",
        { from, selectors },
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
    if (rows.length === 0) return;
    const changes = await this.parse(rows);
    if (generation !== this.generation || changes.length === 0) return;
    for (const l of [...this.listeners]) {
      const wanted = changes.filter((c) =>
        c.kind === "node"
          ? c.labels.some((x) => l.interest.labels.includes(x))
          : l.interest.types.includes(c.type),
      );
      if (wanted.length > 0) l.onBatch(wanted);
    }
  }

  private async parse(rows: readonly AnyRecord[]): Promise<Change[]> {
    const out: Change[] = [];
    const endpoints = new Set<string>();
    for (const row of rows) {
      const e = row.event as AnyRecord | undefined;
      const operation = operationOf(e?.operation);
      if (!e || !operation) continue;
      const state = (e.state ?? {}) as { before?: unknown; after?: unknown };
      const before = propertiesOf(state.before);
      const after = propertiesOf(state.after);
      const props = { ...(before ? { before } : {}), ...(after ? { after } : {}) };
      if (e.eventType === "n") {
        out.push({
          kind: "node",
          operation,
          elementId: e.elementId as string,
          labels: (e.labels as string[] | undefined) ?? [],
          ...props,
        });
      } else if (e.eventType === "r") {
        const end = (x: unknown): ChangeEndpoint => {
          const v = (x ?? {}) as AnyRecord;
          endpoints.add(v.elementId as string);
          return {
            elementId: v.elementId as string,
            labels: (v.labels as string[] | undefined) ?? [],
          };
        };
        out.push({
          kind: "relationship",
          operation,
          elementId: e.elementId as string,
          type: e.type as string,
          start: end(e.start),
          end: end(e.end),
          ...props,
        });
      }
    }
    if (endpoints.size === 0) return out;
    // Relationship events name their ends by element id only (keys need constraints): read the
    // ends' current properties once per batch. An end deleted since has none.
    const found = await this.run(
      "MATCH (n) WHERE elementId(n) IN $ids RETURN elementId(n) AS id, properties(n) AS properties",
      { ids: [...endpoints] },
    );
    const byId = new Map(found.map((r) => [r.id as string, r.properties as AnyRecord]));
    const withProps = (x: ChangeEndpoint): ChangeEndpoint => {
      const properties = byId.get(x.elementId);
      return properties ? { ...x, properties } : x;
    };
    return out.map((c) =>
      c.kind === "relationship" ? { ...c, start: withProps(c.start), end: withProps(c.end) } : c,
    );
  }
}
