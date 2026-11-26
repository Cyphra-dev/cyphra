/**
 * Executes ORM operations for one node model against a {@link Runner}.
 *
 * Most operations are one statement. `create` / `update` compile the write, every nested relation
 * write (children batched per relation with `FOREACH`, each `connect` / `disconnect` / `set` a
 * subquery) and the projection of the result into one statement (see {@link WritePlan}); `delete`
 * locks, cascades, checks and deletes in one when its `onDelete` rules allow (see `onDelete.ts`).
 * A statement whose checks run after it wrote (a missing `connect` target, a broken `$edge`
 * `@min` / `@max`) throws inside its write transaction, which rolls the whole operation back.
 * Statements that write nothing when they fail are flagged with {@link RunOptions.autoCommit}, so
 * the HTTP transport can send them as one auto-commit request.
 *
 * @packageDocumentation
 */

import { isInt } from "../cypher-values.js";
import type { CyphraDialect } from "../dialect.js";
import type {
  ResolvedNodeModel,
  ResolvedRelationField,
  ResolvedScalarField,
  SchemaModel,
} from "@cyphra/schema";
import {
  QueryContext,
  assertCreatable,
  compileOrderBy,
  compilePaging,
  compileProjection,
  and,
  decodeRow,
  labelExpr,
  type Shape,
  nodeMatch,
  q,
  relationField,
  relationMatch,
  scalarField,
  unionPredicate,
  memberNames,
  scopedWhere,
} from "./compile.js";
import {
  cursorSortKeys,
  decodeCursor,
  encodeCursor,
  keysetPredicate,
  orderFingerprint,
  parseCursorArgs,
} from "./cursor.js";
import type { EngineRules } from "./scope.js";
import { compileAggregate, compileGroupBy } from "./aggregate.js";
import { DEFAULT_MAX_TRAVERSAL_DEPTH, compileTraverse } from "./traverse.js";
import { compileShortestPath } from "./shortest.js";
import { findSimilar } from "./vector.js";
import { search } from "./fulltext.js";
import { unionFindSimilar, unionSearch } from "./unionSearch.js";
import {
  LOCK_FLAG,
  compileRulesDelete,
  deleteWithRules,
  hasDeleteRules,
  lockAndRematch,
  throwRestrict,
} from "./onDelete.js";
import {
  CyphraError,
  CyphraValidationError,
  NotFoundError,
  UniqueConstraintError,
} from "./errors.js";
import { defaultLiteralValue, encodeScalar, integerToNumber, nowValue } from "./values.js";
import { numericGuard, throwGuardIssues, validateWriteArgs, type NumericCheck } from "./rules.js";
import { falkordbGuardedEdgeSet } from "./falkordb.js";
import { createLabels, labelItem, labelSuffix, updateLabels } from "./labels.js";

type AnyRecord = Record<string, unknown>;
/** Result of `createMany` / `updateMany` / `deleteMany`: `nodes` only with a `select`. */
type BatchResult = { count: number; nodes?: AnyRecord[] };

/** Runs one Cypher statement and returns raw driver records as objects. */
export type Executor = (text: string, params: AnyRecord) => Promise<AnyRecord[]>;

/** How a {@link Runner} may run a unit of work. */
export type RunOptions = {
  /**
   * The work runs exactly one statement, and that statement is safe to commit on its own (it
   * writes nothing when the operation fails). Outside `$transaction`, the HTTP transport then sends
   * it as one auto-commit request instead of opening, using and committing a transaction.
   */
  readonly autoCommit?: boolean;
};

/** Provides executors inside read or write transactions. */
export type Runner = {
  read<T>(fn: (exec: Executor) => Promise<T>, options?: RunOptions): Promise<T>;
  write<T>(fn: (exec: Executor) => Promise<T>, options?: RunOptions): Promise<T>;
};

/** Exactly one statement, safe to commit on its own (see {@link RunOptions.autoCommit}). */
const SINGLE: RunOptions = { autoCommit: true };

/**
 * A write statement being compiled: a root clause, then relation writes appended as clauses that
 * keep exactly one row (`FOREACH`, `CREATE`, `CALL { … RETURN <aggregate> }`), so the whole nested
 * write, and the projection of the written node, run as one statement.
 */
class WritePlan {
  private readonly clauses: string[];
  /** Variables in scope, carried by the `WITH` before every subquery. */
  private readonly scope: string[];
  /** Columns the checks read, returned next to the projection. */
  readonly outputs: string[] = [];
  /** Checks on the returned row, in statement order; each throws to fail the operation. */
  readonly checks: ((row: AnyRecord) => void)[] = [];
  /** Whether relation writes were added. */
  relations = false;

  constructor(
    readonly ctx: QueryContext,
    root: string,
    scope: readonly string[],
  ) {
    this.clauses = [root];
    this.scope = [...scope];
  }

  add(clause: string, bind: readonly string[] = []): void {
    this.clauses.push(clause);
    this.scope.push(...bind);
  }

  /** `WITH <scope> CALL { WITH <imports> <body> }`, where `body` returns one row of `returns`. */
  call(imports: readonly string[], body: string, returns: readonly string[]): void {
    this.add(`WITH ${this.scope.join(", ")} CALL { WITH ${imports.join(", ")} ${body} }`, returns);
  }

  /** Return `output` (a fresh variable bound by the statement) for a check. */
  output(name: string): void {
    this.outputs.push(name);
  }

  get text(): string {
    return this.clauses.join(" ");
  }

  /** Run the checks on the statement's row. */
  check(row: AnyRecord): void {
    for (const c of this.checks) c(row);
  }
}

function isPlainObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function toCount(v: unknown): number {
  return isInt(v) ? integerToNumber(v) : Number(v ?? 0);
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Collision-resistant, URL-safe id (cuid2-style: a letter followed by 23 base-36 chars). */
export function createCuid(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
  let s = ALPHABET[bytes[0]! % 26]!;
  for (let i = 1; i < 24; i++) s += ALPHABET[bytes[i]! % 36]!;
  return s;
}

/** Temporary property marking a node created by an upsert's MERGE (removed in the same statement). */
const UPSERT_FLAG = "__cyphraUpsertCreated";

/** Memgraph: how many times an upsert whose MERGE lost a race on its key is run again. */
const MEMGRAPH_UPSERT_RETRIES = 5;

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === "bigint" || typeof b === "bigint") return String(a) === String(b);
  return a === b;
}

/** Where a value sits in the operation's arguments, for validation issues (`data.posts.connect`). */
type IssuePath = readonly (string | number)[];

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

/** Client-level options that change how operations compile. */
export type EngineOptions = {
  /** Upper bound for `traverse` `depth.max` (default 10). */
  readonly maxTraversalDepth?: number;
  /** The Cypher flavour to compile to (default `"neo4j"`). */
  readonly dialect?: CyphraDialect;
  /** Rules ANDed into every statement (see {@link EngineRules}); every set applies. */
  readonly rules?: readonly EngineRules[];
  /** Return projected scalars as the driver gives them (see {@link withRawValues}). */
  readonly rawValues?: boolean;
};

/** Column holding the sort keys of a row, for its `$cursor`. */
const CURSOR_COLUMN = "__cursor";

export class ModelEngine {
  constructor(
    private readonly schema: SchemaModel,
    private readonly model: ResolvedNodeModel,
    private readonly runner: Runner,
    private readonly options: EngineOptions = {},
  ) {}

  private ctx(): QueryContext {
    return new QueryContext(
      this.schema,
      this.options.dialect,
      this.options.rules,
      this.options.rawValues === true,
    );
  }

