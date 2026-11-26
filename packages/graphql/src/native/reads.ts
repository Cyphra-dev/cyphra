/**
 * Root fields of the native API beyond lists: `aggregate`, `groupBy`, `search` and `findSimilar`
 * (on a model, or over a union's members). Each one is a single client operation; the selection
 * picks what it computes (only the selected aggregates run, `_scores` asks for each index's score).
 *
 * @packageDocumentation
 */

import type { FieldNode, SelectionSetNode } from "graphql";
import type { ResolvedNodeModel } from "@cyphra/schema";
import type { ApiModel } from "./api.js";
import { badInput } from "./errors.js";
import { names, TYPE } from "./schema.js";
import type { Translator } from "./translate.js";

type AnyRecord = Record<string, unknown>;
type Shaped = Record<string | symbol, unknown>;
type Delegate = Record<string, (args: AnyRecord) => Promise<unknown>>;

const AGGREGATES = ["_count", "_sum", "_avg", "_min", "_max"] as const;
type Aggregate = (typeof AGGREGATES)[number];

const AGGREGATE_TYPE: Record<Aggregate, (m: string) => string> = {
  _count: names.countAggregate,
  _sum: names.sumAggregate,
  _avg: names.avgAggregate,
  _min: names.minAggregate,
  _max: names.maxAggregate,
};

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sets(nodes: readonly FieldNode[]): SelectionSetNode[] {
  return nodes.flatMap((n) => (n.selectionSet ? [n.selectionSet] : []));
}

