/**
 * `onDelete` rules (`@relationship(…, onDelete: Cascade | Restrict | SetNull)`) for `delete` and
 * `deleteMany`.
 *
 * A rule sits on a relation field and says what deleting a node of that field's model does to the
 * nodes the field links it to: `Cascade` deletes them too (and applies their own rules), `Restrict`
 * refuses the whole delete while any of them exist (unless the same operation deletes them too),
 * `SetNull` (the default) only removes the edges, which `DETACH DELETE` does anyway.
 *
 * Everything runs in the caller's write transaction:
 * 1. take the write lock of the root nodes;
 * 2. follow `Cascade` fields breadth-first, locking every node reached; a visited set (per model)
 *    stops cycles;
 * 3. check every `Restrict` field of every node to delete, before anything is deleted;
 * 4. `DETACH DELETE` the whole set in one statement.
 *
 * Locking before reading the edges makes concurrent writers wait: an edge created to a locked node
 * (a new child to cascade to, or one that a `Restrict` rule would see) needs that node's lock too,
 * so it either committed before the lock (and is seen) or waits until the delete commits (and
 * fails, its endpoint being gone).
 *
 * @packageDocumentation
 */

import type { ResolvedNodeModel, ResolvedRelationField, SchemaModel } from "@cyphra/schema";
import { QueryContext, q, relationPattern } from "./compile.js";
import { RestrictError } from "./errors.js";
import { integerToNumber } from "./values.js";
import { isInt } from "../cypher-values.js";

type Executor = (
  text: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>[]>;

/** Property set and removed at once to take a write lock on a node (same as the engine's). */
const LOCK_FLAG = "__cyphraLock";

function toCount(v: unknown): number {
  return isInt(v) ? integerToNumber(v) : Number(v ?? 0);
}

const relations = (m: ResolvedNodeModel, rule: "Cascade" | "Restrict") =>
  m.fields.filter((f): f is ResolvedRelationField => f.kind === "relation" && f.onDelete === rule);

const cache = new WeakMap<ResolvedNodeModel, boolean>();

/**
 * Whether deleting nodes of `root` involves any rule: a `Restrict` or `Cascade` field on `root` or
 * on a model a cascade from it reaches. When not, a plain `DETACH DELETE` is the whole delete.
 */
export function hasDeleteRules(schema: SchemaModel, root: ResolvedNodeModel): boolean {
  const known = cache.get(root);
  if (known !== undefined) return known;
  const seen = new Set<string>();
  const stack = [root];
  let found = false;
  while (stack.length && !found) {
    const m = stack.pop()!;
    if (seen.has(m.name)) continue;
    seen.add(m.name);
    // A node reached as an interface is one of its implementations, with their own rules.
    for (const i of m.implementations ?? []) {
      const impl = schema.nodes.find((n) => n.name === i);
      if (impl) stack.push(impl);
    }
    const cascades = relations(m, "Cascade");
    if (cascades.length || relations(m, "Restrict").length) found = true;
    for (const f of cascades) {
      const t = schema.nodes.find((n) => n.name === f.target);
      if (t) stack.push(t);
    }
  }
  cache.set(root, found);
  return found;
}

/**
 * Group nodes of `model` by the model whose rules apply to them: `model` itself, or for an
 * interface the implementation whose label each node carries (the interface when none).
 */
async function concreteModels(
  exec: Executor,
  schema: SchemaModel,
  model: ResolvedNodeModel,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  if (!model.abstract || ids.length === 0)
    return new Map(ids.length ? [[model.name, [...ids]]] : []);
  const impls = (model.implementations ?? []).map((i) => schema.nodes.find((n) => n.name === i)!);
  const ctx = new QueryContext(schema);
  const rows = await exec(
    `MATCH (n) WHERE elementId(n) IN ${ctx.param([...ids])} RETURN elementId(n) AS id, labels(n) AS labels`,
    ctx.params,
  );
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const labels = (r.labels ?? []) as unknown[];
    const name = impls.find((m) => labels.includes(m.label))?.name ?? model.name;
    const list = out.get(name);
    if (list) list.push(r.id as string);
    else out.set(name, [r.id as string]);
  }
  return out;
}

