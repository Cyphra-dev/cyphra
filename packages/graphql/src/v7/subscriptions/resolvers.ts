/**
 * `Subscription` field resolvers: `subscribe` checks `@authentication` and opens an event stream on
 * the CDC engine, filtered by type, `@subscriptionsAuthorization` and `where`; `resolve` and the
 * event type resolvers shape each event like v7.
 *
 * @packageDocumentation
 */

import {
  GraphQLError,
  isObjectType,
  Kind,
  type FieldNode,
  type GraphQLFieldResolver,
  type GraphQLResolveInfo,
  type GraphQLSchema,
  type SelectionSetNode,
} from "graphql";
import {
  subscriptionEvents,
  SUBSCRIPTION_EVENTS,
  type NodeType,
  type SubscriptionEvent,
  type V7Model,
} from "../model.js";
import { subscriptionNames } from "../naming.js";
import { authContextFor, checkAuthentication, type AuthContext } from "../auth/context.js";
import type { JwtDecoder } from "../auth/jwt.js";
import type { CDCSubscriptionsEngine, NodeEvent } from "./engine.js";
import { authorizedEvent, changed, matchesWhere, payloadOf } from "./filter.js";

type AnyRecord = Record<string, unknown>;

function isRecord(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const KIND: Record<SubscriptionEvent, NodeEvent["event"]> = {
  CREATED: "create",
  UPDATED: "update",
  DELETED: "delete",
};

const EVENT_TYPE: Record<NodeEvent["event"], string> = {
  create: "CREATE",
  update: "UPDATE",
  delete: "DELETE",
};

/** An event as the event types resolve it: payloads keyed by field name. */
type ShapedEvent = {
  event: NodeEvent["event"];
  timestamp: number;
  old?: AnyRecord;
  new?: AnyRecord;
};

/**
 * The authorization context of a subscription: a decoded `context.jwt` (trusted), else the token
 * of `context.connectionParams.token` (what v7 reads, sent by graphql-ws clients when connecting),
 * else `context.token` (e.g. the `Authorization` header of an SSE request).
 */
export async function subscriptionAuthContext(
  contextValue: unknown,
  model: V7Model,
  decoder: JwtDecoder | undefined,
): Promise<AuthContext> {
  const context = isRecord(contextValue) ? contextValue : {};
  const params = isRecord(context.connectionParams) ? context.connectionParams : {};
  const token = typeof params.token === "string" ? params.token : context.token;
  return authContextFor({ ...context, token }, model, decoder);
}

function collectFields(
  selectionSet: SelectionSetNode | undefined,
  info: GraphQLResolveInfo,
  out: FieldNode[] = [],
): FieldNode[] {
  for (const s of selectionSet?.selections ?? []) {
    if (s.kind === Kind.FIELD) out.push(s);
    else if (s.kind === Kind.INLINE_FRAGMENT) collectFields(s.selectionSet, info, out);
    else collectFields(info.fragments[s.name.value]?.selectionSet, info, out);
  }
  return out;
}

/** v7: selecting the payload needs READ `@authentication` on the type and the selected fields. */
function checkSelectionAuthentication(
  model: V7Model,
  node: NodeType,
  event: SubscriptionEvent,
  info: GraphQLResolveInfo,
  auth: AuthContext,
): void {
  const payloadField = subscriptionNames(node.name)[event].payload;
  const eventFields = info.fieldNodes.flatMap((f) => collectFields(f.selectionSet, info));
  for (const f of eventFields) {
    if (f.name.value !== payloadField && f.name.value !== "previousState") continue;
    checkAuthentication(model, auth, node, ["READ"]);
    for (const sub of collectFields(f.selectionSet, info)) {
      if (sub.name.value === "__typename") continue;
      checkAuthentication(model, auth, node, ["READ"], sub.name.value);
    }
  }
}

/** A push-based async iterator: events are queued until the client reads them. */
function eventStream(
  open: (push: (e: ShapedEvent) => void, end: () => void) => Promise<() => void>,
): Promise<AsyncIterableIterator<ShapedEvent>> {
  const queue: ShapedEvent[] = [];
  const waiting: ((r: IteratorResult<ShapedEvent>) => void)[] = [];
  let done = false;
  let unsubscribe: (() => void) | undefined;
  const finish = () => {
    if (done) return;
    done = true;
    unsubscribe?.();
    queue.length = 0;
    for (const w of waiting.splice(0)) w({ value: undefined, done: true });
  };
  const push = (e: ShapedEvent) => {
    if (done) return;
    const w = waiting.shift();
    if (w) w({ value: e, done: false });
    else queue.push(e);
  };
  const iterator: AsyncIterableIterator<ShapedEvent> = {
    next() {
      if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
      if (done) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => waiting.push(resolve));
    },
    return() {
      finish();
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(err?: unknown) {
      finish();
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return open(push, finish).then((stop) => {
    unsubscribe = stop;
    if (done) stop();
    return iterator;
  });
}

function subscribeResolver(
  model: V7Model,
  decoder: JwtDecoder | undefined,
  engine: CDCSubscriptionsEngine | undefined,
  node: NodeType,
  event: SubscriptionEvent,
): GraphQLFieldResolver<unknown, unknown> {
  const kind = KIND[event];
  return async (_source, args, ctx, info) => {
    const auth = await subscriptionAuthContext(ctx, model, decoder);
    checkSelectionAuthentication(model, node, event, info, auth);
    checkAuthentication(model, auth, node, ["SUBSCRIBE"]);
    if (!engine) {
      throw new GraphQLError(
        "Subscriptions are not enabled: pass features.subscriptions to makeSchema (they need Neo4j Change Data Capture).",
      );
    }
    const where = isRecord((args as AnyRecord).where)
      ? ((args as AnyRecord).where as AnyRecord)
      : undefined;
    return eventStream((push, end) =>
      engine.listen((e) => {
        if (e.event !== kind || e.typename !== node.name || !changed(e)) return;
        const old = e.properties.old && payloadOf(node, e.properties.old);
        const now = e.properties.new && payloadOf(node, e.properties.new);
        // Created events are filtered on the new state, updated and deleted ones on the old one.
        const filtered = (kind === "create" ? now : old) ?? {};
        if (!authorizedEvent(node, kind, filtered, auth)) return;
        if (where && !matchesWhere(node, where, filtered)) return;
        push({ event: kind, timestamp: e.timestamp, old, new: now });
      }, end),
    );
  };
}

/** Attaches `subscribe` / `resolve` to the `Subscription` fields and resolvers to event types. */
export function attachSubscriptionResolvers(
  schema: GraphQLSchema,
  model: V7Model,
  decoder: JwtDecoder | undefined,
  engine: CDCSubscriptionsEngine | undefined,
): void {
  const root = schema.getSubscriptionType();
  if (!root) return;
  const fields = root.getFields();
  for (const node of model.nodes) {
    const events = subscriptionEvents(model, node);
    const names = subscriptionNames(node.name);
    const payloadType = schema.getType(names.payload);
    if (isObjectType(payloadType)) {
      for (const f of Object.values(payloadType.getFields())) {
        f.resolve = (source) => (source as AnyRecord)[f.name];
      }
    }
    for (const event of SUBSCRIPTION_EVENTS) {
      if (!events.has(event)) continue;
      const field = fields[names[event].field]!;
      field.subscribe = subscribeResolver(model, decoder, engine, node, event);
      field.resolve = (source) => source;
      const eventType = schema.getType(names[event].type);
      if (!isObjectType(eventType)) continue;
      for (const f of Object.values(eventType.getFields())) {
        const name = f.name;
        f.resolve = (source) => {
          const e = source as ShapedEvent;
          if (name === "event") return EVENT_TYPE[e.event];
          if (name === "timestamp") return e.timestamp;
          if (name === "previousState") return e.old;
          return e.event === "delete" ? e.old : e.new;
        };
      }
    }
  }
}
