/**
 * Resolvers of the native API's root fields: each one translates the field into one client
 * operation (`findMany`, `create`, `updateMany`, …) on the request's client, runs it in one
 * transaction (with `mutationTransaction: "request"`, every mutation root field of the operation
 * in one transaction) and shapes the result. Nested fields do no I/O.
 *
 * @packageDocumentation
 */

import {
  getArgumentValues,
  type GraphQLError,
  type GraphQLFieldResolver,
  type GraphQLObjectType,
  type GraphQLResolveInfo,
} from "graphql";
import { withEngineRules, withReadTransaction } from "@cyphra/runtime";
import type { ResolvedNodeModel } from "@cyphra/schema";
import type { ApiModel } from "./api.js";
import { isWrite, type RootOperation, type WriteOperation } from "./config.js";
import { RequestAuth } from "./auth.js";
import { badInput, toGraphQLError } from "./errors.js";
import { names, TYPE, type RootResolver } from "./schema.js";
import { fromGlobalId, keyValue } from "./relay.js";
import { aggregate, groupBy, scoredSearch } from "./reads.js";
import { Translator } from "./translate.js";
import { WriteArgs } from "./writes.js";

type AnyRecord = Record<string, unknown>;
type Delegate = Record<string, (args: AnyRecord) => Promise<unknown>>;

/** A client (or a function of the request's context returning one). */
export type ClientSource = object | ((context: unknown) => object | Promise<object>);

/** One request: its auth, and its client with the request's rules applied. */
export type Session = {
  readonly auth: RequestAuth;
  /** The client root fields run on (the request's rules applied). */
  readonly client: object;
};

/**
 * The session of each request, one per context object (shared by its root fields): the rules
 * evaluated once against the context, the client of `client` with them applied. Also sets
 * `ctx.cyphra` (when the context is an object without one): that client, with `$unsafe` (the
 * client without the API's rules).
 */
export function sessions(api: ApiModel, source: ClientSource): (ctx: unknown) => Promise<Session> {
  const cache = new WeakMap<object, Promise<Session>>();
  const make = async (ctx: unknown): Promise<Session> => {
    const auth = new RequestAuth(api, ctx);
    const base =
      typeof source === "function"
        ? await (source as (c: unknown) => object | Promise<object>)(ctx)
        : source;
    const client = auth.hasRules ? withEngineRules(base, auth.rules) : base;
    if (typeof ctx === "object" && ctx !== null && !("cyphra" in ctx) && Object.isExtensible(ctx)) {
      // A client of its own (never the shared one), so that `$unsafe` can be set on it. Not set
      // when `client` is not a Cyphra client (a stub): root fields still run on it.
      let scoped: object | undefined;
      try {
        scoped = auth.hasRules ? client : withEngineRules(base, {});
      } catch {
        scoped = undefined;
      }
      if (scoped) {
        Object.defineProperty(scoped, "$unsafe", { value: base });
        (ctx as AnyRecord).cyphra = scoped;
      }
    }
    return { auth, client };
  };
  return (ctx) => {
    if (typeof ctx !== "object" || ctx === null) return make(ctx);
    let s = cache.get(ctx);
    if (!s) {
      s = make(ctx);
      cache.set(ctx, s);
    }
    return s;
  };
}

function delegateKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

function delegateOf(client: object, model: ResolvedNodeModel): Delegate {
  const d = (client as Record<string, unknown>)[delegateKey(model.name)];
  if (!d) throw new Error(`The client has no ${delegateKey(model.name)} delegate.`);
  return d as Delegate;
}

/** A translated write: run it on a client (or a transaction client) to get the field's value. */
type WritePlan = { readonly run: (db: object) => Promise<unknown> };

type Outcome = { readonly ok: true; readonly value: unknown } | { ok: false; error: GraphQLError };

