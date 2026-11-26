/**
 * Resolvers of the native API's root fields: each one translates the field into one client
 * operation (`findUnique`, `findFirst`, `findMany`, `count`) on the request's client, runs it in
 * one transaction and shapes the result. Nested fields do no I/O.
 *
 * @packageDocumentation
 */

import type { GraphQLFieldResolver } from "graphql";
import { withReadTransaction } from "@cyphra/runtime";
import type { ResolvedNodeModel } from "@cyphra/schema";
import type { ApiModel } from "./api.js";
import type { ReadOperation } from "./config.js";
import { badInput, toGraphQLError } from "./errors.js";
import { names, TYPE, type RootResolver } from "./schema.js";
import { fromGlobalId, keyValue } from "./relay.js";
import { Translator } from "./translate.js";

type AnyRecord = Record<string, unknown>;
type Delegate = Record<string, (args: AnyRecord) => Promise<unknown>>;

/** A client (or a function of the request's context returning one). */
export type ClientSource = object | ((context: unknown) => object | Promise<object>);

function delegateKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

function delegateOf(client: object, model: ResolvedNodeModel): Delegate {
  const d = (client as Record<string, unknown>)[delegateKey(model.name)];
  if (!d) throw new Error(`The client has no ${delegateKey(model.name)} delegate.`);
  return d as Delegate;
}

/** The resolvers of the root fields, for {@link SchemaBuilder}. */
export function rootResolvers(
  api: ApiModel,
  options: { client: ClientSource; debug: boolean },
): RootResolver {
  const clientFor = async (ctx: unknown): Promise<object> =>
    typeof options.client === "function"
      ? await (options.client as (c: unknown) => object | Promise<object>)(ctx)
      : options.client;

  return (model: ResolvedNodeModel, op: ReadOperation): GraphQLFieldResolver<unknown, unknown> =>
    async (_src, rawArgs, ctx, info) => {
      try {
        const args = rawArgs as AnyRecord;
        const t = new Translator(api, info, api.config.limits);
        const client = await clientFor(ctx);
        switch (op) {
          case "count": {
            t.checkAliases();
            return await delegateOf(client, model).count({ where: t.where(model, args.where) });
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
        }
      } catch (err) {
        throw toGraphQLError(err, options.debug);
      }
    };
}

/** `node(id)` (Relay): the node a global id names, or `null`. */
export function nodeResolver(
  api: ApiModel,
  options: { client: ClientSource; debug: boolean },
): GraphQLFieldResolver<unknown, unknown> {
  return async (_src, rawArgs, ctx, info) => {
    try {
      const id = (rawArgs as AnyRecord).id as string;
      const decoded = fromGlobalId(id);
      if (!decoded) throw badInput(`node: ${JSON.stringify(id)} is not a global id.`);
      const model = api.nodes.get(decoded.type);
      const keyField = model && !model.abstract ? api.relayKey(model) : undefined;
      // Unknown types, and models whose reads are all off, have no nodes.
      if (!model || !keyField || (api.config.operations.get(model.name)?.size ?? 0) === 0) {
        return null;
      }
      const key = keyValue(keyField, decoded.key);
      if (key === undefined) throw badInput(`node: ${JSON.stringify(id)} is not a global id.`);
      const t = new Translator(api, info, api.config.limits);
      const tr = t.node(model, t.rootSelections(), undefined, 0, 1);
      t.checkAliases();
      t.checkComplexity(1, tr.cost);
      const client =
        typeof options.client === "function"
          ? await (options.client as (c: unknown) => object | Promise<object>)(ctx)
          : options.client;
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