  private get label(): string {
    return labelExpr(this.model);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  private async readMany(exec: Executor, args: AnyRecord): Promise<AnyRecord[]> {
    const projected = this.withoutCursorSelect(args);
    const cursor = parseCursorArgs(this.model, args.cursor);
    if (cursor || projected.withCursor) {
      return this.readPage(exec, projected.args, cursor ?? {}, projected.withCursor);
    }
    const ctx = this.ctx();
    const where = scopedWhere(ctx, this.model, "n", args.where);
    const paging = compilePaging(ctx, this.model, "n", args);
    const { expr, shape } = compileProjection(ctx, this.model, "n", args);
    let text = `MATCH ${nodeMatch("n", this.model, where)}`;
    if (paging) text += ` WITH n${paging}`;
    text += ` RETURN ${expr} AS row`;
    // Re-apply the order on the projected rows (WITH … ORDER BY only orders that clause).
    const order = compileOrderBy(ctx, this.model, "n", args.orderBy);
    if (order) text += ` ORDER BY ${order}`;
    const rows = await exec(text, ctx.params);
    return rows.map((r) => decodeRow(shape, r.row)!);
  }

  /** `args` without `$cursor` in its `select` / `include`, and whether it asked for it. */
  private withoutCursorSelect(args: AnyRecord): { args: AnyRecord; withCursor: boolean } {
    for (const key of ["select", "include"] as const) {
      const spec = args[key];
      if (!isPlainObject(spec) || spec.$cursor === undefined) continue;
      if (typeof spec.$cursor !== "boolean") {
        throw new CyphraValidationError(`${this.model.name}.findMany: ${key}.$cursor takes true.`);
      }
      const { $cursor, ...rest } = spec;
      return { args: { ...args, [key]: rest }, withCursor: $cursor };
    }
    return { args, withCursor: false };
  }

  /**
   * `findMany` with keyset paging: the sort keys (`orderBy`, then the `@id`) are bound once per
   * node, the nodes after / before the cursors kept, then ordered and paged. With only `before`,
   * the page is the last `take` nodes before it: the order is reversed for paging, and restored
   * for the result.
   */
  private async readPage(
    exec: Executor,
    args: AnyRecord,
    cursor: { after?: string; before?: string },
    withCursor: boolean,
  ): Promise<AnyRecord[]> {
    const ctx = this.ctx();
    const where = scopedWhere(ctx, this.model, "n", args.where);
    const keys = cursorSortKeys(ctx, this.model, "n", args.orderBy);
    const vars = keys.map(() => ctx.variable("k"));
    const print = orderFingerprint(this.model, args.orderBy);
    const conditions = (["after", "before"] as const).flatMap((side) => {
      const c = cursor[side];
      if (c === undefined) return [];
      const params = decodeCursor(ctx, this.model, print, keys, c, side);
      return [keysetPredicate(keys, vars, params, side)];
    });
    const reverse = cursor.before !== undefined && cursor.after === undefined;
    const order = (flip: boolean) =>
      keys
        .map((k, i) => `${vars[i]} ${flip ? (k.dir === "ASC" ? "DESC" : "ASC") : k.dir}`)
        .join(", ");
    const bound = keys.map((k, i) => `${k.expr} AS ${vars[i]}`).join(", ");
    let text = `MATCH ${nodeMatch("n", this.model, where)} WITH n, ${bound}`;
    const keep = and(conditions);
    if (keep) text += ` WHERE ${keep}`;
    text += ` WITH n, ${vars.join(", ")} ORDER BY ${order(reverse)}`;
    text += compilePaging(ctx, this.model, "n", { skip: args.skip, take: args.take });
    const { expr, shape } = compileProjection(ctx, this.model, "n", args);
    text += ` RETURN ${expr} AS row`;
    if (withCursor) text += `, [${vars.join(", ")}] AS ${CURSOR_COLUMN}`;
    text += ` ORDER BY ${order(false)}`;
    const rows = await exec(text, ctx.params);
    return rows.map((r) => {
      const row = decodeRow(shape, r.row)!;
      if (withCursor) row.$cursor = encodeCursor(print, keys, r[CURSOR_COLUMN]);
      return row;
    });
  }

  /**
   * Check that `where` identifies at most one node and flatten its compound keys: a `@@unique`
   * key (`{ a_b: { a, b } }`) becomes its fields (`{ a, b }`). Returns the flattened filter and the
   * fields of the unique key it sets (the first one, single fields before compound keys).
   */
  private uniqueWhere(where: unknown, op: string): { where: AnyRecord; key: readonly string[] } {
    const present = (v: unknown) => v !== undefined && v !== null && !isPlainObject(v);
    const compounds = this.model.compoundUniques ?? [];
    let flat: AnyRecord | undefined;
    if (isPlainObject(where)) {
      flat = { ...where };
      for (const c of compounds) {
        const value = flat[c.key];
        if (value === undefined) continue;
        delete flat[c.key];
        if (!isPlainObject(value)) {
          throw new CyphraValidationError(
            `${this.model.name}.${op}: where.${c.key} must be an object with ${c.fields.join(", ")}.`,
          );
        }
        for (const [k, v] of Object.entries(value)) {
          if (!c.fields.includes(k)) {
            throw new CyphraValidationError(
              `${this.model.name}.${op}: where.${c.key}.${k} is not a field of the key (${c.fields.join(", ")}).`,
            );
          }
          if (!present(v)) {
            throw new CyphraValidationError(
              `${this.model.name}.${op}: where.${c.key}.${k} must be a value (not null or a filter).`,
            );
          }
          if (flat[k] !== undefined && !sameValue(flat[k], v)) {
            throw new CyphraValidationError(
              `${this.model.name}.${op}: where.${k} and where.${c.key}.${k} differ.`,
            );
          }
          flat[k] = v;
        }
        const missing = c.fields.filter((f) => value[f] === undefined);
        if (missing.length) {
          throw new CyphraValidationError(
            `${this.model.name}.${op}: where.${c.key} must set ${missing.join(", ")}.`,
          );
        }
      }
    }
    const single = flat && this.model.uniqueFields.find((k) => present(flat[k]));
    if (flat && single) return { where: flat, key: [single] };
    const compound = flat && compounds.find((c) => c.fields.every((f) => present(flat[f])));
    if (flat && compound) return { where: flat, key: compound.fields };
    const keys = [
      ...this.model.uniqueFields,
      ...compounds.map((c) => `${c.key} { ${c.fields.join(", ")} }`),
    ];
    throw new CyphraValidationError(
      `${this.model.name}.${op}: where must set at least one unique field (${keys.join(", ") || "none declared — add @id, @unique or @@unique"}).`,
    );
  }

  private assertUnique(where: unknown, op: string): AnyRecord {
    return this.uniqueWhere(where, op).where;
  }

  /**
   * A union is read through `findMany`, `findFirst`, `count`, and `search` / `findSimilar` over its
   * members' indexes only: it has no unique key, no fields to aggregate, and is written through
   * its members.
   */
  private assertNotUnion(op: string): void {
    if (!this.model.union) return;
    const members = this.model.implementations ?? [];
    throw new CyphraValidationError(
      `${this.model.name}.${op}: ${this.model.name} is a union; it supports findMany, findFirst, count, search and findSimilar (${op} goes through one of its members: ${members.join(", ")}).`,
    );
  }

  findMany(args: AnyRecord = {}): Promise<AnyRecord[]> {
    return this.runner.read((exec) => this.readMany(exec, args), SINGLE);
  }

  async findFirst(args: AnyRecord = {}): Promise<AnyRecord | null> {
    const rows = await this.findMany({ ...args, take: 1 });
    return rows[0] ?? null;
  }

  async findUnique(args: AnyRecord): Promise<AnyRecord | null> {
    this.assertNotUnion("findUnique");
    const where = this.assertUnique(args.where, "findUnique");
    const rows = await this.findMany({
      ...args,
      where,
      take: 1,
      skip: undefined,
      orderBy: undefined,
      cursor: undefined,
    });
    return rows[0] ?? null;
  }

  async findUniqueOrThrow(args: AnyRecord): Promise<AnyRecord> {
    this.assertNotUnion("findUniqueOrThrow");
    const row = await this.findUnique(args);
    if (!row)
      throw new NotFoundError(`No ${this.model.name} matches ${JSON.stringify(args.where)}.`);
    return row;
  }

  count(args: AnyRecord = {}): Promise<number> {
    return this.runner.read(async (exec) => {
      const ctx = this.ctx();
      const w = scopedWhere(ctx, this.model, "n", args.where);
      const rows = await exec(
        `MATCH ${nodeMatch("n", this.model, w)} RETURN count(n) AS c`,
        ctx.params,
      );
      return toCount(rows[0]?.c);
    }, SINGLE);
  }

  /** One statement; see {@link compileAggregate}. */
  aggregate(args: AnyRecord = {}): Promise<AnyRecord> {
    this.assertNotUnion("aggregate");
    return this.runner.read(async (exec) => {
      if (!isPlainObject(args))
        throw new CyphraValidationError("aggregate args must be an object.");
      const c = compileAggregate(this.ctx(), this.model, args);
      return c.decode(await exec(c.text, c.params));
    }, SINGLE);
  }

  /** One statement; see {@link compileGroupBy}. */
  groupBy(args: AnyRecord): Promise<AnyRecord[]> {
    this.assertNotUnion("groupBy");
    return this.runner.read(async (exec) => {
      if (!isPlainObject(args)) throw new CyphraValidationError("groupBy args must be an object.");
      const c = compileGroupBy(this.ctx(), this.model, args);
      return c.decode(await exec(c.text, c.params));
    }, SINGLE);
  }

  /** One statement; see {@link compileTraverse}. */
  traverse(args: AnyRecord): Promise<unknown[]> {
    this.assertNotUnion("traverse");
    return this.runner.read(async (exec) => {
      if (!isPlainObject(args)) throw new CyphraValidationError("traverse args must be an object.");
      const max = this.options.maxTraversalDepth ?? DEFAULT_MAX_TRAVERSAL_DEPTH;
      const c = compileTraverse(this.ctx(), this.model, args, max);
      return c.decode(await exec(c.text, c.params));
    }, SINGLE);
  }

  /** One statement; see {@link compileShortestPath}. */
  async shortestPath(args: AnyRecord): Promise<unknown> {
    this.assertNotUnion("shortestPath");
    return (await this.shortest(args, false))[0] ?? null;
  }

  /** One statement; see {@link compileShortestPath}. */
  allShortestPaths(args: AnyRecord): Promise<unknown[]> {
    this.assertNotUnion("allShortestPaths");
    return this.shortest(args, true);
  }

  private shortest(args: AnyRecord, all: boolean): Promise<unknown[]> {
    return this.runner.read(async (exec) => {
      if (!isPlainObject(args)) {
        throw new CyphraValidationError(
          `${all ? "allShortestPaths" : "shortestPath"} args must be an object.`,
        );
      }
      const max = this.options.maxTraversalDepth ?? DEFAULT_MAX_TRAVERSAL_DEPTH;
      const c = compileShortestPath(this.ctx(), this.model, args, max, all);
      return c.decode(await exec(c.text, c.params));
    }, SINGLE);
  }

  /** Nearest neighbours on a `@vectorIndex` field; see {@link findSimilar}. */
  findSimilar(args: AnyRecord): Promise<AnyRecord[]> {
    if (this.model.union) {
      // Over a union: one statement, each member's index ranked and fused (see unionSearch.ts).
      return this.runner.read(async (exec) => {
        if (!isPlainObject(args))
          throw new CyphraValidationError("findSimilar args must be an object.");
        return unionFindSimilar(exec, this.ctx(), this.model, args);
      }, SINGLE);
    }
    return this.runner.read(
      async (exec) => {
        if (!isPlainObject(args))
          throw new CyphraValidationError("findSimilar args must be an object.");
        return findSimilar(exec, () => this.ctx(), this.model, args);
        // A filtered approximate search may ask the index again for more candidates.
      },
      isPlainObject(args) && (args.exact === true || args.where === undefined) ? SINGLE : {},
    );
  }

  /** Full-text search through a `@@fulltext` index; see {@link search}. */
  search(args: AnyRecord): Promise<AnyRecord[]> {
    return this.runner.read(async (exec) => {
      if (!isPlainObject(args)) throw new CyphraValidationError("search args must be an object.");
      // Over a union: each member's index ranked and fused (see unionSearch.ts).
      if (this.model.union) return unionSearch(exec, this.ctx(), this.model, args);
      return search(exec, () => this.ctx(), this.model, args);
    }, SINGLE);
  }

  // -------------------------------------------------------------------------
  // Write helpers
  // -------------------------------------------------------------------------

  private node(name: string): ResolvedNodeModel {
    return new QueryContext(this.schema).node(name);
  }

  private engineFor(model: ResolvedNodeModel): ModelEngine {
    return model === this.model
      ? this
      : new ModelEngine(this.schema, model, this.runner, this.options);
  }

  /** Encode scalar data for CREATE, applying defaults and checking required fields. */
  private static createProps(
    owner: string,
    fields: readonly ResolvedScalarField[],
    data: AnyRecord,
  ): AnyRecord {
    const props: AnyRecord = {};
    for (const f of fields) {
      const v = data[f.name];
      if (v !== undefined && v !== null) {
        props[f.name] = encodeScalar(f, v, owner);
        continue;
      }
      if (v === null && !f.optional && !f.list) {
        throw new CyphraValidationError(`${owner}.${f.name} is required and cannot be null.`);
      }
      if (v === undefined && f.default) {
        const d = f.default;
        const value =
          d.kind === "literal"
            ? defaultLiteralValue(f, d)
            : d.fn === "uuid"
              ? globalThis.crypto.randomUUID()
              : d.fn === "cuid"
                ? createCuid()
                : nowValue(f);
        props[f.name] = encodeScalar(f, value, owner);
        continue;
      }
      if (v === undefined && !f.optional && !f.list) {
        throw new CyphraValidationError(`${owner}.${f.name} is required.`);
      }
    }
    return props;
  }

  /** Split write `data` into scalars, relation writes and `$labels` (left unchecked). */
  private splitData(
    data: unknown,
    op: string,
  ): { scalars: AnyRecord; relations: AnyRecord; labels: unknown } {
    if (!isPlainObject(data))
      throw new CyphraValidationError(`${this.model.name}.${op}: data must be an object.`);
    const scalars: AnyRecord = {};
    const relations: AnyRecord = {};
    let labels: unknown;
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (k === "$labels") {
        labels = v;
        continue;
      }
      const f = this.model.fields.find((x) => x.name === k);
      if (!f)
        throw new CyphraValidationError(`Unknown field "${this.model.name}.${k}" in ${op} data.`);
      (f.kind === "scalar" ? scalars : relations)[k] = v;
    }
    return { scalars, relations, labels };
  }

