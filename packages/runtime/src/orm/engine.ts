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
  compileWhere,
  decodeRow,
  labelExpr,
  q,
  relationField,
  relationPattern,
  scalarField,
} from "./compile.js";
import { compileAggregate, compileGroupBy } from "./aggregate.js";
import { DEFAULT_MAX_TRAVERSAL_DEPTH, compileTraverse } from "./traverse.js";
import { compileShortestPath } from "./shortest.js";
import { findSimilar } from "./vector.js";
import { search } from "./fulltext.js";
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

type AnyRecord = Record<string, unknown>;

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
};

export class ModelEngine {
  constructor(
    private readonly schema: SchemaModel,
    private readonly model: ResolvedNodeModel,
    private readonly runner: Runner,
    private readonly options: EngineOptions = {},
  ) {}

  private ctx(): QueryContext {
    return new QueryContext(this.schema, this.options.dialect);
  }

  private get label(): string {
    return labelExpr(this.model);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  private async readMany(exec: Executor, args: AnyRecord): Promise<AnyRecord[]> {
    const ctx = this.ctx();
    const where = compileWhere(ctx, this.model, "n", args.where);
    const paging = compilePaging(ctx, this.model, "n", args);
    const { expr, shape } = compileProjection(ctx, this.model, "n", args);
    let text = `MATCH (n:${this.label})`;
    if (where) text += ` WHERE ${where}`;
    if (paging) text += ` WITH n${paging}`;
    text += ` RETURN ${expr} AS row`;
    // Re-apply the order on the projected rows (WITH … ORDER BY only orders that clause).
    const order = compileOrderBy(ctx, this.model, "n", args.orderBy);
    if (order) text += ` ORDER BY ${order}`;
    const rows = await exec(text, ctx.params);
    return rows.map((r) => decodeRow(shape, r.row)!);
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

  findMany(args: AnyRecord = {}): Promise<AnyRecord[]> {
    return this.runner.read((exec) => this.readMany(exec, args), SINGLE);
  }

  async findFirst(args: AnyRecord = {}): Promise<AnyRecord | null> {
    const rows = await this.findMany({ ...args, take: 1 });
    return rows[0] ?? null;
  }

  async findUnique(args: AnyRecord): Promise<AnyRecord | null> {
    const where = this.assertUnique(args.where, "findUnique");
    const rows = await this.findMany({
      ...args,
      where,
      take: 1,
      skip: undefined,
      orderBy: undefined,
    });
    return rows[0] ?? null;
  }

  async findUniqueOrThrow(args: AnyRecord): Promise<AnyRecord> {
    const row = await this.findUnique(args);
    if (!row)
      throw new NotFoundError(`No ${this.model.name} matches ${JSON.stringify(args.where)}.`);
    return row;
  }

  count(args: AnyRecord = {}): Promise<number> {
    return this.runner.read(async (exec) => {
      const ctx = this.ctx();
      const w = compileWhere(ctx, this.model, "n", args.where);
      const rows = await exec(
        `MATCH (n:${this.label})${w ? ` WHERE ${w}` : ""} RETURN count(n) AS c`,
        ctx.params,
      );
      return toCount(rows[0]?.c);
    }, SINGLE);
  }

  /** One statement; see {@link compileAggregate}. */
  aggregate(args: AnyRecord = {}): Promise<AnyRecord> {
    return this.runner.read(async (exec) => {
      if (!isPlainObject(args))
        throw new CyphraValidationError("aggregate args must be an object.");
      const c = compileAggregate(this.ctx(), this.model, args);
      return c.decode(await exec(c.text, c.params));
    }, SINGLE);
  }

  /** One statement; see {@link compileGroupBy}. */
  groupBy(args: AnyRecord): Promise<AnyRecord[]> {
    return this.runner.read(async (exec) => {
      if (!isPlainObject(args)) throw new CyphraValidationError("groupBy args must be an object.");
      const c = compileGroupBy(this.ctx(), this.model, args);
      return c.decode(await exec(c.text, c.params));
    }, SINGLE);
  }

  /** One statement; see {@link compileTraverse}. */
  traverse(args: AnyRecord): Promise<unknown[]> {
    return this.runner.read(async (exec) => {
      if (!isPlainObject(args)) throw new CyphraValidationError("traverse args must be an object.");
      const max = this.options.maxTraversalDepth ?? DEFAULT_MAX_TRAVERSAL_DEPTH;
      const c = compileTraverse(this.ctx(), this.model, args, max);
      return c.decode(await exec(c.text, c.params));
    }, SINGLE);
  }

  /** One statement; see {@link compileShortestPath}. */
  async shortestPath(args: AnyRecord): Promise<unknown> {
    return (await this.shortest(args, false))[0] ?? null;
  }

  /** One statement; see {@link compileShortestPath}. */
  allShortestPaths(args: AnyRecord): Promise<unknown[]> {
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

  private splitData(data: unknown, op: string): { scalars: AnyRecord; relations: AnyRecord } {
    if (!isPlainObject(data))
      throw new CyphraValidationError(`${this.model.name}.${op}: data must be an object.`);
    const scalars: AnyRecord = {};
    const relations: AnyRecord = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      const f = this.model.fields.find((x) => x.name === k);
      if (!f)
        throw new CyphraValidationError(`Unknown field "${this.model.name}.${k}" in ${op} data.`);
      (f.kind === "scalar" ? scalars : relations)[k] = v;
    }
    return { scalars, relations };
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
  private toOneInverse(rel: ResolvedRelationField): ResolvedRelationField | undefined {
    const self = [this.model.name, ...(this.model.interfaces ?? [])];
    return this.node(rel.target).fields.find(
      (f): f is ResolvedRelationField =>
        f.kind === "relation" &&
        !f.many &&
        f.relType === rel.relType &&
        f.direction !== rel.direction &&
        self.includes(f.target),
    );
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
  private createData(data: unknown, op: string): { props: AnyRecord; relations: AnyRecord } {
    assertCreatable(this.model, `${this.model.name}.${op}`);
    const { scalars, relations } = this.splitData(data, op);
    const fields = this.model.fields.filter((f): f is ResolvedScalarField => f.kind === "scalar");
    return { props: ModelEngine.createProps(this.model.name, fields, scalars), relations };
  }

  /** One statement creating a node (`n`) with every nested relation write of `data`. */
  private planCreate(ctx: QueryContext, data: unknown): WritePlan {
    const { props, relations } = this.createData(data, "create");
    const plan = new WritePlan(ctx, `CREATE (n:${this.label} ${ctx.param(props)})`, ["n"]);
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
    const { $edge, ...unique } = item;
    const target = this.node(rel.target);
    const where = this.engineFor(target).assertUnique(
      unique,
      `${this.model.name}.${rel.name}.connect`,
    );
    const ctx = plan.ctx;
    const [a, b, r] = [own, ctx.variable("b"), ctx.variable("r")];
    const updates = this.edgeUpdates(ctx, rel, $edge, `${this.model.name}.${rel.name}.$edge`, r);
    const onCreate = this.edgeProps(
      rel,
      isPlainObject(updates.plain) ? { ...updates.plain, ...updates.base } : updates.plain,
    );
    const onMatch = this.explicitEdgeProps(rel, updates.plain);
    const w = compileWhere(ctx, target, b, where);
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
      replace(a, `${relationPattern(ctx, a, rel, other, old)} WHERE ${other} <> ${b}`, old);
    } else if (this.options.dialect === "memgraph") {
      // Memgraph's MERGE takes no lock: concurrent connects of one pair would each create an
      // edge. A write to `a` makes them conflict instead (a transient error, retried by the
      // driver), and the retry's MERGE finds the committed edge.
      const lock = `${a}.${q(LOCK_FLAG)}`;
      text += `SET ${lock} = true REMOVE ${lock} WITH ${a}, ${b} `;
    }
    const inverse = this.toOneInverse(rel);
    if (inverse) {
      const [other, old] = [ctx.variable("x"), ctx.variable("o")];
      const from = `${other}:${labelExpr(this.node(inverse.target))}`;
      replace(b, `${ModelEngine.edgePattern(rel, from, b, old)} WHERE ${other} <> ${a}`, old);
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
    const target = this.node(rel.target);
    const child = this.engineFor(target);
    let batch: { p: AnyRecord; e: AnyRecord }[] = [];
    const flush = () => {
      if (!batch.length) return;
      const [x, c, r] = [ctx.variable("x"), ctx.variable("c"), ctx.variable("r")];
      const typed = batch.some((row) => Object.keys(row.e).length > 0);
      const edge = ModelEngine.edgePattern(rel, own, c, typed ? r : "");
      plan.add(
        `FOREACH (${x} IN ${ctx.param(batch)} | CREATE (${c}:${labelExpr(target)}) SET ${c} = ${x}.p ` +
          `CREATE ${edge}${typed ? ` SET ${r} = ${x}.e` : ""})`,
      );
      batch = [];
    };
    for (const { item, path } of items) {
      if (!isPlainObject(item))
        throw new CyphraValidationError(`${rel.name}.create expects objects.`);
      const { $edge, ...data } = item;
      if (this.edgeUpdates(ctx, rel, $edge, "").sets.length) {
        throw new CyphraValidationError(
          `${this.model.name}.${rel.name}.create: $edge number updates ({ increment, … }) are for connect and set; create makes a new edge, so give the value itself.`,
        );
      }
      const edge = this.edgeProps(rel, $edge);
      const { props, relations } = child.createData(data, "create");
      plan.relations = true;
      if (Object.keys(relations).length === 0) {
        batch.push({ p: props, e: edge });
        continue;
      }
      flush();
      const c = ctx.variable("c");
      const e = Object.keys(edge).length ? ctx.param(edge) : "";
      plan.add(
        `CREATE (${c}:${labelExpr(target)} ${ctx.param(props)}) ` +
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
    const w = where ? compileWhere(ctx, target, b, where) : null;
    plan.call(
      [own],
      `MATCH ${relationPattern(ctx, own, rel, b, r)}${w ? ` WHERE ${w}` : ""} DELETE ${r} RETURN count(*) AS ${d}`,
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

    const engine = this.engineFor(this.node(rel.target));
    if (rel.many) {
      if (disconnect !== undefined) {
        const keys = asArray(disconnect).map((item) => {
          if (!isPlainObject(item))
            throw new CyphraValidationError(`${rel.name}.disconnect expects unique where objects.`);
          return engine.assertUnique(item, `${this.model.name}.${rel.name}.disconnect`);
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
          return engine.assertUnique(unique, `${this.model.name}.${rel.name}.set`);
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
   * `SET` the update on `n` only when the values its numeric operators produce keep within
   * `@min` / `@max`; the clause returns the broken checks as `bad` (see {@link numericGuard}).
   */
  private static guardedSet(sets: readonly string[], checks: readonly NumericCheck[]): string {
    const guard = numericGuard(checks);
    if (!guard) return sets.length ? ` SET ${sets.join(", ")}` : "";
    return (
      ` WITH n, ${guard} AS bad` +
      ` FOREACH (x IN CASE WHEN size(bad) = 0 THEN [1] ELSE [] END | SET ${sets.join(", ")})`
    );
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
    validateWriteArgs(this.schema, this.model, "create", args);
    const plan = this.planCreate(this.ctx(), args.data);
    return this.runPlan(plan, args, { autoCommit: plan.checks.length === 0 });
  }

  // `async` so that invalid data rejects the returned promise instead of throwing synchronously.
  async createMany(args: AnyRecord): Promise<{ count: number }> {
    assertCreatable(this.model, `${this.model.name}.createMany`);
    if (!Array.isArray(args.data))
      throw new CyphraValidationError("createMany: data must be an array.");
    validateWriteArgs(this.schema, this.model, "createMany", args);
    const fields = this.model.fields.filter((f): f is ResolvedScalarField => f.kind === "scalar");
    const rows = args.data.map((d: unknown) => {
      const { scalars, relations } = this.splitData(d, "createMany");
      if (Object.keys(relations).length) {
        throw new CyphraValidationError("createMany does not support nested relation writes.");
      }
      return ModelEngine.createProps(this.model.name, fields, scalars);
    });
    if (rows.length === 0) return { count: 0 };
    return this.runner.write(async (exec) => {
      const ctx = this.ctx();
      const res = await exec(
        `UNWIND ${ctx.param(rows)} AS row CREATE (n:${this.label}) SET n = row RETURN count(n) AS c`,
        ctx.params,
      );
      return { count: toCount(res[0]?.c) };
    }, SINGLE);
  }

  /**
   * One statement: find the node, `SET` the scalars (skipped when a number update would break
   * `@min` / `@max`), run the relation writes and project the result. Sent on its own
   * (auto-commit over HTTP) when there are no relation writes: then a failed check wrote nothing.
   */
  async update(args: AnyRecord): Promise<AnyRecord> {
    validateWriteArgs(this.schema, this.model, "update", args);
    const where = this.assertUnique(args.where, "update");
    const { scalars, relations } = this.splitData(args.data, "update");
    const ctx = this.ctx();
    const w = compileWhere(ctx, this.model, "n", where);
    const { sets, checks } = this.setClauses(ctx, scalars);
    const guarded = numericGuard(checks) !== null;
    const plan = new WritePlan(
      ctx,
      `MATCH (n:${this.label})${w ? ` WHERE ${w}` : ""} WITH n LIMIT 1` +
        ModelEngine.guardedSet(sets, checks),
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
  async updateMany(args: AnyRecord): Promise<{ count: number }> {
    validateWriteArgs(this.schema, this.model, "updateMany", args);
    const { scalars, relations } = this.splitData(args.data, "updateMany");
    if (Object.keys(relations).length) {
      throw new CyphraValidationError("updateMany does not support relation writes.");
    }
    const ctx = this.ctx();
    const w = compileWhere(ctx, this.model, "n", args.where);
    const { sets, checks } = this.setClauses(ctx, scalars);
    const match = `MATCH (n:${this.label})${w ? ` WHERE ${w}` : ""}`;
    const guard = numericGuard(checks);
    return this.runner.write(async (exec) => {
      if (guard) {
        const res = await exec(
          `${match} WITH collect(n) AS ns` +
            ` WITH ns, [b IN [n IN ns | ${guard}] WHERE size(b) > 0] AS bad` +
            ` FOREACH (n IN CASE WHEN size(bad) = 0 THEN ns ELSE [] END | SET ${sets.join(", ")})` +
            ` RETURN size(ns) AS c, bad[0] AS bad`,
          ctx.params,
        );
        throwGuardIssues("updateMany", this.model, checks, res[0]?.bad, ["data"]);
        return { count: toCount(res[0]?.c) };
      }
      const res = await exec(
        `${match}${sets.length ? ` SET ${sets.join(", ")}` : ""} RETURN count(n) AS c`,
        ctx.params,
      );
      return { count: toCount(res[0]?.c) };
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
    assertCreatable(this.model, `${this.model.name}.upsert`);
    const { where, key: keyFields } = this.uniqueWhere(args.where, "upsert");
    validateWriteArgs(this.schema, this.model, "upsert", args);
    const create = this.splitData(args.create, "upsert create");
    const update = this.splitData(args.update, "upsert update");
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
    const rest = Object.fromEntries(Object.entries(where).filter(([k]) => !keyFields.includes(k)));
    const restWhere = compileWhere(ctx, this.model, "n", rest);
    const { sets, checks } = this.setClauses(ctx, update.scalars);
    const guard = numericGuard(checks);
    const flag = `n.${q(UPSERT_FLAG)}`;
    const trackCreated = nested || restWhere !== null || guard !== null;

    let text = `MERGE (n:${this.label} {${keyProps}})`;
    if (trackCreated) onCreate.push(`${flag} = true`);
    if (onCreate.length) text += ` ON CREATE SET ${onCreate.join(", ")}`;
    if (restWhere || guard) {
      // Check the extra filters (and the range of the values numeric operators produce) against
      // the node as it was, then update it.
      text += ` WITH n, ${flag} IS NOT NULL AS created REMOVE ${flag}`;
      if (restWhere) text += ` WITH n, created WHERE created OR (${restWhere})`;
      if (guard) text += ` WITH n, created, CASE WHEN created THEN [] ELSE ${guard} END AS bad`;
      if (sets.length) {
        const skip = guard ? "created OR size(bad) > 0" : "created";
        text += ` FOREACH (x IN CASE WHEN ${skip} THEN [] ELSE [1] END | SET ${sets.join(", ")})`;
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
    const where = this.assertUnique(args.where, "delete");
    const ctx = this.ctx();
    const w = compileWhere(ctx, this.model, "n", where);
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

  // `async` so that an invalid `where` rejects the returned promise instead of throwing.
  async deleteMany(args: AnyRecord = {}): Promise<{ count: number }> {
    const ctx = this.ctx();
    const w = compileWhere(ctx, this.model, "n", args.where);
    const match = `MATCH (n:${this.label})${w ? ` WHERE ${w}` : ""}`;
    if (!hasDeleteRules(this.schema, this.model)) {
      return this.runner.write(async (exec) => {
        const res = await exec(`${match} DETACH DELETE n RETURN count(*) AS c`, ctx.params);
        return { count: toCount(res[0]?.c) };
      }, SINGLE);
    }
    const compiled = compileRulesDelete(ctx, this.model, match, false);
    if (compiled) {
      return this.runner.write(async (exec) => {
        const [row] = await exec(compiled.text, ctx.params);
        throwRestrict(compiled.restricts, row ?? {});
        return { count: toCount(row?.c) };
      }, SINGLE);
    }
    return this.runner.write(async (exec) => {
      const rows = await exec(
        `${match} ${lockAndRematch(ctx, "n")} RETURN elementId(n) AS id, labels(n) AS labels`,
        ctx.params,
      );
      const roots = rows.map((r) => ({
        id: r.id as string,
        labels: (r.labels ?? []) as unknown[],
      }));
      return { count: await deleteWithRules(exec, this.schema, this.model, roots) };
    });
  }
}