/** The resolvers of the root fields, for {@link SchemaBuilder}. */
export function rootResolvers(
  api: ApiModel,
  options: { session: (ctx: unknown) => Promise<Session>; debug: boolean },
): RootResolver {
  // Mutation root fields by name, for `mutationTransaction: "request"`.
  const writes = new Map<string, { model: ResolvedNodeModel; op: WriteOperation }>();
  for (const [model, ops] of api.config.operations) {
    for (const [op, name] of ops) {
      if (isWrite(op)) writes.set(name, { model: api.node(model), op });
    }
  }
  // One run per execution of a mutation operation (`variableValues` is a new object per
  // execution, also when a server reuses the parsed document).
  const requests = new WeakMap<object, Promise<Map<string, Outcome>>>();

  /** Run every mutation root field of the operation in one write transaction. */
  const runRequest = async (info: GraphQLResolveInfo, ctx: unknown) => {
    const mutationType = info.parentType as GraphQLObjectType;
    const fields = new Translator(api, info, api.config.limits).collect(
      [info.operation.selectionSet],
      mutationType.name,
    );
    const plans: [string, WritePlan, AnyRecord][] = [];
    const outcomes = new Map<string, Outcome>();
    const failAll = (error: GraphQLError) => {
      for (const key of fields.keys()) outcomes.set(key, { ok: false, error });
      return outcomes;
    };
    let session: Session;
    try {
      session = await options.session(ctx);
    } catch (err) {
      return failAll(toGraphQLError(err, options.debug));
    }
    for (const [key, nodes] of fields) {
      const fieldName = nodes[0]!.name.value;
      if (fieldName === "__typename") {
        outcomes.set(key, { ok: true, value: mutationType.name });
        continue;
      }
      const target = writes.get(fieldName);
      const def = mutationType.getFields()[fieldName];
      if (!target || !def) continue;
      let args: AnyRecord = {};
      try {
        args = getArgumentValues(def, nodes[0]!, info.variableValues);
        const fieldInfo: GraphQLResolveInfo = {
          ...info,
          fieldName,
          fieldNodes: nodes,
          returnType: def.type,
          path: { prev: undefined, key, typename: mutationType.name },
        };
        session.auth.checkRoot(target.model, target.op);
        plans.push([
          key,
          planWrite(api, target.model, target.op, args, fieldInfo, session.auth),
          args,
        ]);
      } catch (err) {
        // Nothing runs when one field cannot be translated: they commit together or not at all.
        return failAll(toGraphQLError(err, options.debug, args));
      }
    }
    let failed: GraphQLError | undefined;
    try {
      const client = session.client as {
        $transaction?: (fn: (tx: object) => Promise<unknown>) => Promise<unknown>;
      };
      if (typeof client.$transaction !== "function") {
        throw new Error('mutationTransaction: "request" needs a client with $transaction.');
      }
      await client.$transaction(async (tx) => {
        for (const [key, plan, args] of plans) {
          try {
            outcomes.set(key, { ok: true, value: await plan.run(tx) });
          } catch (err) {
            failed = toGraphQLError(err, options.debug, args);
            throw err;
          }
        }
      });
    } catch (err) {
      // Rolled back: no field's write happened, so every field reports the error.
      return failAll(failed ?? toGraphQLError(err, options.debug));
    }
    return outcomes;
  };

  return (model: ResolvedNodeModel, op: RootOperation): GraphQLFieldResolver<unknown, unknown> =>
    async (_src, rawArgs, ctx, info) => {
      const args = rawArgs as AnyRecord;
      if (isWrite(op) && api.config.mutationTransaction === "request") {
        let run = requests.get(info.variableValues);
        if (!run) {
          run = runRequest(info, ctx);
          requests.set(info.variableValues, run);
        }
        const outcome = (await run).get(String(info.path.key));
        if (!outcome) throw toGraphQLError(new Error("mutation field not run"), options.debug);
        if (!outcome.ok) throw outcome.error;
        return outcome.value;
      }
      try {
        const { auth, client } = await options.session(ctx);
        auth.checkRoot(model, op);
        if (isWrite(op)) {
          const plan = planWrite(api, model, op, args, info, auth);
          return await plan.run(client);
        }
        const t = new Translator(api, info, api.config.limits, auth);
        switch (op) {
          case "count": {
            t.checkAliases();
            return await delegateOf(client, model).count!({ where: t.where(model, args.where) });
          }
          case "findUnique":
          case "findFirst": {
            const tr = t.node(model, t.rootSelections(), undefined, 0, 1);
            t.checkAliases();
            t.checkComplexity(1, tr.cost);
            const clientArgs: AnyRecord =
              op === "findUnique"
                ? { where: t.whereUnique(model, args.where) }
                : {
                    where: t.where(model, args.where),
                    orderBy: t.orderBy(model, args.orderBy),
                    ...(args.skip !== undefined && args.skip !== null ? { skip: args.skip } : {}),
                  };
            const row = (await delegateOf(client, model)[op]!({
              ...clientArgs,
              select: tr.select,
            })) as AnyRecord | null;
            return row ? tr.shape(row) : null;
          }
          case "findMany":
            return await findMany(t, client, model, args);
          case "aggregate":
            return await aggregate(t, delegateOf(client, model), model, args);
          case "groupBy":
            return await groupBy(api, t, delegateOf(client, model), model, args);
          case "search":
          case "findSimilar":
            return await scoredSearch(t, delegateOf(client, model), model, op, args);
        }
      } catch (err) {
        throw toGraphQLError(err, options.debug, isWrite(op) ? args : undefined);
      }
    };
}