  private edgeProps(rel: ResolvedRelationField, input: unknown): AnyRecord {
    if (input === undefined) {
      if (!rel.edge) return {};
      input = {};
    }
    const edgeModel = rel.edge
      ? this.schema.relationships.find((r) => r.name === rel.edge)
      : undefined;
    if (!edgeModel) {
      throw new CyphraValidationError(
        `${this.model.name}.${rel.name}: $edge given but no relationship model types this edge.`,
      );
    }
    if (!isPlainObject(input)) throw new CyphraValidationError("$edge must be an object.");
    for (const k of Object.keys(input)) {
      if (!edgeModel.properties.some((p) => p.name === k)) {
        throw new CyphraValidationError(`Unknown edge property "${edgeModel.name}.${k}".`);
      }
    }
    return ModelEngine.createProps(edgeModel.name, edgeModel.properties, input);
  }

  /**
   * The other side of `rel` on the target model when it is a to-one relation (same type, opposite
   * direction, pointing back at this model or one of its interfaces), e.g. `Post.author` for
   * `User.posts`.
   */
  private toOneInverse(
    rel: ResolvedRelationField,
    target: ResolvedNodeModel = this.node(rel.target),
  ): ResolvedRelationField | undefined {
    // The fields of `target` that can point back at this model: to it, an interface of it, or a
    // union it is a member of.
    const unions = this.schema.nodes
      .filter((n) => n.union && (n.implementations ?? []).includes(this.model.name))
      .map((n) => n.name);
    const self = [this.model.name, ...(this.model.interfaces ?? []), ...unions];
    return target.fields.find(
      (f): f is ResolvedRelationField =>
        f.kind === "relation" &&
        !f.many &&
        f.relType === rel.relType &&
        f.direction !== rel.direction &&
        self.includes(f.target),
    );
  }

  /**
   * The model an item of a relation write targets and the item's value: the relation's target
   * itself, or for a union the member the item names (`{ Post: { id } }`: exactly one member).
   */
  private memberOf(
    rel: ResolvedRelationField,
    item: AnyRecord,
    op: string,
  ): { target: ResolvedNodeModel; value: unknown } {
    const target = this.node(rel.target);
    if (!target.union) return { target, value: item };
    // A member, an implementation of an interface member, or the interface member itself.
    const members = memberNames(target);
    const keys = Object.keys(item).filter((k) => item[k] !== undefined);
    if (keys.length !== 1 || !members.includes(keys[0]!)) {
      throw new CyphraValidationError(
        `${op}: ${target.name} is a union; name the member of each item, e.g. { ${members[0] ?? "Member"}: { … } } (one of ${members.join(", ")})${keys.length ? `, got ${keys.join(", ")}` : ""}.`,
      );
    }
    return { target: this.node(keys[0]!), value: item[keys[0]!] };
  }

  /**
   * The `where` matching one related node given by its unique key: the key itself, or for a union
   * `{ $on: { Post: { id } } }` from `{ Post: { id } }`.
   */
  private uniqueKey(rel: ResolvedRelationField, item: AnyRecord, op: string): AnyRecord {
    const { target, value } = this.memberOf(rel, item, op);
    if (!isPlainObject(value)) {
      throw new CyphraValidationError(`${op}.${target.name} expects a unique where object.`);
    }
    const where = this.engineFor(target).assertUnique(value, op);
    return target.name === rel.target ? where : { $on: { [target.name]: where } };
  }

  /** Only the `$edge` properties the caller set (no defaults), for updating an existing edge. */
  private explicitEdgeProps(rel: ResolvedRelationField, input: unknown): AnyRecord {
    if (!rel.edge || !isPlainObject(input)) return {};
    const edgeModel = this.schema.relationships.find((r) => r.name === rel.edge)!;
    const props: AnyRecord = {};
    for (const f of edgeModel.properties) {
      if (input[f.name] !== undefined)
        props[f.name] = encodeScalar(f, input[f.name], edgeModel.name);
    }
    return props;
  }

