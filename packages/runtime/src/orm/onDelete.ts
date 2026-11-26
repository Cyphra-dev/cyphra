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
 * 2. follow `Cascade` fields breadth-first, locking every node reached before reading its edges;
 * 3. check every `Restrict` field of every node to delete, before anything is deleted;
 * 4. `DETACH DELETE` the whole set, only when no `Restrict` rule is broken.
 *
 * When the models the cascades reach form a tree without cycles or interfaces (the common case),
 * all of it is one statement ({@link compileRulesDelete}): each level is a subquery over the
 * nodes locked by the level before. Otherwise (a model cascading to itself, a cascade through an
 * interface) the levels run one statement each, with a visited set (per model) to stop cycles,
 * and the checks and the delete share the last statement ({@link deleteWithRules}).
 *
 * Locking before reading the edges makes concurrent writers wait: an edge created to a locked node
 * (a new child to cascade to, or one that a `Restrict` rule would see) needs that node's lock too,
 * so it either committed before the lock (and is seen) or waits until the delete commits (and
 * fails, its endpoint being gone).
 *
 * @packageDocumentation
 */

import type { ResolvedNodeModel, ResolvedRelationField, SchemaModel } from "@cyphra/schema";
import { QueryContext, q, relationMatch } from "./compile.js";
import { RestrictError } from "./errors.js";
import { integerToNumber } from "./values.js";
import { isInt } from "../cypher-values.js";

