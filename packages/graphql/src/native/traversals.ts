/**
 * Traversal root fields of the native API: `<model>Traverse`, `<model>TraversePaths` and
 * `<model>ShortestPath`, each one client operation (`traverse`, `traverse` with `returnPaths`,
 * `shortestPath`). The engine applies the read rules to every node a path steps through, and the
 * field rules to the nodes of returned paths.
 *
 * @packageDocumentation
 */

import type { FieldNode, SelectionSetNode } from "graphql";
import type { ResolvedNodeModel } from "@cyphra/schema";
import type { ApiModel } from "./api.js";
import { badInput, limitError } from "./errors.js";
import { names, TYPE } from "./schema.js";
import type { Translation, Translator } from "./translate.js";

type AnyRecord = Record<string, unknown>;
type Shaped = Record<string | symbol, unknown>;
type Delegate = Record<string, (args: AnyRecord) => Promise<unknown>>;
type RawPath = {
  nodes?: AnyRecord[];
  edges?: { type: string; direction: string; properties?: AnyRecord }[];
};

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

/** Fail when a hop bound is above `limits.maxTraversalDepth`. */
function checkDepth(api: ApiModel, value: unknown, what: string): void {
  const max = api.config.limits.maxTraversalDepth;
  if (max !== undefined && typeof value === "number" && value > max) {
    throw limitError(
      "maxTraversalDepth",
      `${what} ${value} is above the limit (maxTraversalDepth: ${max}).`,
    );
  }
}

/** The one key under which `name` is selected (several aliases: `BAD_USER_INPUT`). */
function single(fields: Map<string, FieldNode[]>, name: string, typeName: string) {
  const keys = [...fields].filter(([, nodes]) => nodes[0]!.name.value === name);
  if (keys.length > 1) {
    throw badInput(`${typeName}.${name} is selected under ${keys.length} aliases; select it once.`);
  }
  return keys[0];
}

/**
 * How to shape a `<Model>Path`: its `nodes` with `nodes` (a translation of the path nodes'
 * selection), its `edges` with their type, direction and `_edge` (typed by the edge model of the
 * relation of `via` with that type).
 */
function pathShape(
  api: ApiModel,
  t: Translator,
  model: ResolvedNodeModel,
  selections: readonly SelectionSetNode[],
  nodes: (sets: SelectionSetNode[]) => Translation,
): { nodes: Translation; shape: (path: RawPath) => Shaped } {
  const typeName = names.path(model.name);
  const fields = t.collect(selections, typeName);
  const nodesKey = single(fields, "nodes", typeName);
  const tr = nodes(nodesKey ? sets(nodesKey[1]) : []);
  const edgeName = names.pathEdge(model.name);
  const edgeModels = new Map<string, string>();
  for (const r of api.selfRelations(model)) {
    if (r.edge && api.edges.has(r.edge)) edgeModels.set(r.relType, r.edge);
  }
  const edgeParts: ((e: NonNullable<RawPath["edges"]>[number], out: Shaped) => void)[] = [];
  const edgeKeys: string[] = [];
  for (const [key, ns] of fields) {
    if (ns[0]!.name.value !== "edges") continue;
    edgeKeys.push(key);
    for (const [k, es] of t.collect(sets(ns), edgeName)) {
      const f = es[0]!.name.value;
      if (f === "__typename") continue;
      if (f === "_edge") {
        edgeParts.push((e, out) => {
          const edge = edgeModels.get(e.type);
          out[k] = edge ? { ...(e.properties ?? {}), [TYPE]: edge } : null;
        });
      } else edgeParts.push((e, out) => (out[k] = e[f as "type" | "direction"]));
    }
  }
  return {
    nodes: tr,
    shape: (path) => {
      const out: Shaped = { [TYPE]: typeName };
      if (nodesKey) out[nodesKey[0]] = (path.nodes ?? []).map((n) => tr.shape(n));
      for (const k of edgeKeys) {
        out[k] = (path.edges ?? []).map((e) => {
          const o: Shaped = { [TYPE]: edgeName };
          for (const p of edgeParts) p(e, o);
          return o;
        });
      }
      return out;
    },
  };
}