  /**
   * Split the number updates (`{ weight: { increment: 1 } }`) out of `$edge`: the other
   * properties, and the `SET` assignments on edge variable `r` with the `@min` / `@max` checks of
   * the values they produce. A missing value counts as `0`; a new edge starts from the field's
   * default (or `0`), so `{ increment: 1 }` counts how many times an edge was connected.
   */
  private edgeUpdates(
    ctx: QueryContext,
    rel: ResolvedRelationField,
    input: unknown,
    at: string,
    r = "r",
  ): { plain: unknown; base: AnyRecord; sets: string[]; checks: NumericCheck[] } {
    const none = { plain: input, base: {}, sets: [], checks: [] };
    if (!rel.edge || !isPlainObject(input)) return none;
    const edgeModel = this.schema.relationships.find((r) => r.name === rel.edge)!;
    const plain: AnyRecord = {};
    const base: AnyRecord = {};
    const sets: string[] = [];
    const checks: NumericCheck[] = [];
    for (const [k, v] of Object.entries(input)) {
      const f = edgeModel.properties.find((p) => p.name === k);
      const numeric =
        f && !f.list && (f.type === "Int" || f.type === "Float" || f.type === "BigInt");
      if (!f || !numeric || !isPlainObject(v)) {
        plain[k] = v;
        continue;
      }
      const ref = `${r}.${q(k)}`;
      const zero = ctx.param(encodeScalar(f, f.type === "BigInt" ? 0n : 0, edgeModel.name));
      let result = `coalesce(${ref}, ${zero})`;
      for (const [op, amount] of Object.entries(v)) {
        if (amount === undefined) continue;
        const sym = { increment: "+", decrement: "-", multiply: "*" }[op];
        if (!sym) throw new CyphraValidationError(`${at}.${k}: unknown number update "${op}".`);
        result = `(${result} ${sym} ${ctx.param(encodeScalar(f, amount, edgeModel.name))})`;
      }
      sets.push(`${ref} = ${result}`);
      // A new edge gets the operators applied to the default, or to 0 when there is none.
      if (!f.default) base[k] = f.type === "BigInt" ? 0n : 0;
      for (const r of f.rules ?? []) {
        if (r.rule !== "min" && r.rule !== "max") continue;
        const limit = f.type === "BigInt" ? BigInt(r.value) : r.value;
        const bound = ctx.param(encodeScalar(f, limit, edgeModel.name));
        checks.push({ field: f, rule: r.rule, result: ref, bound });
      }
    }
    return { plain, base, sets, checks };
  }

  /** `(a)-[r:T $props]->(b)` (or reversed) for `rel`; `r` and `props` may be left out. */
  private static edgePattern(
    rel: ResolvedRelationField,
    a: string,
    b: string,
    r = "",
    props = "",
  ): string {
    const edge = `[${r}:${q(rel.relType)}${props ? ` ${props}` : ""}]`;
    return rel.direction === "OUT" ? `(${a})-${edge}->(${b})` : `(${a})<-${edge}-(${b})`;
  }

  /**
   * Validate the data of a node to create: its encoded scalar properties (with defaults) and its
   * nested relation writes.
   */
  private createData(
    data: unknown,
    op: string,
  ): { props: AnyRecord; relations: AnyRecord; labels: string[] } {
    assertCreatable(this.model, `${this.model.name}.${op}`);
    const { scalars, relations, labels } = this.splitData(data, op);
    const fields = this.model.fields.filter((f): f is ResolvedScalarField => f.kind === "scalar");
    return {
      props: ModelEngine.createProps(this.model.name, fields, scalars),
      relations,
      labels: createLabels(this.model, labels, `${this.model.name}.${op}: data`),
    };
  }

  /** One statement creating a node (`n`) with every nested relation write of `data`. */
  private planCreate(ctx: QueryContext, data: unknown): WritePlan {
    const { props, relations, labels } = this.createData(data, "create");
    const plan = new WritePlan(
      ctx,
      `CREATE (n:${this.label}${labelSuffix(labels)} ${ctx.param(props)})`,
      ["n"],
    );
    this.planRelations(plan, "n", relations, "create", ["data"]);
    return plan;
  }

  /** Append the relation writes `relations` of the node bound to `own` to `plan`. */
  private planRelations(
    plan: WritePlan,
    own: string,
    relations: AnyRecord,
    mode: "create" | "update",
    path: IssuePath,
  ): void {
    for (const [k, v] of Object.entries(relations)) {
      this.planRelation(plan, own, relationField(this.model, k)!, v, mode, [...path, k]);
    }
  }

  /**
   * Link `own` to one existing node. Idempotent: the edge is `MERGE`d, so connecting the same pair
   * again keeps a single edge. On a typed edge, a new edge gets the given `$edge` properties plus
   * schema defaults; an existing edge is updated with the given `$edge` properties only (its
   * defaults, e.g. `@default(now())`, are kept). A subquery returning the number of edges linked
   * (0: no such node) and the broken `@min` / `@max` checks of `$edge` number updates.
   */
  private planConnect(
    plan: WritePlan,
    own: string,
    rel: ResolvedRelationField,
    item: unknown,
    path: IssuePath,
  ): void {
    if (!isPlainObject(item))
      throw new CyphraValidationError(`${rel.name}.connect expects unique where objects.`);
    const { $edge, ...rest } = item;
    const op = `${this.model.name}.${rel.name}.connect`;
    const { target, value: unique } = this.memberOf(rel, rest, op);
    if (!isPlainObject(unique)) {
      throw new CyphraValidationError(`${op}.${target.name} expects a unique where object.`);
    }
    const where = this.engineFor(target).assertUnique(unique, op);
    const ctx = plan.ctx;
    const [a, b, r] = [own, ctx.variable("b"), ctx.variable("r")];
    const updates = this.edgeUpdates(ctx, rel, $edge, `${this.model.name}.${rel.name}.$edge`, r);
    const onCreate = this.edgeProps(
      rel,
      isPlainObject(updates.plain) ? { ...updates.plain, ...updates.base } : updates.plain,
    );
    const onMatch = this.explicitEdgeProps(rel, updates.plain);
    // A node the rules hide cannot be connected.
    const w = scopedWhere(ctx, target, b, where);
    let text = `MATCH (${b}:${labelExpr(target)})${w ? ` WHERE ${w}` : ""} WITH ${a}, ${b} LIMIT 1 `;
    // A to-one side can hold only one such edge: lock that node (so concurrent connects
    // serialize), then drop its edge to any other node before linking `a` and `b`.
    const replace = (node: string, old: string, oldEdge: string) => {
      const lock = `${node}.${q(LOCK_FLAG)}`;
      text +=
        `SET ${lock} = true REMOVE ${lock} WITH ${a}, ${b} ` +
        `OPTIONAL MATCH ${old} DELETE ${oldEdge} WITH DISTINCT ${a}, ${b} `;
    };
    if (!rel.many) {
      const [other, old] = [ctx.variable("x"), ctx.variable("o")];
      replace(a, relationMatch(ctx, a, rel, other, old, `${other} <> ${b}`), old);
    } else if (this.options.dialect === "memgraph") {
      // Memgraph's MERGE takes no lock: concurrent connects of one pair would each create an
      // edge. A write to `a` makes them conflict instead (a transient error, retried by the
      // driver), and the retry's MERGE finds the committed edge.
      const lock = `${a}.${q(LOCK_FLAG)}`;
      text += `SET ${lock} = true REMOVE ${lock} WITH ${a}, ${b} `;
    }
    const inverse = this.toOneInverse(rel, target);
    if (inverse) {
      const [other, old] = [ctx.variable("x"), ctx.variable("o")];
      const back = this.node(inverse.target);
      const from = back.union ? other : `${other}:${labelExpr(back)}`;
      const cond = and([unionPredicate(other, back), `${other} <> ${a}`]);
      replace(b, `${ModelEngine.edgePattern(rel, from, b, old)} WHERE ${cond}`, old);
    }
    text += `MERGE ${ModelEngine.edgePattern(rel, a, b, r)}`;
    if (Object.keys(onCreate).length) text += ` ON CREATE SET ${r} += ${ctx.param(onCreate)}`;
    if (Object.keys(onMatch).length) text += ` ON MATCH SET ${r} += ${ctx.param(onMatch)}`;
    // The checks run on the values the updates produced: a broken one throws, which rolls the
    // write transaction back. FalkorDB cannot roll back: the checks run first, and the updates
    // only when they pass.
    const guard = numericGuard(updates.checks);
    const checkFirst = guard !== null && this.options.dialect === "falkordb";
    const broken = checkFirst ? ctx.variable("w") : undefined;
    if (broken) text += falkordbGuardedEdgeSet(updates.sets, updates.checks, [a, b, r], broken);
    else if (updates.sets.length) text += ` SET ${updates.sets.join(", ")}`;
    const count = ctx.variable("c");
    const bad = guard ? ctx.variable("g") : undefined;
    plan.call(
      [a],
      `${text} RETURN count(${r}) AS ${count}${bad ? `, collect(${broken ?? guard})[0] AS ${bad}` : ""}`,
      bad ? [count, bad] : [count],
    );
    plan.relations = true;
    plan.output(count);
    if (bad) plan.output(bad);
    plan.checks.push((row) => {
      if (toCount(row[count]) === 0) {
        throw new NotFoundError(`connect: no ${target.name} matches ${JSON.stringify(where)}.`);
      }
      if (bad) {
        const edgeModel = this.schema.relationships.find((m) => m.name === rel.edge)!;
        const owner = { ...this.model, name: edgeModel.name };
        throwGuardIssues("update", owner, updates.checks, row[bad], [...path, "$edge"]);
      }
    });
  }

