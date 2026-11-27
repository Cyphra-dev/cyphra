/**
 * Resolvers of the native API's `Subscription` root fields, on the {@link CDCReader}:
 * `<model>Changed` (node created, updated, deleted) and `<model><Relation>Connected` /
 * `…Disconnected` (relationship events). Every batch of changes is re-read for each subscription
 * on the subscriber's client, with the subscription's `where` and the API's rules, and with
 * exactly its selection: an event is delivered only if the subscriber may read the node (both
 * nodes, for a relationship event) now. Rules are evaluated once, with the context the
 * subscription opened with.
 *
 * @experimental
 * @packageDocumentation
 */

import type { GraphQLError, GraphQLFieldResolver, GraphQLResolveInfo } from "graphql";
import { decodeScalar, withReadTransaction } from "@cyphra/runtime";
import type { ResolvedNodeModel, ResolvedRelationField, ResolvedScalarField } from "@cyphra/schema";
import type { ApiModel } from "./api.js";
import type { RequestAuth } from "./auth.js";
import type { Change, CDCReader, ChangeEndpoint, NodeChange, RelationshipChange } from "./cdc.js";
import { subscriptionKey } from "./config.js";
import { badInput, toGraphQLError } from "./errors.js";
import { toGlobalId } from "./relay.js";
import type { Session } from "./resolvers.js";
import { names, TYPE } from "./schema.js";
import { Translator, type Translation } from "./translate.js";

type AnyRecord = Record<string, unknown>;
type Shaped = Record<string | symbol, unknown>;
type Delegate = Record<string, (args: AnyRecord) => Promise<unknown>>;

/** `operation` of a `<Model>Change`. */
export type ChangeOperation = "CREATED" | "UPDATED" | "DELETED";

const OPERATION: Record<NodeChange["operation"], ChangeOperation> = {
  c: "CREATED",
  u: "UPDATED",
  d: "DELETED",
};

/** The subscribe / resolve pair of one `Subscription` root field. */
export type SubscriptionField = {
  readonly subscribe: GraphQLFieldResolver<unknown, unknown>;
  readonly resolve: GraphQLFieldResolver<unknown, unknown>;
};

/** The resolvers of the `Subscription` root fields, for `SchemaBuilder`. */
export type SubscriptionResolvers = {
  changed(model: ResolvedNodeModel): SubscriptionField;
  relation(
    model: ResolvedNodeModel,
    field: ResolvedRelationField,
    op: "connected" | "disconnected",
  ): SubscriptionField;
};

/** An event, or the error that ended processing a batch (raised when it is resolved). */
type Item = Shaped | { readonly [FAILED]: unknown };
const FAILED = Symbol("cyphra.native.subscriptionFailed");

/**
 * A push-based async iterator: items are queued until the client reads them. `open` starts the
 * source (its rejection fails the subscription) and returns the function that stops it.
 */
async function eventStream(
  open: (push: (item: Item) => void, end: () => void) => Promise<() => void>,
): Promise<AsyncIterableIterator<Item>> {
  const queue: Item[] = [];
  const waiting: ((r: IteratorResult<Item>) => void)[] = [];
  let done = false;
  const source: { stop?: () => void } = {};
  const finish = () => {
    if (done) return;
    done = true;
    source.stop?.();
    queue.length = 0;
    for (const w of waiting.splice(0)) w({ value: undefined, done: true });
  };
  const push = (item: Item) => {
    if (done) return;
    const w = waiting.shift();
    if (w) w({ value: item, done: false });
    else queue.push(item);
  };
  source.stop = await open(push, finish);
  if (done) source.stop();
  const it: AsyncIterableIterator<Item> = {
    next: () =>
      queue.length > 0
        ? Promise.resolve({ value: queue.shift()!, done: false })
        : done
          ? Promise.resolve({ value: undefined, done: true })
          : new Promise((resolve) => waiting.push(resolve)),
    return: () => {
      finish();
      return Promise.resolve({ value: undefined, done: true });
    },
    throw: (err?: unknown) => {
      finish();
      return Promise.reject(err);
    },
    [Symbol.asyncIterator]: () => it,
  };
  return it;
}