/** `node(id)` (Relay): the node a global id names, or `null`. */
export function nodeResolver(
  api: ApiModel,
  options: { session: (ctx: unknown) => Promise<Session>; debug: boolean },
): GraphQLFieldResolver<unknown, unknown> {
  return async (_src, rawArgs, ctx, info) => {
    try {
      const id = (rawArgs as AnyRecord).id as string;
      const decoded = fromGlobalId(id);
      if (!decoded) throw badInput(`node: ${JSON.stringify(id)} is not a global id.`);
      const model = api.nodes.get(decoded.type);
      const keyField = model && !model.abstract ? api.relayKey(model) : undefined;
      // Unknown types, and models whose reads are all off, have no nodes.
      const reads = [...(api.config.operations.get(model?.name ?? "")?.keys() ?? [])].filter(
        (op) => !isWrite(op),
      );
      if (!model || !keyField || reads.length === 0) {
        return null;
      }
      const key = keyValue(keyField, decoded.key);
      if (key === undefined) throw badInput(`node: ${JSON.stringify(id)} is not a global id.`);
      const { auth, client } = await options.session(ctx);
      // A node an anonymous request may not read (or that the rules hide) is not there.
      if (!auth.authenticated && api.config.authenticated(model.name, "findUnique")) return null;
      const t = new Translator(api, info, api.config.limits, auth);
      const tr = t.node(model, t.rootSelections(), undefined, 0, 1);
      t.checkAliases();
      t.checkComplexity(1, tr.cost);
      const row = (await delegateOf(client, model).findUnique!({
        where: { [keyField.name]: key },
        select: tr.select,
      })) as AnyRecord | null;
      return row ? tr.shape(row) : null;
    } catch (err) {
      throw toGraphQLError(err, options.debug);
    }
  };
}

/**
 * Translate a mutation root field (arguments and selection) into one client write, checking
 * limits and inputs before anything runs.
 */
function planWrite(
  api: ApiModel,
  model: ResolvedNodeModel,
  op: WriteOperation,
  args: AnyRecord,
  info: GraphQLResolveInfo,
  auth: RequestAuth,
): WritePlan {
  const t = new Translator(api, info, api.config.limits, auth);
  const w = new WriteArgs(api, t);
  if (op === "createMany" || op === "updateMany" || op === "deleteMany") {
    const batchType = names.batch(model.name);
    const fields = t.collect(t.rootSelections(), batchType);
    const keysOf = (name: string) =>
      [...fields].filter(([, nodes]) => nodes[0]!.name.value === name).map(([k]) => k);
    const nodesKeys = keysOf("nodes");
    if (nodesKeys.length > 1) {
      throw badInput(
        `${batchType}.nodes is selected under ${nodesKeys.length} aliases; select it once.`,
      );
    }
    const nodesKey = nodesKeys[0];
    const countKeys = keysOf("count");
    const data = op === "createMany" ? (Array.isArray(args.data) ? args.data : []) : undefined;
    const tr = nodesKey
      ? t.node(
          model,
          fields.get(nodesKey)!.flatMap((n) => (n.selectionSet ? [n.selectionSet] : [])),
          undefined,
          0,
          1,
        )
      : undefined;
    t.checkAliases();
    if (tr) t.checkComplexity(data?.length ?? 1, (data?.length ?? 1) * tr.cost);
    const clientArgs: AnyRecord =
      op === "createMany"
        ? { data: data!.map((d, i) => w.create(model, d, `data[${i}]`)) }
        : op === "updateMany"
          ? { where: t.where(model, args.where), data: w.update(model, args.data) }
          : { where: t.where(model, args.where) };
    if (tr) clientArgs.select = tr.select;
    return {
      run: async (db) => {
        const res = (await delegateOf(db, model)[op]!(clientArgs)) as {
          count: number;
          nodes?: AnyRecord[];
        };
        const out: Record<string | symbol, unknown> = { [TYPE]: batchType };
        for (const k of countKeys) out[k] = res.count;
        if (nodesKey && tr) out[nodesKey] = (res.nodes ?? []).map((r) => tr.shape(r));
        return out;
      },
    };
  }
  const tr = t.node(model, t.rootSelections(), undefined, 0, 1);
  t.checkAliases();
  t.checkComplexity(1, tr.cost);
  let clientArgs: AnyRecord;
  switch (op) {
    case "create":
      clientArgs = { data: w.create(model, args.data) };
      break;
    case "update":
      clientArgs = { where: t.whereUnique(model, args.where), data: w.update(model, args.data) };
      break;
    case "upsert":
      clientArgs = {
        where: t.whereUnique(model, args.where),
        create: w.create(model, args.create, "create"),
        update: w.update(model, args.update, "update"),
      };
      break;
    case "delete":
      clientArgs = { where: t.whereUnique(model, args.where) };
      break;
  }
  clientArgs.select = tr.select;
  return {
    run: async (db) => {
      // `null`: written, but the read rules hide the node from this request.
      const row = (await delegateOf(db, model)[op]!(clientArgs)) as AnyRecord | null;
      return row ? tr.shape(row) : null;
    },
  };
}