  /**
   * Create the nodes of `items` linked to `own` through `rel`. Runs of items without nested
   * relation writes are created by one `FOREACH` over their properties; an item with nested
   * writes gets its own `CREATE`, followed by its relation writes. Items are created in order.
   */
  private planCreates(
    plan: WritePlan,
    own: string,
    rel: ResolvedRelationField,
    items: readonly { item: unknown; path: IssuePath }[],
  ): void {
    const ctx = plan.ctx;
    // A batch shares its labels (`batchLabels`: the target's, then its dynamic labels): they are
    // part of its CREATE pattern. Items of a relation to a union name their member.
    let batch: { p: AnyRecord; e: AnyRecord }[] = [];
    let batchLabels = "";
    const flush = () => {
      if (!batch.length) return;
      const [x, c, r] = [ctx.variable("x"), ctx.variable("c"), ctx.variable("r")];
      const typed = batch.some((row) => Object.keys(row.e).length > 0);
      const edge = ModelEngine.edgePattern(rel, own, c, typed ? r : "");
      plan.add(
        `FOREACH (${x} IN ${ctx.param(batch)} | CREATE (${c}:${batchLabels}) SET ${c} = ${x}.p ` +
          `CREATE ${edge}${typed ? ` SET ${r} = ${x}.e` : ""})`,
      );
      batch = [];
    };
    for (const { item, path } of items) {
      if (!isPlainObject(item))
        throw new CyphraValidationError(`${rel.name}.create expects objects.`);
      const { $edge, ...rest } = item;
      const { target, value: data } = this.memberOf(
        rel,
        rest,
        `${this.model.name}.${rel.name}.create`,
      );
      const child = this.engineFor(target);
      if (this.edgeUpdates(ctx, rel, $edge, "").sets.length) {
        throw new CyphraValidationError(
          `${this.model.name}.${rel.name}.create: $edge number updates ({ increment, … }) are for connect and set; create makes a new edge, so give the value itself.`,
        );
      }
      const edge = this.edgeProps(rel, $edge);
      const { props, relations, labels } = child.createData(data, "create");
      const extra = labelSuffix(labels);
      plan.relations = true;
      if (Object.keys(relations).length === 0) {
        const all = `${labelExpr(target)}${extra}`;
        if (all !== batchLabels) flush();
        batchLabels = all;
        batch.push({ p: props, e: edge });
        continue;
      }
      flush();
      const c = ctx.variable("c");
      const e = Object.keys(edge).length ? ctx.param(edge) : "";
      plan.add(
        `CREATE (${c}:${labelExpr(target)}${extra} ${ctx.param(props)}) ` +
          `CREATE ${ModelEngine.edgePattern(rel, own, c, "", e)}`,
        [c],
      );
      child.planRelations(plan, c, relations, "create", path);
    }
    flush();
  }

  /** Delete the `rel` edges of `own` (to the nodes matching `where`, when given). */
  private planDeleteEdges(
    plan: WritePlan,
    own: string,
    rel: ResolvedRelationField,
    where?: AnyRecord,
  ): void {
    const ctx = plan.ctx;
    const target = this.node(rel.target);
    const [b, r, d] = [ctx.variable("b"), ctx.variable("r"), ctx.variable("d")];
    // `disconnect` / `set` only see the nodes the rules show; replacing a to-one edge (no
    // `where`) drops it whatever its target.
    const w = where ? scopedWhere(ctx, target, b, where) : null;
    plan.call(
      [own],
      `MATCH ${relationMatch(ctx, own, rel, b, r, w)} DELETE ${r} RETURN count(*) AS ${d}`,
      [d],
    );
    plan.relations = true;
  }

  private planRelation(
    plan: WritePlan,
    own: string,
    rel: ResolvedRelationField,
    spec: unknown,
    mode: "create" | "update",
    path: IssuePath,
  ): void {
    if (!isPlainObject(spec)) {
      throw new CyphraValidationError(
        `${this.model.name}.${rel.name}: relation writes take { create, connect, … }.`,
      );
    }
    const allowed =
      mode === "create" ? ["create", "connect"] : ["create", "connect", "disconnect", "set"];
    for (const k of Object.keys(spec)) {
      if (!allowed.includes(k) || (k === "set" && !rel.many)) {
        throw new CyphraValidationError(
          `${this.model.name}.${rel.name}: unsupported relation operation "${k}".`,
        );
      }
    }
    const { create, connect, disconnect, set } = spec;
    if (!rel.many) {
      for (const [k, v] of [
        ["create", create],
        ["connect", connect],
      ] as const) {
        if (Array.isArray(v))
          throw new CyphraValidationError(
            `${rel.name}.${k}: to-one relations take a single object.`,
          );
      }
      if ([create, connect].filter((x) => x !== undefined).length > 1) {
        throw new CyphraValidationError(
          `${rel.name}: use only one of create / connect on a to-one relation.`,
        );
      }
    }

    if (rel.many) {
      if (disconnect !== undefined) {
        const keys = asArray(disconnect).map((item) => {
          if (!isPlainObject(item))
            throw new CyphraValidationError(`${rel.name}.disconnect expects unique where objects.`);
          return this.uniqueKey(rel, item, `${this.model.name}.${rel.name}.disconnect`);
        });
        if (keys.length) this.planDeleteEdges(plan, own, rel, { OR: keys });
      }
      if (set !== undefined) {
        if (!Array.isArray(set))
          throw new CyphraValidationError(`${rel.name}.set expects an array.`);
        // Drop the edges to nodes not in the list; the others are kept and updated by connect
        // (so `$edge` number updates apply to the existing edge).
        const keep = set.map((item: unknown) => {
          if (!isPlainObject(item))
            throw new CyphraValidationError(`${rel.name}.set expects unique where objects.`);
          const { $edge: _edge, ...unique } = item;
          return this.uniqueKey(rel, unique, `${this.model.name}.${rel.name}.set`);
        });
        this.planDeleteEdges(plan, own, rel, { NOT: { OR: keep } });
        for (const [i, item] of set.entries()) {
          this.planConnect(plan, own, rel, item, [...path, "set", i]);
        }
      }
    } else if (disconnect === true || (mode === "update" && create !== undefined)) {
      // To-one: replace the existing edge (`connect` replaces it in its own subquery).
      this.planDeleteEdges(plan, own, rel);
    } else if (disconnect !== undefined && disconnect !== false) {
      throw new CyphraValidationError(
        `${rel.name}.disconnect on a to-one relation takes a boolean.`,
      );
    }

    if (connect !== undefined) {
      for (const [i, item] of asArray(connect).entries()) {
        const at = Array.isArray(connect) ? [...path, "connect", i] : [...path, "connect"];
        this.planConnect(plan, own, rel, item, at);
      }
    }
    if (create !== undefined) {
      const items = asArray(create).map((item, i) => ({
        item,
        path: Array.isArray(create) ? [...path, "create", i] : [...path, "create"],
      }));
      this.planCreates(plan, own, rel, items);
    }
  }

  /**
   * Run `plan` (ending in `RETURN <projection of n> AS row`, plus `extra` columns): one statement,
   * sent on its own (auto-commit over HTTP) when nothing it writes depends on a check. Returns the
   * row, after `before` and the plan's checks ran on it.
   */
  private async runPlan(
    plan: WritePlan,
    args: AnyRecord,
    options: {
      extra?: readonly string[];
      autoCommit: boolean;
      missing?: () => Error;
      before?: (row: AnyRecord) => void;
    },
  ): Promise<AnyRecord> {
    const { expr, shape } = compileProjection(plan.ctx, this.model, "n", args);
    const columns = [`${expr} AS row`, ...(options.extra ?? []), ...plan.outputs];
    const text = `${plan.text} RETURN ${columns.join(", ")}`;
    return this.runner.write(
      async (exec) => {
        const rows = await exec(text, plan.ctx.params);
        const row = rows[0];
        if (!row) throw options.missing?.() ?? new NotFoundError(`${this.model.name} not found.`);
        options.before?.(row);
        plan.check(row);
        return decodeRow(shape, row.row)!;
      },
      options.autoCommit ? SINGLE : {},
    );
  }