function delegateOf(client: object, model: ResolvedNodeModel): Delegate {
  const key = model.name.charAt(0).toLowerCase() + model.name.slice(1);
  const d = (client as Record<string, unknown>)[key];
  if (!d) throw new Error(`The client has no ${key} delegate.`);
  return d as Delegate;
}

/** Labels every node of `model` carries. */
function labelsOf(model: ResolvedNodeModel): readonly string[] {
  return model.labels ?? [model.label];
}

function hasLabels(labels: readonly string[], model: ResolvedNodeModel): boolean {
  return labelsOf(model).every((l) => labels.includes(l));
}

/** Whether two raw driver values are equal (integers, temporals and points by value). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => sameValue(x, b[i]))
    );
  }
  if (typeof a === "object" && typeof b === "object") {
    const proto = Object.getPrototypeOf(a) as object | null;
    if (proto !== Object.getPrototypeOf(b)) return false;
    if (proto === Object.prototype) {
      const ka = Object.keys(a);
      const kb = Object.keys(b);
      return (
        ka.length === kb.length &&
        ka.every((k) => sameValue((a as AnyRecord)[k], (b as AnyRecord)[k]))
      );
    }
    return String(a) === String(b);
  }
  return false;
}

/** One subscription of a model: its key, translation, filter, and how to re-read nodes. */
class NodeReader {
  readonly key: ResolvedScalarField;

  constructor(
    private readonly api: ApiModel,
    readonly model: ResolvedNodeModel,
    readonly tr: Translation | undefined,
    readonly where: AnyRecord | undefined,
  ) {
    const name = subscriptionKey(model, (m, f) => api.config.field(m, f))!;
    this.key = model.fields.find((f) => f.name === name) as ResolvedScalarField;
  }

  /** The key of a node from its raw properties (`undefined` without one). */
  keyOf(props: AnyRecord | undefined): unknown {
    const raw = props?.[this.key.name];
    if (raw === undefined || raw === null) return undefined;
    return decodeScalar(this.key, raw);
  }

  /** The `id` of an event: the key, or its global id with relay. */
  idOf(key: unknown): string {
    return this.api.relayKey(this.model) ? toGlobalId(this.model.name, key) : String(key);
  }

  /** The rows of the nodes with these keys the subscriber may read now, by key. */
  async read(db: object, keys: readonly unknown[]): Promise<Map<string, AnyRecord>> {
    const out = new Map<string, AnyRecord>();
    if (keys.length === 0) return out;
    const unique = [...new Map(keys.map((k) => [String(k), k])).values()];
    const byKey = { [this.key.name]: { in: unique } };
    const rows = (await delegateOf(db, this.model).findMany!({
      where: this.where ? { AND: [byKey, this.where] } : byKey,
      select: { ...this.tr?.select, [this.key.name]: true },
    })) as AnyRecord[];
    for (const row of rows) out.set(String(row[this.key.name]), row);
    return out;
  }
}

/** The response keys selected on `typeName`, by field name; a field selected once only for `once`. */
function selected(
  t: Translator,
  typeName: string,
  once: readonly string[],
): { keys: [string, string][]; sets: (field: string) => Parameters<Translator["node"]>[1] } {
  const fields = t.collect(t.rootSelections(), typeName);
  const keys = [...fields].map(([k, nodes]) => [k, nodes[0]!.name.value] as [string, string]);
  for (const name of once) {
    const n = keys.filter(([, f]) => f === name).length;
    if (n > 1)
      throw badInput(`${typeName}.${name} is selected under ${n} aliases; select it once.`);
  }
  return {
    keys,
    sets: (field) =>
      [...fields]
        .filter(([, nodes]) => nodes[0]!.name.value === field)
        .flatMap(([, nodes]) => nodes.flatMap((n) => (n.selectionSet ? [n.selectionSet] : []))),
  };
}