/** `<model>Traverse`, `<model>TraversePaths` and `<model>ShortestPath`. */
export async function traversal(
  api: ApiModel,
  t: Translator,
  delegate: Delegate,
  model: ResolvedNodeModel,
  op: "traverse" | "traversePaths" | "shortestPath",
  args: AnyRecord,
): Promise<unknown> {
  const base: AnyRecord = {
    from: t.where(model, args.from) ?? {},
    via: args.via,
    ...present(args, ["direction"]),
  };
  if (op === "shortestPath") {
    checkDepth(api, args.maxDepth, `${model.name}.shortestPath: maxDepth`);
    const max = typeof args.maxDepth === "number" ? args.maxDepth : 1;
    const path = pathShape(api, t, model, t.rootSelections(), (s) =>
      t.node(model, s, undefined, 0, max + 1),
    );
    t.checkAliases();
    t.checkComplexity(max + 1, (max + 1) * path.nodes.cost);
    const w = t.where(model, args.where);
    const res = (await delegate.shortestPath!({
      ...base,
      to: t.where(model, args.to) ?? {},
      maxDepth: args.maxDepth,
      ...(w !== undefined ? { where: w } : {}),
      select: path.nodes.select,
    })) as RawPath | null;
    return res ? path.shape(res) : null;
  }

  const depth = (args.depth ?? {}) as AnyRecord;
  checkDepth(api, depth.max, `${model.name}.${op}: depth.max`);
  const take = t.take(args.take, `${model.name}.${op}`);
  const rows = t.listRows(take);
  const clientArgs: AnyRecord = {
    ...base,
    depth: present(depth, ["min", "max"]),
    orderBy: t.orderBy(model, args.orderBy),
    ...present(args, ["distinct", "skip"]),
    ...(take !== undefined ? { take } : {}),
  };
  const w = t.where(model, args.where);
  if (w !== undefined) clientArgs.where = w;
  if (op === "traverse") {
    const tr = t.node(model, t.rootSelections(), undefined, 0, rows);
    t.checkAliases();
    t.checkComplexity(rows, tr.cost);
    const found = (await delegate.traverse!({ ...clientArgs, select: tr.select })) as AnyRecord[];
    return found.map((r) => tr.shape(r));
  }

  const typeName = names.traversal(model.name);
  const fields = t.collect(t.rootSelections(), typeName);
  const nodeKey = single(fields, "node", typeName);
  const pathKey = single(fields, "path", typeName);
  const tr = t.node(model, nodeKey ? sets(nodeKey[1]) : [], undefined, 0, rows);
  const path = pathKey
    ? pathShape(api, t, model, sets(pathKey[1]), (s) => {
        // Path nodes come with their scalar fields: nothing else can be selected on them.
        const n = t.node(model, s, undefined, 0, rows);
        const extra = Object.keys(n.select).filter((k) => {
          const f = model.fields.find((x) => x.name === k);
          return f?.kind !== "scalar";
        });
        if (extra.length > 0) {
          throw badInput(
            `${names.path(model.name)}.nodes of ${model.name}.traversePaths carry scalar fields only (${extra.join(", ")} cannot be selected there).`,
          );
        }
        return n;
      })
    : undefined;
  t.checkAliases();
  t.checkComplexity(rows, rows * tr.cost);
  const found = (await delegate.traverse!({
    ...clientArgs,
    returnPaths: true,
    select: tr.select,
  })) as { node: AnyRecord; path: RawPath }[];
  return found.map((r) => {
    const out: Shaped = { [TYPE]: typeName };
    if (nodeKey) out[nodeKey[0]] = tr.shape(r.node);
    if (pathKey && path) out[pathKey[0]] = path.shape(r.path);
    return out;
  });
}