async function findMany(
  t: Translator,
  client: object,
  model: ResolvedNodeModel,
  args: AnyRecord,
): Promise<unknown> {
  const listType = names.list(model.name);
  const fields = t.collect(t.rootSelections(), listType);
  const keysOf = (name: string) =>
    [...fields].filter(([, nodes]) => nodes[0]!.name.value === name).map(([k]) => k);
  const nodesKeys = keysOf("nodes");
  if (nodesKeys.length > 1) {
    throw badInput(
      `${listType}.nodes is selected under ${nodesKeys.length} aliases; select it once.`,
    );
  }
  const nodesKey = nodesKeys[0];
  const pageInfoKeys = keysOf("pageInfo");
  const totalKeys = keysOf("totalCount");

  const where = t.where(model, args.where);
  const after = typeof args.after === "string" ? args.after : undefined;
  const before = typeof args.before === "string" ? args.before : undefined;
  const skip = typeof args.skip === "number" ? args.skip : undefined;
  const take = t.take(args.take, `${model.name} list`);
  const wantRows = nodesKey !== undefined || pageInfoKeys.length > 0;
  const wantPage = pageInfoKeys.length > 0;

  const tr = t.node(
    model,
    nodesKey ? fields.get(nodesKey)!.flatMap((n) => (n.selectionSet ? [n.selectionSet] : [])) : [],
    undefined,
    0,
    t.listRows(take),
  );
  t.checkAliases();
  if (wantRows) t.checkComplexity(t.listRows(take), tr.cost);

  // With pageInfo, one more row tells whether there is a next (or, before a cursor, previous) page.
  const backward = before !== undefined && after === undefined;
  const fetchTake = wantPage && take !== undefined ? take + 1 : take;
  const findArgs: AnyRecord = {
    where,
    orderBy: t.orderBy(model, args.orderBy),
    ...(skip !== undefined ? { skip } : {}),
    ...(fetchTake !== undefined ? { take: fetchTake } : {}),
    ...(after !== undefined || before !== undefined ? { cursor: { after, before } } : {}),
    select: wantPage ? { ...tr.select, $cursor: true } : tr.select,
  };

  const run = async (db: object) => {
    const d = delegateOf(db, model);
    const rows = wantRows ? ((await d.findMany!(findArgs)) as AnyRecord[]) : [];
    const total = totalKeys.length > 0 ? ((await d.count!({ where })) as number) : 0;
    return { rows, total };
  };
  // A page and its totalCount are read in one transaction.
  const { rows, total } =
    wantRows && totalKeys.length > 0 ? await withReadTransaction(client, run) : await run(client);

  const more = take !== undefined && rows.length > take;
  const page = more ? (backward ? rows.slice(rows.length - take) : rows.slice(0, take)) : rows;
  const out: Record<string | symbol, unknown> = { [TYPE]: listType };
  if (nodesKey !== undefined) out[nodesKey] = page.map((r) => tr.shape(r));
  for (const k of pageInfoKeys) {
    out[k] = {
      hasNextPage: backward ? true : more,
      hasPreviousPage: backward ? more : after !== undefined || (skip ?? 0) > 0,
      startCursor: (page[0]?.$cursor as string | undefined) ?? null,
      endCursor: (page[page.length - 1]?.$cursor as string | undefined) ?? null,
    };
  }
  for (const k of totalKeys) out[k] = total;
  return out;
}