  /**
   * Compile scalar `data` of an update into `SET` assignments for variable `n`, with the `@min` /
   * `@max` checks of the values numeric operators produce (see {@link numericGuard}).
   */
  private setClauses(
    ctx: QueryContext,
    scalars: AnyRecord,
  ): { sets: string[]; checks: NumericCheck[] } {
    const sets: string[] = [];
    const checks: NumericCheck[] = [];
    for (const [k, v] of Object.entries(scalars)) {
      const f = scalarField(this.model, k)!;
      const ref = `n.${q(k)}`;
      // A Json value (or a point) is set as a whole, even when it is an object.
      const wholeObject = f.type === "Json" || f.type === "Point" || f.type === "CartesianPoint";
      if (isPlainObject(v) && !f.list && !wholeObject) {
        if (f.type !== "Int" && f.type !== "Float" && f.type !== "BigInt") {
          throw new CyphraValidationError(
            `${this.model.name}.${k}: object updates are only for numbers.`,
          );
        }
        // The value after every operator, in order, for the range checks.
        let result = ref;
        for (const [op, amount] of Object.entries(v)) {
          if (amount === undefined) continue;
          const sym = { increment: "+", decrement: "-", multiply: "*" }[op];
          if (!sym) throw new CyphraValidationError(`Unknown number update "${op}".`);
          const p = ctx.param(encodeScalar(f, amount, this.model.name));
          sets.push(`${ref} = ${ref} ${sym} ${p}`);
          result = `(${result} ${sym} ${p})`;
        }
        for (const r of f.rules ?? []) {
          if (result === ref || (r.rule !== "min" && r.rule !== "max")) continue;
          const limit = f.type === "BigInt" ? BigInt(r.value) : r.value;
          const bound = ctx.param(encodeScalar(f, limit, this.model.name));
          checks.push({ field: f, rule: r.rule, result, bound });
        }
        continue;
      }
      sets.push(`${ref} = ${ctx.param(encodeScalar(f, v, this.model.name))}`);
    }
    return { sets, checks };
  }

  /**
   * `SET` the update on `n` (and `REMOVE` the dynamic labels in `remove`, an item such as
   * `` n:`A` ``) only when the values its numeric operators produce keep within `@min` / `@max`;
   * the clause returns the broken checks as `bad` (see {@link numericGuard}).
   */
  private static guardedSet(
    sets: readonly string[],
    checks: readonly NumericCheck[],
    remove: string | null = null,
  ): string {
    const guard = numericGuard(checks);
    const body = ModelEngine.setAndRemove(sets, remove);
    if (!guard) return body ? ` ${body}` : "";
    return (
      ` WITH n, ${guard} AS bad` +
      ` FOREACH (x IN CASE WHEN size(bad) = 0 THEN [1] ELSE [] END | ${body})`
    );
  }

  /** `SET a, b REMOVE n:L`, either part left out when empty (`""` for nothing). */
  private static setAndRemove(sets: readonly string[], remove: string | null): string {
    const parts: string[] = [];
    if (sets.length) parts.push(`SET ${sets.join(", ")}`);
    if (remove) parts.push(`REMOVE ${remove}`);
    return parts.join(" ");
  }