type Executor = (
  text: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>[]>;

/** Property set and removed at once to take a write lock on a node (same as the engine's). */
export const LOCK_FLAG = "__cyphraLock";

/**
 * Lock the node bound to `v` (one statement clause), then match it again: a node another
 * transaction deleted while this one waited for the lock is dropped (the variable still holds it,
 * with no properties), so what follows only sees nodes that still exist.
 */
export function lockAndRematch(ctx: QueryContext, v: string): string {
  const y = ctx.variable("y");
  return (
    `SET ${v}.${q(LOCK_FLAG)} = true REMOVE ${v}.${q(LOCK_FLAG)} ` +
    `WITH ${v} AS ${y} MATCH (${v}) WHERE elementId(${v}) = elementId(${y}) WITH ${v}`
  );
}

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

// ---------------------------------------------------------------------------
// One statement: acyclic cascades without interfaces
// ---------------------------------------------------------------------------

/** A model the cascades reach, through the cascade field `via` of its parent. */
type CascadeNode = {
  readonly model: ResolvedNodeModel;
  readonly parent?: number;
  readonly via?: ResolvedRelationField;
};

/** Largest cascade tree compiled to one statement (each node is one subquery). */
const MAX_TREE = 24;

const treeCache = new WeakMap<ResolvedNodeModel, readonly CascadeNode[] | null>();

/**
 * The models the cascades of `root` reach, unfolded into a tree (breadth-first, a model reached by
 * two paths appears twice), or `null` when a cascade path comes back to a model already on it, a
 * model on the way is an interface (its nodes follow the rules of the implementation they are) or
 * the tree is too large.
 */
function cascadeTree(schema: SchemaModel, root: ResolvedNodeModel): readonly CascadeNode[] | null {
  if (treeCache.has(root)) return treeCache.get(root)!;
  const nodeOf = (name: string) => schema.nodes.find((n) => n.name === name);
  const tree: CascadeNode[] = [{ model: root }];
  const paths: string[][] = [[root.name]];
  let ok = !root.abstract;
  for (let i = 0; ok && i < tree.length; i++) {
    for (const f of relations(tree[i]!.model, "Cascade")) {
      const target = nodeOf(f.target);
      const path = paths[i]!;
      if (!target || target.abstract || path.includes(target.name) || tree.length >= MAX_TREE) {
        ok = false;
        break;
      }
      tree.push({ model: target, parent: i, via: f });
      paths.push([...path, target.name]);
    }
  }
  const result = ok ? tree : null;
  treeCache.set(root, result);
  return result;
}

/** A `Restrict` rule checked by a compiled delete: its count is returned as `column`. */
export type RestrictCheck = {
  readonly model: string;
  readonly field: ResolvedRelationField;
  readonly column: string;
};

/** A compiled single-statement delete (see {@link compileRulesDelete}). */
export type CompiledRulesDelete = {
  readonly text: string;
  readonly restricts: readonly RestrictCheck[];
};

/**
 * Compile the whole delete into one statement, or `null` when the cascades of `root` are not a
 * tree (see {@link cascadeTree}). `match` binds the roots to `n` (one row each); with `one`, the
 * first of them is deleted and `projection` (an expression on `n`, read after every lock) is
 * returned as `row`; without, `row` is the list of the projections of every root. Returns the number of roots deleted as `c` (`0` when a `Restrict` count,
 * returned too, is not zero: then nothing is deleted).
 *
 * ```cypher
 * MATCH (n:`User`) WHERE … WITH n LIMIT 1 SET n.lock = true REMOVE n.lock
 * WITH n AS y MATCH (n) WHERE elementId(n) = elementId(y) WITH n WITH n, [n] AS l0
 * CALL { WITH l0 UNWIND l0 AS a MATCH (a)-[:`AUTHORED`]->(b:`Post`) WITH DISTINCT b
 *        SET b.lock = true REMOVE b.lock RETURN collect(b) AS l1 }
 * …
 * WITH …, l0 + l1 + … AS all
 * CALL { WITH all, l1 UNWIND l1 AS a MATCH (a)<-[:`FOR`]-(b:`Invoice`) WHERE NOT b IN all
 *        RETURN count(DISTINCT b) AS r0 }
 * WITH all, l0, r0, <projection> AS row
 * CALL { WITH all, r0 WITH all WHERE r0 = 0 UNWIND all AS d WITH DISTINCT d
 *        MATCH (x) WHERE elementId(x) = elementId(d) DETACH DELETE x RETURN count(*) AS deleted }
 * RETURN CASE WHEN r0 = 0 THEN size(l0) ELSE 0 END AS c, r0, row
 * ```
 */
export function compileRulesDelete(
  ctx: QueryContext,
  root: ResolvedNodeModel,
  match: string,
  one: boolean,
  projection?: string,
  /**
   * The variable `match` binds to the root nodes (default `n`, which `projection` reads), and the
   * name of the count column (default `c`): a nested delete, run as a subquery, names both.
   */
  names: { readonly alias?: string; readonly count?: string } = {},
): CompiledRulesDelete | null {
  const tree = cascadeTree(ctx.schema, root);
  if (!tree) return null;
  const n = names.alias ?? "n";
  const flag = (v: string) => `SET ${v}.${q(LOCK_FLAG)} = true REMOVE ${v}.${q(LOCK_FLAG)}`;
  const lists = tree.map(() => ctx.variable("l"));
  const scope = one ? [n, lists[0]!] : [lists[0]!];
  let text = `${match}${one ? ` WITH ${n} LIMIT 1` : ""} ${lockAndRematch(ctx, n)} `;
  text += one ? `WITH ${n}, [${n}] AS ${lists[0]}` : `WITH collect(${n}) AS ${lists[0]}`;
  for (let i = 1; i < tree.length; i++) {
    const { parent, via } = tree[i]!;
    const [a, b] = [ctx.variable("a"), ctx.variable("b")];
    const from = lists[parent!]!;
    text +=
      ` WITH ${scope.join(", ")} CALL { WITH ${from} UNWIND ${from} AS ${a}` +
      ` MATCH ${relationMatch(ctx, a, via!, b)} WITH DISTINCT ${b} ${flag(b)}` +
      ` RETURN collect(${b}) AS ${lists[i]} }`;
    scope.push(lists[i]!);
  }
  const all = ctx.variable("all");
  text += ` WITH ${scope.join(", ")}, ${lists.join(" + ")} AS ${all}`;
  scope.push(all);

  // Restrict rules of each model, over every node of that model the delete reaches.
  const restricts: RestrictCheck[] = [];
  const byModel = new Map<string, string[]>();
  tree.forEach((t, i) => {
    const l = byModel.get(t.model.name);
    if (l) l.push(lists[i]!);
    else byModel.set(t.model.name, [lists[i]!]);
  });
  for (const [name, ls] of byModel) {
    const model = tree.find((t) => t.model.name === name)!.model;
    for (const f of relations(model, "Restrict")) {
      const [a, b, column] = [ctx.variable("a"), ctx.variable("b"), ctx.variable("rc")];
      text +=
        ` WITH ${scope.join(", ")} CALL { WITH ${[all, ...new Set(ls)].join(", ")}` +
        ` UNWIND ${ls.join(" + ")} AS ${a} MATCH ${relationMatch(ctx, a, f, b, "", `NOT ${b} IN ${all}`)}` +
        ` RETURN count(DISTINCT ${b}) AS ${column} }`;
      scope.push(column);
      restricts.push({ model: name, field: f, column });
    }
  }
  const counts = restricts.map((r) => r.column);
  const ok = counts.length ? counts.map((c) => `${c} = 0`).join(" AND ") : null;
  // Matched again: a node deleted by another transaction before it was locked is skipped.
  const [d, x, deleted] = [ctx.variable("d"), ctx.variable("x"), ctx.variable("deleted")];
  text += ` WITH ${[all, lists[0]!, ...counts].join(", ")}${projection && one ? `, ${projection} AS row` : ""}`;
  // Many roots: `row` is the list of their projections (empty when nothing matched).
  if (projection && !one) {
    text += ` CALL { WITH ${lists[0]} UNWIND ${lists[0]} AS n RETURN collect(${projection}) AS row }`;
  }
  text +=
    ` CALL { WITH ${[all, ...counts].join(", ")}${ok ? ` WITH ${all} WHERE ${ok}` : ""}` +
    ` UNWIND ${all} AS ${d} WITH DISTINCT ${d} MATCH (${x}) WHERE elementId(${x}) = elementId(${d})` +
    ` DETACH DELETE ${x} RETURN count(*) AS ${deleted} }`;
  const c = ok ? `CASE WHEN ${ok} THEN size(${lists[0]}) ELSE 0 END` : `size(${lists[0]})`;
  text += ` RETURN ${[`${c} AS ${names.count ?? "c"}`, ...counts, ...(projection ? ["row"] : [])].join(", ")}`;
  return { text, restricts };
}

/** Throw the {@link RestrictError} of the first broken `Restrict` count of a compiled delete. */
export function throwRestrict(restricts: readonly RestrictCheck[], row: Record<string, unknown>) {
  for (const r of restricts) {
    const count = toCount(row[r.column]);
    if (count > 0) throw new RestrictError(r.model, r.field.name, r.field.target, count);
  }
}

// ---------------------------------------------------------------------------
// Level by level: cycles and interfaces
// ---------------------------------------------------------------------------

/** A node to delete: its element id and labels (which pick the rules of an interface's node). */
export type LockedNode = { readonly id: string; readonly labels: readonly unknown[] };

/**
 * The model whose rules apply to a node reached as `model`: `model` itself, or for an interface
 * the implementation whose label the node carries (the interface when none).
 */
function concreteModel(
  schema: SchemaModel,
  model: ResolvedNodeModel,
  labels: readonly unknown[],
): string {
  if (!model.abstract) return model.name;
  for (const name of model.implementations ?? []) {
    const impl = schema.nodes.find((n) => n.name === name);
    if (impl && labels.includes(impl.label)) return impl.name;
  }
  return model.name;
}

/**
 * Delete the nodes `roots` of model `root` (already locked by the caller) and everything their
 * `Cascade` rules reach, after checking every `Restrict` rule: one statement per cascade level
 * (locking the level's nodes and returning their labels), then one that checks the rules and
 * deletes. Returns how many root nodes were deleted.
 *
 * @throws {RestrictError} When a `Restrict` field links a node to delete to nodes that stay.
 */
export async function deleteWithRules(
  exec: Executor,
  schema: SchemaModel,
  root: ResolvedNodeModel,
  roots: readonly LockedNode[],
): Promise<number> {
  if (roots.length === 0) return 0;
  const nodeOf = (name: string) => schema.nodes.find((n) => n.name === name)!;
  // Nodes to delete, by model name (a node is visited once per model it is reached as).
  const doomed = new Map<string, Set<string>>();
  let frontier = new Map<string, string[]>();
  // Record nodes reached as `name`; a node reached as an interface is recorded as the
  // implementation its labels name, so that its own rules apply.
  const reach = (name: string, nodes: readonly LockedNode[]) => {
    for (const { id, labels } of nodes) {
      const model = concreteModel(schema, nodeOf(name), labels);
      let seen = doomed.get(model);
      if (!seen) doomed.set(model, (seen = new Set()));
      if (seen.has(id)) continue;
      seen.add(id);
      const list = frontier.get(model);
      if (list) list.push(id);
      else frontier.set(model, [id]);
    }
  };
  reach(root.name, roots);

  while (frontier.size) {
    const current = frontier;
    frontier = new Map();
    // Every cascade field of every model of the level: one subquery each, in one statement.
    const ctx = new QueryContext(schema);
    const parts: { field: ResolvedRelationField; column: string; text: string }[] = [];
    for (const [name, ids] of current) {
      const param = ctx.param(ids);
      for (const f of relations(nodeOf(name), "Cascade")) {
        const column = ctx.variable("k");
        const lock = `b.${q(LOCK_FLAG)}`;
        parts.push({
          field: f,
          column,
          text:
            `CALL { MATCH ${relationMatch(ctx, "a", f, "b", "", `elementId(a) IN ${param}`)} ` +
            `WITH DISTINCT b SET ${lock} = true REMOVE ${lock} ` +
            `RETURN collect({id: elementId(b), labels: labels(b)}) AS ${column} }`,
        });
      }
    }
    if (parts.length === 0) break;
    const [row] = await exec(
      `${parts.map((p) => p.text).join(" ")} RETURN ${parts.map((p) => p.column).join(", ")}`,
      ctx.params,
    );
    for (const p of parts) reach(p.field.target, (row?.[p.column] ?? []) as LockedNode[]);
  }

  const all = new Set<string>();
  for (const ids of doomed.values()) for (const id of ids) all.add(id);
  const ctx = new QueryContext(schema);
  const allParam = ctx.param([...all]);
  const checks: { model: string; field: ResolvedRelationField; column: string; text: string }[] =
    [];
  for (const [name, ids] of doomed) {
    const restricted = relations(nodeOf(name), "Restrict");
    if (ids.size === 0 || restricted.length === 0) continue;
    const param = ctx.param([...ids]);
    for (const f of restricted) {
      const column = ctx.variable("rc");
      checks.push({
        model: name,
        field: f,
        column,
        text:
          `CALL { MATCH ${relationMatch(ctx, "a", f, "b", "", `elementId(a) IN ${param} AND NOT elementId(b) IN ${allParam}`)} ` +
          `RETURN count(DISTINCT b) AS ${column} }`,
      });
    }
  }
  const counts = checks.map((c) => c.column);
  const ok = counts.length ? counts.map((c) => `${c} = 0`).join(" AND ") : null;
  const rootParam = ctx.param(roots.map((r) => r.id));
  let text = checks.map((c) => c.text).join(" ");
  text +=
    `${text ? ` WITH ${counts.join(", ")} ` : ""}CALL { ${counts.length ? `WITH ${counts.join(", ")} ` : ""}` +
    `MATCH (n) WHERE ${ok ? `${ok} AND ` : ""}elementId(n) IN ${allParam} ` +
    `WITH n, elementId(n) IN ${rootParam} AS isRoot DETACH DELETE n ` +
    `RETURN count(CASE WHEN isRoot THEN 1 END) AS c }`;
  text += ` RETURN ${["c", ...counts].join(", ")}`;
  const [row] = await exec(text, ctx.params);
  throwRestrict(checks, row ?? {});
  return toCount(row?.c);
}