/** Arguments that are set (GraphQL `null` is "not given" for the optional ones). */
function present(args: AnyRecord, keys: readonly string[]): AnyRecord {
  const out: AnyRecord = {};
  for (const k of keys) {
    const v = args[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/**
 * The aggregates selected on one aggregate result (`<Model>Aggregate` or `<Model>Group`): the
 * client's `_count` / `_sum` / … arguments, and how to shape them. Fields a context-only rule
 * denies cannot be aggregated (`FORBIDDEN`).
 */
function aggregateSelection(
  t: Translator,
  model: ResolvedNodeModel,
  fields: Map<string, FieldNode[]>,
): { args: AnyRecord; shape: (row: AnyRecord, out: Shaped) => void } {
  const args: Record<string, AnyRecord> = {};
  const parts: ((row: AnyRecord, out: Shaped) => void)[] = [];
  for (const [key, nodes] of fields) {
    const op = nodes[0]!.name.value as Aggregate;
    if (!(AGGREGATES as readonly string[]).includes(op)) continue;
    const typeName = AGGREGATE_TYPE[op](model.name);
    const sub = t.collect(sets(nodes), typeName);
    const picked: [string, string][] = [];
    const spec = (args[op] ??= {});
    for (const [k, ns] of sub) {
      const field = ns[0]!.name.value;
      if (field === "__typename") continue;
      if (field !== "_all") t.usable(model, field, "aggregated");
      spec[field] = true;
      picked.push([k, field]);
    }
    parts.push((row, out) => {
      const values = (row[op] ?? {}) as AnyRecord;
      const o: Shaped = { [TYPE]: typeName };
      for (const [k, field] of picked) o[k] = values[field] ?? (op === "_count" ? 0 : null);
      out[key] = o;
    });
  }
  return {
    args,
    shape: (row, out) => {
      for (const p of parts) p(row, out);
    },
  };
}

/** `<model>Aggregate`. */
export async function aggregate(
  t: Translator,
  delegate: Delegate,
  model: ResolvedNodeModel,
  args: AnyRecord,
): Promise<unknown> {
  const typeName = names.aggregate(model.name);
  const sel = aggregateSelection(t, model, t.collect(t.rootSelections(), typeName));
  t.checkAliases();
  const row = (await delegate.aggregate!({
    where: t.where(model, args.where),
    orderBy: t.orderBy(model, args.orderBy),
    ...present(args, ["skip", "take"]),
    ...sel.args,
  })) as AnyRecord;
  const out: Shaped = { [TYPE]: typeName };
  sel.shape(row, out);
  return out;
}

/** One element of a groupBy `orderBy`: exactly one key. */
function oneKey(item: unknown, where: string): [string, unknown] {
  const entries = isPlainObject(item)
    ? Object.entries(item).filter(([, v]) => v !== undefined && v !== null)
    : [];
  if (entries.length !== 1) {
    throw badInput(
      `${where}: each element of orderBy takes exactly one key, got ${entries.length === 0 ? "none" : entries.map(([k]) => k).join(", ")}.`,
    );
  }
  return entries[0]!;
}

/** `having` as the client takes it, checking the fields it uses. */
function having(
  api: ApiModel,
  t: Translator,
  model: ResolvedNodeModel,
  h: unknown,
): AnyRecord | undefined {
  if (!isPlainObject(h)) return undefined;
  const out: AnyRecord = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || v === null) continue;
    if (k === "AND" || k === "OR") {
      if (Array.isArray(v)) out[k] = v.map((x) => having(api, t, model, x) ?? {});
      continue;
    }
    if (k === "NOT") {
      out.NOT = having(api, t, model, v) ?? {};
      continue;
    }
    const f = model.fields.find((x) => x.name === k);
    if (!f) throw badInput(`Unknown field "${model.name}.${k}" in having.`);
    t.usable(model, k, "filtered on");
    if (f.kind === "relation") {
      const target = api.node(f.target);
      for (const name of Object.keys(v as AnyRecord)) t.usable(target, name, "filtered on");
    }
    out[k] = Object.fromEntries(
      Object.entries(v as AnyRecord).filter(([, x]) => x !== undefined && x !== null),
    );
  }
  return out;
}

/** A groupBy `orderBy` as the client's, one key per element, checking the fields it sorts on. */
function groupOrderBy(
  api: ApiModel,
  t: Translator,
  model: ResolvedNodeModel,
  list: unknown,
): AnyRecord[] | undefined {
  if (list === undefined || list === null) return undefined;
  return (Array.isArray(list) ? list : [list]).map((item, i) => {
    const [k, v] = oneKey(item, `orderBy[${i}]`);
    if ((AGGREGATES as readonly string[]).includes(k)) {
      const [field, dir] = oneKey(v, `orderBy[${i}].${k}`);
      if (field !== "_all") t.usable(model, field, "sorted on");
      return { [k]: { [field]: dir } };
    }
    t.usable(model, k, "sorted on");
    if (!isPlainObject(v)) return { [k]: v };
    const f = model.fields.find((x) => x.name === k);
    const [field, dir] = oneKey(v, `orderBy[${i}].${k}`);
    if (f?.kind === "relation") t.usable(api.node(f.target), field, "sorted on");
    return { [k]: { [field]: dir } };
  });
}

/** `<model>GroupBy`. */
export async function groupBy(
  api: ApiModel,
  t: Translator,
  delegate: Delegate,
  model: ResolvedNodeModel,
  args: AnyRecord,
): Promise<unknown> {
  const by = (isPlainObject(args.by) ? args.by : {}) as Record<string, string[] | null | undefined>;
  const keys: string[] = [];
  const own = new Set<string>(by.fields ?? []);
  const related = new Map<string, Set<string>>();
  for (const f of own) {
    t.usable(model, f, "used in groupBy");
    keys.push(f);
  }
  for (const r of api.groupRelations(model)) {
    const list = by[r.name];
    if (!list?.length) continue;
    const target = api.node(r.target);
    related.set(r.name, new Set(list));
    for (const f of new Set(list)) {
      t.usable(target, f, "used in groupBy");
      keys.push(`${r.name}.${f}`);
    }
  }
  if (keys.length === 0) {
    throw badInput(`${model.name} groupBy: by lists no field (fields, or a to-one relation's).`);
  }

  const typeName = names.group(model.name);
  const fields = t.collect(t.rootSelections(), typeName);
  const sel = aggregateSelection(t, model, fields);
  const parts: ((row: AnyRecord, out: Shaped) => void)[] = [];
  for (const [key, nodes] of fields) {
    const name = nodes[0]!.name.value;
    if (name === "__typename" || (AGGREGATES as readonly string[]).includes(name)) continue;
    const rel = related.get(name);
    const relation = api.groupRelations(model).find((r) => r.name === name);
    if (relation) {
      const target = api.node(relation.target);
      const keysType = names.groupKeys(target.name);
      const sub = t.collect(sets(nodes), keysType);
      const picked: [string, string][] = [];
      for (const [k, ns] of sub) {
        const f = ns[0]!.name.value;
        if (f === "__typename") continue;
        if (!rel?.has(f)) {
          throw badInput(
            `${typeName}.${name}.${f} is selected, but by.${name} does not list ${f}; only group keys can be selected.`,
          );
        }
        picked.push([k, f]);
      }
      parts.push((row, out) => {
        const values = (row[name] ?? {}) as AnyRecord;
        const o: Shaped = { [TYPE]: keysType };
        for (const [k, f] of picked) o[k] = values[f] ?? null;
        out[key] = o;
      });
      continue;
    }
    if (!own.has(name)) {
      throw badInput(
        `${typeName}.${name} is selected, but by.fields does not list ${name}; only group keys can be selected.`,
      );
    }
    parts.push((row, out) => {
      out[key] = row[name] ?? null;
    });
  }
  t.checkAliases();
  const take = t.take(args.take, `${model.name} groupBy`);
  const rows = (await delegate.groupBy!({
    by: keys,
    where: t.where(model, args.where),
    having: having(api, t, model, args.having),
    orderBy: groupOrderBy(api, t, model, args.orderBy),
    ...present(args, ["skip"]),
    ...(take !== undefined ? { take } : {}),
    ...sel.args,
  })) as AnyRecord[];
  return rows.map((row) => {
    const out: Shaped = { [TYPE]: typeName };
    for (const p of parts) p(row, out);
    sel.shape(row, out);
    return out;
  });
}

/**
 * `<model>Search` / `<model>FindSimilar`, on a model or over a union's members: the hits,
 * shaped by the selection, with `_score` (and, over a union, `_scores`).
 */
export async function scoredSearch(
  t: Translator,
  delegate: Delegate,
  model: ResolvedNodeModel,
  op: "search" | "findSimilar",
  args: AnyRecord,
): Promise<unknown> {
  t.scoring = model.union ? "fused" : "score";
  const where = `${model.name}.${op}`;
  let clientArgs: AnyRecord;
  let rows: number;
  if (op === "search") {
    const take = t.take(args.take, where);
    rows = t.listRows(take);
    clientArgs = {
      ...present(
        args,
        model.union
          ? ["query", "mode", "minScore", "skip", "rrfK"]
          : ["index", "query", "mode", "minScore", "skip"],
      ),
      ...(take !== undefined ? { take } : {}),
    };
    if (model.union && isPlainObject(args.indexes)) {
      clientArgs.indexes = present(args.indexes, Object.keys(args.indexes));
    }
  } else if (model.union) {
    const take = t.take(args.take, where)!;
    rows = take;
    clientArgs = { ...present(args, ["vector", "minScore", "skip", "rrfK"]), take };
    if (isPlainObject(args.fields))
      clientArgs.fields = present(args.fields, Object.keys(args.fields));
  } else {
    const k = t.take(args.k, where)!;
    rows = k;
    clientArgs = { ...present(args, ["field", "vector", "minScore"]), k };
  }
  const w = t.where(model, args.where);
  if (w !== undefined) clientArgs.where = w;
  const tr = t.node(model, t.rootSelections(), undefined, 0, rows);
  t.checkAliases();
  t.checkComplexity(rows, tr.cost);
  if (t.wantScores) clientArgs.scores = true;
  const hits = (await delegate[op]!({ ...clientArgs, select: tr.select })) as AnyRecord[];
  return hits.map((h) => tr.shape(h));
}