  /**
   * The scalar `SET`s of an update (with their checks), plus the label changes of its `$labels`:
   * added labels as one more `SET` item, removed ones as a `REMOVE` item.
   */
  private updateClauses(
    ctx: QueryContext,
    scalars: AnyRecord,
    labels: unknown,
    where: string,
  ): { sets: string[]; checks: NumericCheck[]; remove: string | null } {
    const change = updateLabels(this.model, labels, where);
    const { sets, checks } = this.setClauses(ctx, scalars);
    const add = labelItem("n", change.add);
    if (add) sets.push(add);
    return { sets, checks, remove: labelItem("n", change.remove) };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * One statement: the `CREATE`, every nested write (children batched per relation) and the
   * projection of the new node. Sent on its own (auto-commit over HTTP) unless a nested `connect`
   * must be checked after it ran (a missing target rolls the whole create back).
   */
  // `async` so that invalid data rejects the returned promise instead of throwing synchronously.
  async create(args: AnyRecord): Promise<AnyRecord> {
    this.assertNotUnion("create");
    validateWriteArgs(this.schema, this.model, "create", args);
    const plan = this.planCreate(this.ctx(), args.data);
    return this.runPlan(plan, args, { autoCommit: plan.checks.length === 0 });
  }

  /**
   * The projection of a batch operation's `select` (`{ count, nodes }` results), or `null` without
   * one. Batch operations take `select` only: `include` would load every scalar of every node.
   */
  private batchProjection(
    ctx: QueryContext,
    args: AnyRecord,
    op: string,
  ): { expr: string; shape: Shape } | null {
    if (args.include !== undefined) {
      throw new CyphraValidationError(
        `${this.model.name}.${op}: batch operations take select (the fields of the returned nodes), not include.`,
      );
    }
    if (args.select === undefined) return null;
    if (!isPlainObject(args.select)) {
      throw new CyphraValidationError(`${this.model.name}.${op}: select must be an object.`);
    }
    return compileProjection(ctx, this.model, "n", { select: args.select });
  }

  /** `{ count }`, plus `nodes` (decoded with `shape`) when the operation has a `select`. */
  private static batchResult(count: unknown, shape: Shape | undefined, rows: unknown): BatchResult {
    if (!shape) return { count: toCount(count) };
    const nodes = (Array.isArray(rows) ? rows : []).map((r) => decodeRow(shape, r)!);
    return { count: toCount(count), nodes };
  }

  /**
   * One statement creating every node (`UNWIND` per group of dynamic labels). With `select`, the
   * created nodes are projected in the same statement and returned as `nodes`, in `data` order.
   */
  // `async` so that invalid data rejects the returned promise instead of throwing synchronously.
  async createMany(args: AnyRecord): Promise<BatchResult> {
    this.assertNotUnion("createMany");
    assertCreatable(this.model, `${this.model.name}.createMany`);
    if (!Array.isArray(args.data))
      throw new CyphraValidationError("createMany: data must be an array.");
    const data: unknown[] = args.data;
    validateWriteArgs(this.schema, this.model, "createMany", args);
    const fields = this.model.fields.filter((f): f is ResolvedScalarField => f.kind === "scalar");
    // Rows grouped by their dynamic labels (part of the CREATE pattern), in first-seen order, with
    // the index of each row in `data`.
    const groups = new Map<string, { rows: AnyRecord[]; at: number[] }>();
    data.forEach((d, i) => {
      const { scalars, relations, labels } = this.splitData(d, "createMany");
      if (Object.keys(relations).length) {
        throw new CyphraValidationError("createMany does not support nested relation writes.");
      }
      const extra = labelSuffix(
        createLabels(this.model, labels, `${this.model.name}.createMany: data[${i}]`),
      );
      const group = groups.get(extra) ?? { rows: [], at: [] };
      groups.set(extra, group);
      group.rows.push(ModelEngine.createProps(this.model.name, fields, scalars));
      group.at.push(i);
    });
    const ctx = this.ctx();
    const projection = this.batchProjection(ctx, args, "createMany");
    if (groups.size === 0) return ModelEngine.batchResult(0, projection?.shape, []);
    return this.runner.write(async (exec) => {
      if (groups.size === 1 && !projection) {
        const [[extra, { rows }]] = [...groups];
        const res = await exec(
          `UNWIND ${ctx.param(rows)} AS row CREATE (n:${this.label}${extra}) SET n = row RETURN count(n) AS c`,
          ctx.params,
        );
        return { count: toCount(res[0]?.c) };
      }
      // One UNWIND per group, each aggregated before the next (an aggregation keeps one row).
      const counts: string[] = [];
      let text = "";
      for (const [extra, { rows }] of groups) {
        const c = `c${counts.length}`;
        const agg = projection ? `collect(${projection.expr}) AS ${c}` : `count(n) AS ${c}`;
        text +=
          `${text ? " " : ""}UNWIND ${ctx.param(rows)} AS row CREATE (n:${this.label}${extra}) SET n = row ` +
          `WITH ${[...counts, agg].join(", ")}`;
        counts.push(c);
      }
      if (!projection) {
        const res = await exec(`${text} RETURN ${counts.join(" + ")} AS c`, ctx.params);
        return { count: toCount(res[0]?.c) };
      }
      const res = await exec(`${text} RETURN ${counts.join(", ")}`, ctx.params);
      // Back in `data` order: each group's nodes come in its rows' order.
      const nodes: unknown[] = new Array(data.length);
      [...groups.values()].forEach(({ at }, g) => {
        const created = (res[0]?.[counts[g]!] ?? []) as unknown[];
        at.forEach((i, j) => (nodes[i] = created[j]));
      });
      return ModelEngine.batchResult(data.length, projection.shape, nodes);
    }, SINGLE);
  }

  /**
   * One statement: find the node, `SET` the scalars (skipped when a number update would break
   * `@min` / `@max`), run the relation writes and project the result. Sent on its own
   * (auto-commit over HTTP) when there are no relation writes: then a failed check wrote nothing.
   */
  async update(args: AnyRecord): Promise<AnyRecord> {
    this.assertNotUnion("update");
    validateWriteArgs(this.schema, this.model, "update", args);
    const where = this.assertUnique(args.where, "update");
    const { scalars, relations, labels } = this.splitData(args.data, "update");
    const ctx = this.ctx();
    const w = scopedWhere(ctx, this.model, "n", where, "update");
    const { sets, checks, remove } = this.updateClauses(
      ctx,
      scalars,
      labels,
      `${this.model.name}.update: data`,
    );
    const guarded = numericGuard(checks) !== null;
    const plan = new WritePlan(
      ctx,
      `MATCH (n:${this.label})${w ? ` WHERE ${w}` : ""} WITH n LIMIT 1` +
        ModelEngine.guardedSet(sets, checks, remove),
      guarded ? ["n", "bad"] : ["n"],
    );
    this.planRelations(plan, "n", relations, "update", ["data"]);
    return this.runPlan(plan, args, {
      extra: guarded ? ["bad"] : [],
      autoCommit: !plan.relations,
      missing: () =>
        new NotFoundError(`update: no ${this.model.name} matches ${JSON.stringify(args.where)}.`),
      before: (row) => throwGuardIssues("update", this.model, checks, row.bad, ["data"]),
    });
  }

  /**
   * One statement. When numeric operators touch `@min` / `@max` fields, every matched node is
   * checked first and nothing is updated if one of them would break a rule.
   */
  async updateMany(args: AnyRecord): Promise<BatchResult> {
    this.assertNotUnion("updateMany");
    validateWriteArgs(this.schema, this.model, "updateMany", args);
    const { scalars, relations, labels } = this.splitData(args.data, "updateMany");
    if (Object.keys(relations).length) {
      throw new CyphraValidationError("updateMany does not support relation writes.");
    }
    const ctx = this.ctx();
    const w = scopedWhere(ctx, this.model, "n", args.where, "update");
    const { sets, checks, remove } = this.updateClauses(
      ctx,
      scalars,
      labels,
      `${this.model.name}.updateMany: data`,
    );
    const body = ModelEngine.setAndRemove(sets, remove);
    const match = `MATCH (n:${this.label})${w ? ` WHERE ${w}` : ""}`;
    const guard = numericGuard(checks);
    // With `select`, the updated nodes are projected after the update, in the same statement.
    const projection = this.batchProjection(ctx, args, "updateMany");
    const shape = projection?.shape;
    return this.runner.write(async (exec) => {
      if (guard) {
        const head =
          `${match} WITH collect(n) AS ns` +
          ` WITH ns, [b IN [n IN ns | ${guard}] WHERE size(b) > 0] AS bad` +
          ` FOREACH (n IN CASE WHEN size(bad) = 0 THEN ns ELSE [] END | ${body})`;
        // No match: the UNWIND leaves no row (nothing was updated, nothing to report).
        const res = await exec(
          projection
            ? `${head} WITH ns, bad UNWIND ns AS n WITH ns, bad, ${projection.expr} AS row` +
                ` RETURN size(ns) AS c, bad[0] AS bad, collect(row) AS nodes`
            : `${head} RETURN size(ns) AS c, bad[0] AS bad`,
          ctx.params,
        );
        throwGuardIssues("updateMany", this.model, checks, res[0]?.bad, ["data"]);
        return ModelEngine.batchResult(res[0]?.c, shape, res[0]?.nodes);
      }
      const res = await exec(
        `${match}${body ? ` ${body}` : ""}` +
          (projection
            ? ` WITH n, ${projection.expr} AS row RETURN count(n) AS c, collect(row) AS nodes`
            : ` RETURN count(n) AS c`),
        ctx.params,
      );
      return ModelEngine.batchResult(res[0]?.c, shape, res[0]?.nodes);
    }, SINGLE);
  }

  /**
   * Atomic upsert: one `MERGE` on a unique key of `where`, with the create data in
   * `ON CREATE SET` and the update in `ON MATCH SET`. Under concurrency this yields exactly one
   * node only when the key has a uniqueness constraint (`@id` / `@unique` / `@@unique` +
   * `cyphra db push` or a migration); without one, concurrent MERGEs can still create duplicates.
   *
   * Extra `where` filters (beyond the MERGE key) are checked on an existing node before it is
   * updated; if it does not match them, nothing is written and a {@link CyphraError} is thrown
   * (creating would duplicate the key). Nested relation writes run in a second statement of the
   * same transaction (they depend on whether the MERGE created the node), which also projects the
   * result.
   */
  async upsert(args: AnyRecord): Promise<AnyRecord> {
    this.assertNotUnion("upsert");
    assertCreatable(this.model, `${this.model.name}.upsert`);
    const { where, key: keyFields } = this.uniqueWhere(args.where, "upsert");
    validateWriteArgs(this.schema, this.model, "upsert", args);
    const create = this.splitData(args.create, "upsert create");
    const update = this.splitData(args.update, "upsert update");
    const createdLabels = createLabels(
      this.model,
      create.labels,
      `${this.model.name}.upsert: create`,
    );
    for (const key of keyFields) {
      if (create.scalars[key] !== undefined && !sameValue(create.scalars[key], where[key])) {
        throw new CyphraValidationError(
          `${this.model.name}.upsert: create.${key} must equal where.${key} (or be omitted).`,
        );
      }
    }
    // The MERGE pattern sets the key, so no default is generated for it.
    const fields = this.model.fields.filter(
      (f): f is ResolvedScalarField => f.kind === "scalar" && !keyFields.includes(f.name),
    );
    const props = ModelEngine.createProps(this.model.name, fields, create.scalars);
    const nested = Object.keys(create.relations).length + Object.keys(update.relations).length > 0;

    const ctx = this.ctx();
    const keyProps = keyFields
      .map(
        (k) =>
          `${q(k)}: ${ctx.param(encodeScalar(scalarField(this.model, k)!, where[k], this.model.name))}`,
      )
      .join(", ");
    const onCreate = Object.keys(props).length ? [`n += ${ctx.param(props)}`] : [];
    const createdItem = labelItem("n", createdLabels);
    if (createdItem) onCreate.push(createdItem);
    const rest = Object.fromEntries(Object.entries(where).filter(([k]) => !keyFields.includes(k)));
    // The update rules restrict the node an upsert may update, like the rest of `where`.
    const restWhere = scopedWhere(ctx, this.model, "n", rest, "update");
    const { sets, checks, remove } = this.updateClauses(
      ctx,
      update.scalars,
      update.labels,
      `${this.model.name}.upsert: update`,
    );
    const guard = numericGuard(checks);
    const flag = `n.${q(UPSERT_FLAG)}`;
    // `ON MATCH SET` cannot remove labels: removing one takes the FOREACH form below.
    const trackCreated = nested || restWhere !== null || guard !== null || remove !== null;

    let text = `MERGE (n:${this.label} {${keyProps}})`;
    if (trackCreated) onCreate.push(`${flag} = true`);
    if (onCreate.length) text += ` ON CREATE SET ${onCreate.join(", ")}`;
    if (restWhere || guard || remove) {
      // Check the extra filters (and the range of the values numeric operators produce) against
      // the node as it was, then update it.
      text += ` WITH n, ${flag} IS NOT NULL AS created REMOVE ${flag}`;
      if (restWhere) text += ` WITH n, created WHERE created OR (${restWhere})`;
      if (guard) text += ` WITH n, created, CASE WHEN created THEN [] ELSE ${guard} END AS bad`;
      const body = ModelEngine.setAndRemove(sets, remove);
      if (body) {
        const skip = guard ? "created OR size(bad) > 0" : "created";
        text += ` FOREACH (x IN CASE WHEN ${skip} THEN [] ELSE [1] END | ${body})`;
      }
    } else {
      if (sets.length) text += ` ON MATCH SET ${sets.join(", ")}`;
      if (trackCreated) text += ` WITH n, ${flag} IS NOT NULL AS created REMOVE ${flag}`;
    }
    const projection = nested ? null : compileProjection(ctx, this.model, "n", args);
    text += ` RETURN elementId(n) AS id`;
    if (trackCreated) text += `, created`;
    if (guard) text += `, bad`;
    if (projection) text += `, ${projection.expr} AS row`;

    // The nested writes of each branch, compiled once (before anything runs).
    const branch = (mode: "create" | "update") => {
      const c = this.ctx();
      const id = c.param("");
      const plan = new WritePlan(c, `MATCH (n) WHERE elementId(n) = ${id}`, ["n"]);
      const relations = mode === "create" ? create.relations : update.relations;
      this.planRelations(plan, "n", relations, mode, [mode]);
      const { expr, shape } = compileProjection(c, this.model, "n", args);
      return {
        plan,
        shape,
        text: `${plan.text} RETURN ${[`${expr} AS row`, ...plan.outputs].join(", ")}`,
        id: id.slice(1),
      };
    };
    const branches = nested ? { create: branch("create"), update: branch("update") } : null;

    const attempt = () =>
      this.runner.write(
        async (exec) => {
          const rows = await exec(text, ctx.params);
          const row = rows[0];
          if (!row) {
            throw new CyphraError(
              `${this.model.name}.upsert: a node with ${keyFields.map((k) => `${k} = ${JSON.stringify(where[k])}`).join(", ")} exists but does not match the rest of where; creating another would duplicate the key.`,
            );
          }
          throwGuardIssues("upsert", this.model, checks, row.bad, ["update"]);
          if (projection) return decodeRow(projection.shape, row.row)!;
          const b = row.created ? branches!.create : branches!.update;
          const [res] = await exec(b.text, { ...b.plan.ctx.params, [b.id]: row.id });
          if (!res) throw new NotFoundError(`${this.model.name} disappeared during the operation.`);
          b.plan.check(res);
          return decodeRow(b.shape, res.row)!;
        },
        nested ? {} : SINGLE,
      );
    if (this.options.dialect !== "memgraph") return attempt();
    // Memgraph checks uniqueness at commit and its MERGE takes no lock: of two concurrent upserts
    // creating one key, the second fails to commit. Run it again: its MERGE now finds the node.
    // (Inside `$transaction` the commit happens later, outside this call: not retried.)
    for (let retries = 0; ; retries++) {
      try {
        return await attempt();
      } catch (e) {
        const onKey =
          e instanceof UniqueConstraintError &&
          e.model === this.model.name &&
          keyFields.every((k) => e.fields.includes(k));
        if (!onKey || retries >= MEMGRAPH_UPSERT_RETRIES) throw e;
      }
    }
  }

  /**
   * Delete one node and return it as it was. Without `onDelete` rules: one statement (find,
   * project, `DETACH DELETE`). With rules (on the model or on models its cascades reach), the node
   * is locked, cascades are collected and `Restrict` rules checked before anything is deleted, all
   * in this transaction (see `onDelete.ts`): one statement too when the cascades form a tree.
   */
  // `async` so that an invalid `where` rejects the returned promise instead of throwing.
  async delete(args: AnyRecord): Promise<AnyRecord> {
    this.assertNotUnion("delete");
    const where = this.assertUnique(args.where, "delete");
    const ctx = this.ctx();
    const w = scopedWhere(ctx, this.model, "n", where, "delete");
    const match = `MATCH (n:${this.label})${w ? ` WHERE ${w}` : ""}`;
    const { expr, shape } = compileProjection(ctx, this.model, "n", args);
    const missing = () =>
      new NotFoundError(`delete: no ${this.model.name} matches ${JSON.stringify(args.where)}.`);
    const single = async (text: string, check?: (row: AnyRecord) => void) =>
      this.runner.write(async (exec) => {
        const [row] = await exec(text, ctx.params);
        if (!row) throw missing();
        check?.(row);
        return decodeRow(shape, row.row)!;
      }, SINGLE);

    // Lock first, so that the row returned is the one deleted (and the rules see every edge); a
    // node deleted by a concurrent operation meanwhile is not found.
    if (!hasDeleteRules(this.schema, this.model)) {
      return single(
        `${match} WITH n LIMIT 1 ${lockAndRematch(ctx, "n")} WITH n, ${expr} AS row ` +
          `DETACH DELETE n RETURN row`,
      );
    }
    const compiled = compileRulesDelete(ctx, this.model, match, true, expr);
    if (compiled) {
      return single(compiled.text, (row) => {
        throwRestrict(compiled.restricts, row);
        if (toCount(row.c) === 0) throw missing();
      });
    }
    const text =
      `${match} WITH n LIMIT 1 ${lockAndRematch(ctx, "n")} ` +
      `RETURN elementId(n) AS id, labels(n) AS labels, ${expr} AS row`;
    return this.runner.write(async (exec) => {
      const [row] = await exec(text, ctx.params);
      if (!row) throw missing();
      const node = { id: row.id as string, labels: (row.labels ?? []) as unknown[] };
      if ((await deleteWithRules(exec, this.schema, this.model, [node])) === 0) throw missing();
      return decodeRow(shape, row.row)!;
    });
  }

  /**
   * Delete every matching node (and what its `onDelete` rules cascade to). With `select`, the
   * deleted nodes are returned as `nodes`, projected as they were before the delete, in the same
   * statement (or, when cascades take several statements, in the first one, which locks them).
   */
  // `async` so that an invalid `where` rejects the returned promise instead of throwing.
  /**
   * `deleteMany` with `$relationships: true` (internal, for `@cyphra/graphql`'s `compat.v7`): also
   * returns `relationships`, the number of distinct relationships the delete removed (the v7
   * `relationshipsDeleted` counter). Only on Neo4j, and only for models without `onDelete` rules.
   */
  private async deleteCountingRelationships(
    ctx: QueryContext,
    match: string,
    flag: unknown,
    projection: { expr: string; shape: Shape } | null,
  ): Promise<BatchResult & { relationships: number }> {
    if (flag !== true) {
      throw new CyphraValidationError(`${this.model.name}.deleteMany: $relationships takes true.`);
    }
    if ((this.options.dialect ?? "neo4j") !== "neo4j" || hasDeleteRules(this.schema, this.model)) {
      throw new CyphraValidationError(
        `${this.model.name}.deleteMany: $relationships needs Neo4j and a model without onDelete rules.`,
      );
    }
    const row = projection ? `, collect(${projection.expr}) AS nodes` : "";
    const text =
      `${match} WITH collect(n) AS ns${row}` +
      ` WITH ns${projection ? ", nodes" : ""}, COUNT { UNWIND ns AS x MATCH (x)-[e]-() RETURN DISTINCT e } AS rels` +
      ` FOREACH (x IN ns | DETACH DELETE x) RETURN size(ns) AS c, rels${projection ? ", nodes" : ""}`;
    return this.runner.write(async (exec) => {
      const [res] = await exec(text, ctx.params);
      return {
        ...ModelEngine.batchResult(res?.c, projection?.shape, res?.nodes),
        relationships: toCount(res?.rels),
      };
    }, SINGLE);
  }

  async deleteMany(args: AnyRecord = {}): Promise<BatchResult> {
    this.assertNotUnion("deleteMany");
    const ctx = this.ctx();
    const w = scopedWhere(ctx, this.model, "n", args.where, "delete");
    const match = `MATCH (n:${this.label})${w ? ` WHERE ${w}` : ""}`;
    const projection = this.batchProjection(ctx, args, "deleteMany");
    const shape = projection?.shape;
    if (args.$relationships !== undefined) {
      return this.deleteCountingRelationships(ctx, match, args.$relationships, projection);
    }
    if (!hasDeleteRules(this.schema, this.model)) {
      return this.runner.write(async (exec) => {
        const res = await exec(
          projection
            ? `${match} WITH n, ${projection.expr} AS row DETACH DELETE n RETURN count(*) AS c, collect(row) AS nodes`
            : `${match} DETACH DELETE n RETURN count(*) AS c`,
          ctx.params,
        );
        return ModelEngine.batchResult(res[0]?.c, shape, res[0]?.nodes);
      }, SINGLE);
    }
    const compiled = compileRulesDelete(ctx, this.model, match, false, projection?.expr);
    if (compiled) {
      return this.runner.write(async (exec) => {
        const [row] = await exec(compiled.text, ctx.params);
        throwRestrict(compiled.restricts, row ?? {});
        return ModelEngine.batchResult(row?.c, shape, row?.row);
      }, SINGLE);
    }
    return this.runner.write(async (exec) => {
      const rows = await exec(
        `${match} ${lockAndRematch(ctx, "n")} RETURN elementId(n) AS id, labels(n) AS labels` +
          (projection ? `, ${projection.expr} AS row` : ""),
        ctx.params,
      );
      const roots = rows.map((r) => ({
        id: r.id as string,
        labels: (r.labels ?? []) as unknown[],
      }));
      const count = await deleteWithRules(exec, this.schema, this.model, roots);
      return ModelEngine.batchResult(
        count,
        shape,
        rows.map((r) => r.row),
      );
    });
  }
}