/** Lock the nodes with these element ids; returns the ids still there. */
export async function lockNodes(
  exec: Executor,
  schema: SchemaModel,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const ctx = new QueryContext(schema);
  const flag = `n.${q(LOCK_FLAG)}`;
  const rows = await exec(
    `MATCH (n) WHERE elementId(n) IN ${ctx.param(ids)} SET ${flag} = true REMOVE ${flag} RETURN elementId(n) AS id`,
    ctx.params,
  );
  return rows.map((r) => r.id as string);
}

/**
 * Delete the nodes `rootIds` of model `root` (already locked by the caller, e.g. with
 * {@link lockNodes}) and everything their `Cascade` rules reach, after checking every `Restrict`
 * rule. Returns how many root nodes were deleted.
 *
 * @throws {RestrictError} When a `Restrict` field links a node to delete to nodes that stay.
 */
export async function deleteWithRules(
  exec: Executor,
  schema: SchemaModel,
  root: ResolvedNodeModel,
  rootIds: readonly string[],
): Promise<number> {
  if (rootIds.length === 0) return 0;
  const nodeOf = (name: string) => schema.nodes.find((n) => n.name === name)!;
  // Nodes to delete, by model name (a node is visited once per model it is reached as).
  const doomed = new Map<string, Set<string>>();
  let frontier = new Map<string, string[]>();
  const flag = `b.${q(LOCK_FLAG)}`;
  // Record nodes reached as `name`; a node reached as an interface is recorded as the
  // implementation its labels name, so that its own rules apply.
  const reach = async (name: string, ids: readonly string[]) => {
    for (const [model, group] of await concreteModels(exec, schema, nodeOf(name), ids)) {
      let seen = doomed.get(model);
      if (!seen) doomed.set(model, (seen = new Set()));
      for (const id of group) {
        if (seen.has(id)) continue;
        seen.add(id);
        const list = frontier.get(model);
        if (list) list.push(id);
        else frontier.set(model, [id]);
      }
    }
  };
  await reach(root.name, rootIds);

  while (frontier.size) {
    const current = frontier;
    frontier = new Map();
    for (const [name, ids] of current) {
      for (const f of relations(nodeOf(name), "Cascade")) {
        const ctx = new QueryContext(schema);
        const rows = await exec(
          `MATCH ${relationPattern(ctx, "a", f, "b")} WHERE elementId(a) IN ${ctx.param(ids)} ` +
            `WITH DISTINCT b SET ${flag} = true REMOVE ${flag} RETURN elementId(b) AS id`,
          ctx.params,
        );
        await reach(
          f.target,
          rows.map((r) => r.id as string),
        );
      }
    }
  }

  const all = new Set<string>();
  for (const ids of doomed.values()) for (const id of ids) all.add(id);
  for (const [name, ids] of doomed) {
    if (ids.size === 0) continue;
    for (const f of relations(nodeOf(name), "Restrict")) {
      const ctx = new QueryContext(schema);
      const rows = await exec(
        `MATCH ${relationPattern(ctx, "a", f, "b")} WHERE elementId(a) IN ${ctx.param([...ids])} ` +
          `AND NOT elementId(b) IN ${ctx.param([...all])} RETURN count(DISTINCT b) AS c`,
        ctx.params,
      );
      const count = toCount(rows[0]?.c);
      if (count > 0) throw new RestrictError(name, f.name, f.target, count);
    }
  }

  const ctx = new QueryContext(schema);
  const rootParam = ctx.param([...rootIds]);
  const rows = await exec(
    `MATCH (n) WHERE elementId(n) IN ${ctx.param([...all])} ` +
      `WITH n, elementId(n) IN ${rootParam} AS isRoot DETACH DELETE n ` +
      `RETURN count(CASE WHEN isRoot THEN 1 END) AS c`,
    ctx.params,
  );
  return toCount(rows[0]?.c);
}