/**
 * The resolvers of the `Subscription` root fields. `reader` is the CDC reader of `makeSchema`;
 * `scopedClient`: the API's client is a function of the context, which may scope what a
 * subscriber reads in ways the API cannot see (deletes are then only delivered for nodes the
 * subscription delivered).
 */
export function subscriptionResolvers(
  api: ApiModel,
  options: {
    session: (ctx: unknown) => Promise<Session>;
    debug: boolean;
    reader: CDCReader;
    scopedClient: boolean;
  },
): SubscriptionResolvers {
  const limits = api.config.limits;
  const resolve: GraphQLFieldResolver<unknown, unknown> = (payload) => {
    if (typeof payload === "object" && payload !== null && FAILED in payload) {
      throw toGraphQLError((payload as { [FAILED]: unknown })[FAILED], options.debug);
    }
    return payload;
  };

  /**
   * Open a stream on the reader: each batch is processed in order (one after the other), and an
   * error while processing one is delivered as the error of an event.
   */
  const open = (
    interest: { labels: readonly string[]; types: readonly string[] },
    process: (changes: readonly Change[], push: (item: Item) => void) => Promise<void>,
  ) =>
    eventStream(async (push, end) => {
      let chain = Promise.resolve();
      return options.reader.listen(
        interest,
        (changes) => {
          chain = chain
            .then(() => process(changes, push))
            .catch((err: unknown) => push({ [FAILED]: err }));
        },
        end,
      );
    });

  const prepare = async (
    ctx: unknown,
    info: GraphQLResolveInfo,
  ): Promise<{ auth: RequestAuth; client: object; t: Translator }> => {
    const { auth, client } = await options.session(ctx);
    return { auth, client, t: new Translator(api, info, limits, auth) };
  };

  return {
    changed: (model) => ({
      resolve,
      subscribe: async (_src, rawArgs, ctx, info) => {
        try {
          const args = rawArgs as AnyRecord;
          const { auth, client, t } = await prepare(ctx, info);
          auth.checkSubscription("changed", [model]);
          const changeType = names.change(model.name);
          const sel = selected(t, changeType, ["node"]);
          const wantsNode = sel.keys.some(([, f]) => f === "node");
          const tr = wantsNode ? t.node(model, sel.sets("node"), undefined, 0, 1) : undefined;
          const where = t.where(model, args.where);
          t.checkAliases();
          if (tr) t.checkComplexity(1, tr.cost);
          const reader = new NodeReader(api, model, tr, where);
          const operations = Array.isArray(args.operations)
            ? new Set(args.operations as ChangeOperation[])
            : undefined;
          // Without a where, a read rule or a scoped client, the subscriber reads every node of
          // the model: the key of a deleted one tells nothing it could not read. Otherwise only
          // nodes this subscription delivered get their DELETED event.
          const everyNode =
            where === undefined && !auth.readRestricted(model) && !options.scopedClient;
          const shown = new Set<string>();
          const changedFields = (c: NodeChange): string[] => {
            if (c.operation !== "u") return [];
            return api
              .scalars(model)
              .filter(
                (f) =>
                  auth.readsFieldEverywhere(model, f.name) &&
                  !sameValue(c.before?.[f.name], c.after?.[f.name]),
              )
              .map((f) => api.outputName(model, f.name));
          };
          return await open({ labels: [model.label], types: [] }, async (changes, push) => {
            const events = changes.filter(
              (c): c is NodeChange =>
                c.kind === "node" &&
                hasLabels(c.labels, model) &&
                (!operations || operations.has(OPERATION[c.operation])),
            );
            if (events.length === 0) return;
            const live = events
              .filter((c) => c.operation !== "d")
              .map((c) => reader.keyOf(c.after))
              .filter((k) => k !== undefined);
            const rows = await reader.read(client, live);
            for (const c of events) {
              const key = reader.keyOf(c.operation === "d" ? c.before : c.after);
              if (key === undefined) continue;
              const k = String(key);
              const row = c.operation === "d" ? undefined : rows.get(k);
              if (c.operation === "d") {
                const known = shown.delete(k);
                if (!known && !everyNode) continue;
              } else if (!row) {
                shown.delete(k);
                continue;
              } else {
                shown.add(k);
              }
              const out: Shaped = { [TYPE]: changeType };
              for (const [rk, f] of sel.keys) {
                if (f === "operation") out[rk] = OPERATION[c.operation];
                else if (f === "id") out[rk] = reader.idOf(key);
                else if (f === "node") out[rk] = row && tr ? tr.shape(row) : null;
                else if (f === "changedFields") out[rk] = changedFields(c);
              }
              push(out);
            }
          });
        } catch (err) {
          throw toGraphQLError(err, options.debug) as GraphQLError;
        }
      },
    }),

    relation: (model, field, op) => ({
      resolve,
      subscribe: async (_src, rawArgs, ctx, info) => {
        try {
          const args = rawArgs as AnyRecord;
          const { auth, client, t } = await prepare(ctx, info);
          const target = api.node(field.target);
          auth.checkSubscription(op, [model, target]);
          if (auth.fieldDenied(model, field.name)) {
            throw auth.fieldForbidden(model, field.name, "subscribed to");
          }
          const eventType = names.relationEvent(model.name, field.name);
          const sel = selected(t, eventType, ["node", "related"]);
          const tr = t.node(model, sel.sets("node"), undefined, 0, 1);
          const trRelated = t.node(target, sel.sets("related"), undefined, 1, 1);
          const nodes = new NodeReader(api, model, tr, t.where(model, args.where));
          const related = new NodeReader(
            api,
            target,
            trRelated,
            t.where(target, args.relatedWhere),
          );
          t.checkAliases();
          t.checkComplexity(2, tr.cost + trRelated.cost);
          const edge = field.edge ? api.edges.get(field.edge) : undefined;
          const operation = op === "connected" ? "c" : "d";
          const ends = (c: RelationshipChange): [ChangeEndpoint, ChangeEndpoint] =>
            field.direction === "OUT" ? [c.start, c.end] : [c.end, c.start];
          return await open({ labels: [], types: [field.relType] }, async (changes, push) => {
            const events = changes
              .filter(
                (c): c is RelationshipChange =>
                  c.kind === "relationship" &&
                  c.type === field.relType &&
                  c.operation === operation,
              )
              .flatMap((c) => {
                const [n, r] = ends(c);
                if (!hasLabels(n.labels, model) || !hasLabels(r.labels, target)) return [];
                // An end deleted since has no properties: its node is gone, nothing to read.
                const nodeKey = nodes.keyOf(n.properties);
                const relatedKey = related.keyOf(r.properties);
                if (nodeKey === undefined || relatedKey === undefined) return [];
                return [{ c, nodeKey, relatedKey }];
              });
            if (events.length === 0) return;
            const [nodeRows, relatedRows] = await withReadTransaction(client, async (tx) => [
              await nodes.read(
                tx,
                events.map((e) => e.nodeKey),
              ),
              await related.read(
                tx,
                events.map((e) => e.relatedKey),
              ),
            ]);
            for (const { c, nodeKey, relatedKey } of events) {
              const row = nodeRows.get(String(nodeKey));
              const relatedRow = relatedRows.get(String(relatedKey));
              if (!row || !relatedRow) continue;
              const out: Shaped = { [TYPE]: eventType };
              for (const [rk, f] of sel.keys) {
                if (f === "id") out[rk] = nodes.idOf(nodeKey);
                else if (f === "relatedId") out[rk] = related.idOf(relatedKey);
                else if (f === "node") out[rk] = tr.shape(row);
                else if (f === "related") out[rk] = trRelated.shape(relatedRow);
                else if (f === "_edge") {
                  const props = c.operation === "d" ? c.before : c.after;
                  out[rk] = edge
                    ? {
                        ...Object.fromEntries(
                          edge.properties.map((p) => [p.name, decodeScalar(p, props?.[p.name])]),
                        ),
                        [TYPE]: edge.name,
                      }
                    : null;
                }
              }
              push(out);
            }
          });
        } catch (err) {
          throw toGraphQLError(err, options.debug) as GraphQLError;
        }
      },
    }),
  };
}
