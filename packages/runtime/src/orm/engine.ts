/**
 * Executes ORM operations for one node model against a {@link Runner}.
 *
 * Reads are single statements. Writes with nested relation operations run as a sequence of
 * statements inside one write transaction, so a failing step (e.g. a missing `connect` target)
 * rolls the whole operation back.
 *
 * @packageDocumentation
 */

import { isInt } from "../cypher-values.js";
import type {
  ResolvedNodeModel,
  ResolvedRelationField,
  ResolvedScalarField,
  SchemaModel,
} from "@cyphra/schema";
import {
  QueryContext,
  compileOrderBy,
  compilePaging,
  compileProjection,
  compileWhere,
  decodeRow,
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
import { deleteWithRules, hasDeleteRules, lockNodes } from "./onDelete.js";
import { CyphraError, CyphraValidationError, NotFoundError } from "./errors.js";
import { defaultLiteralValue, encodeScalar, integerToNumber, nowValue } from "./values.js";

type AnyRecord = Record<string, unknown>;

/** Runs one Cypher statement and returns raw driver records as objects. */
export type Executor = (text: string, params: AnyRecord) => Promise<AnyRecord[]>;

/** Provides executors inside read or write transactions. */
export type Runner = {
  read<T>(fn: (exec: Executor) => Promise<T>): Promise<T>;
  write<T>(fn: (exec: Executor) => Promise<T>): Promise<T>;
};

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

/** Property set and removed at once to take a write lock on a node. */
const LOCK_FLAG = "__cyphraLock";

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === "bigint" || typeof b === "bigint") return String(a) === String(b);
  return a === b;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

/** Client-level options that change how operations compile. */
export type EngineOptions = {
  /** Upper bound for `traverse` `depth.max` (default 10). */
  readonly maxTraversalDepth?: number;
};

export class ModelEngine {
  constructor(
    private readonly schema: SchemaModel,
    private readonly model: ResolvedNodeModel,
    private readonly runner: Runner,
    private readonly options: EngineOptions = {},
  ) {}

  private ctx(): QueryContext {
    return new QueryContext(this.schema);
  }

  private get label(): string {
    return q(this.model.label);
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

  private async readById(exec: Executor, id: string, args: AnyRecord): Promise<AnyRecord> {
    const ctx = this.ctx();
    const { expr, shape } = compileProjection(ctx, this.model, "n", args);
    const rows = await exec(
      `MATCH (n:${this.label}) WHERE elementId(n) = ${ctx.param(id)} RETURN ${expr} AS row`,
      ctx.params,
    );
    if (!rows[0]) throw new NotFoundError(`${this.model.name} disappeared during the operation.`);
    return decodeRow(shape, rows[0].row)!;
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

  private async findId(exec: Executor, unique: unknown, op: string): Promise<string | null> {
    const where = this.assertUnique(unique, op);
    const ctx = this.ctx();
    const w = compileWhere(ctx, this.model, "n", where);
    const rows = await exec(
      `MATCH (n:${this.label})${w ? ` WHERE ${w}` : ""} RETURN elementId(n) AS id LIMIT 1`,
      ctx.params,
    );
    return (rows[0]?.id as string | undefined) ?? null;
  }

  findMany(args: AnyRecord = {}): Promise<AnyRecord[]> {
    return this.runner.read((exec) => this.readMany(exec, args));
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
    });
  }

  /** One statement; see {@link compileAggregate}. */
  aggregate(args: AnyRecord = {}): Promise<AnyRecord> {
    return this.runner.read(async (exec) => {
      if (!isPlainObject(args))
        throw new CyphraValidationError("aggregate args must be an object.");
      const c = compileAggregate(this.ctx(), this.model, args);
      return c.decode(await exec(c.text, c.params));
    });
  }

  /** One statement; see {@link compileGroupBy}. */
  groupBy(args: AnyRecord): Promise<AnyRecord[]> {
    return this.runner.read(async (exec) => {
      if (!isPlainObject(args)) throw new CyphraValidationError("groupBy args must be an object.");
      const c = compileGroupBy(this.ctx(), this.model, args);
      return c.decode(await exec(c.text, c.params));
    });
  }

  /** One statement; see {@link compileTraverse}. */
  traverse(args: AnyRecord): Promise<unknown[]> {
    return this.runner.read(async (exec) => {
      if (!isPlainObject(args)) throw new CyphraValidationError("traverse args must be an object.");
      const max = this.options.maxTraversalDepth ?? DEFAULT_MAX_TRAVERSAL_DEPTH;
      const c = compileTraverse(this.ctx(), this.model, args, max);
      return c.decode(await exec(c.text, c.params));
    });
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
    });
  }

  /** Nearest neighbours on a `@vectorIndex` field; see {@link findSimilar}. */
  findSimilar(args: AnyRecord): Promise<AnyRecord[]> {
    return this.runner.read(async (exec) => {
      if (!isPlainObject(args))
        throw new CyphraValidationError("findSimilar args must be an object.");
      return findSimilar(exec, () => this.ctx(), this.model, args);
    });
  }

  /** Full-text search through a `@@fulltext` index; see {@link search}. */
  search(args: AnyRecord): Promise<AnyRecord[]> {
    return this.runner.read(async (exec) => {
      if (!isPlainObject(args)) throw new CyphraValidationError("search args must be an object.");
      return search(exec, () => this.ctx(), this.model, args);
    });
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
   * Whether the target model declares the other side of `rel` (same type, opposite direction,
   * pointing back at this model) as a to-one relation, e.g. `Post.author` for `User.posts`.
   */
  private inverseIsToOne(rel: ResolvedRelationField): boolean {
    return this.node(rel.target).fields.some(
      (f) =>
        f.kind === "relation" &&
        !f.many &&
        f.relType === rel.relType &&
        f.direction !== rel.direction &&
        f.target === this.model.name,
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

  private edgeText(
    ctx: QueryContext,
    rel: ResolvedRelationField,
    a: string,
    b: string,
    props: AnyRecord,
  ): string {
    const p = Object.keys(props).length ? ` ${ctx.param(props)}` : "";
    const edge = `[r:${q(rel.relType)}${p}]`;
    return rel.direction === "OUT" ? `(${a})-${edge}->(${b})` : `(${a})<-${edge}-(${b})`;
  }

  /** CREATE a node with nested relation writes; returns its elementId. */
  async createNode(exec: Executor, data: unknown): Promise<string> {
    const { scalars, relations } = this.splitData(data, "create");
    const fields = this.model.fields.filter((f): f is ResolvedScalarField => f.kind === "scalar");
    const props = ModelEngine.createProps(this.model.name, fields, scalars);
    const ctx = this.ctx();
    const rows = await exec(
      `CREATE (n:${this.label} ${ctx.param(props)}) RETURN elementId(n) AS id`,
      ctx.params,
    );
    const id = rows[0]!.id as string;
    for (const [k, v] of Object.entries(relations)) {
      await this.writeRelation(exec, id, relationField(this.model, k)!, v, "create");
    }
    return id;
  }

  /**
   * Link `id` to one existing node. Idempotent: the edge is `MERGE`d, so connecting the same pair
   * again keeps a single edge. On a typed edge, a new edge gets the given `$edge` properties plus
   * schema defaults; an existing edge is updated with the given `$edge` properties only (its
   * defaults, e.g. `@default(now())`, are kept).
   */
  private async connect(
    exec: Executor,
    id: string,
    rel: ResolvedRelationField,
    item: unknown,
  ): Promise<void> {
    if (!isPlainObject(item))
      throw new CyphraValidationError(`${rel.name}.connect expects unique where objects.`);
    const { $edge, ...unique } = item;
    const target = this.node(rel.target);
    const where = this.engineFor(target).assertUnique(
      unique,
      `${this.model.name}.${rel.name}.connect`,
    );
    const onCreate = this.edgeProps(rel, $edge);
    const onMatch = this.explicitEdgeProps(rel, $edge);
    const ctx = this.ctx();
    const w = compileWhere(ctx, target, "b", where);
    const link = (from: string, r: string) => {
      const e = `[${r}:${q(rel.relType)}]`;
      return rel.direction === "OUT" ? `(${from})-${e}->(b)` : `(${from})<-${e}-(b)`;
    };
    let text =
      `MATCH (a) WHERE elementId(a) = ${ctx.param(id)} ` +
      `MATCH (b:${q(target.label)})${w ? ` WHERE ${w}` : ""} WITH a, b LIMIT 1 `;
    // A to-one side can hold only one such edge: lock that node (so concurrent connects
    // serialize), then drop its edge to any other node before linking `a` and `b`.
    const replace = (node: "a" | "b", old: string) => {
      const lock = `${node}.${q(LOCK_FLAG)}`;
      text +=
        `SET ${lock} = true REMOVE ${lock} WITH a, b ` +
        `OPTIONAL MATCH ${old} DELETE old WITH DISTINCT a, b `;
    };
    if (!rel.many) {
      replace("a", `${relationPattern(ctx, "a", rel, "other", "old")} WHERE other <> b`);
    }
    if (this.inverseIsToOne(rel)) {
      replace("b", `${link(`other:${this.label}`, "old")} WHERE other <> a`);
    }
    text += `MERGE ${link("a", "r")}`;
    if (Object.keys(onCreate).length) text += ` ON CREATE SET r += ${ctx.param(onCreate)}`;
    if (Object.keys(onMatch).length) text += ` ON MATCH SET r += ${ctx.param(onMatch)}`;
    const rows = await exec(`${text} RETURN count(r) AS c`, ctx.params);
    if (toCount(rows[0]?.c) === 0) {
      throw new NotFoundError(`connect: no ${target.name} matches ${JSON.stringify(where)}.`);
    }
  }

  private async createRelated(
    exec: Executor,
    id: string,
    rel: ResolvedRelationField,
    item: unknown,
  ): Promise<void> {
    if (!isPlainObject(item))
      throw new CyphraValidationError(`${rel.name}.create expects objects.`);
    const { $edge, ...data } = item;
    const props = this.edgeProps(rel, $edge);
    const childId = await this.engineFor(this.node(rel.target)).createNode(exec, data);
    const ctx = this.ctx();
    await exec(
      `MATCH (a), (b) WHERE elementId(a) = ${ctx.param(id)} AND elementId(b) = ${ctx.param(childId)} ` +
        `CREATE ${this.edgeText(ctx, rel, "a", "b", props)}`,
      ctx.params,
    );
  }

  private async deleteEdges(
    exec: Executor,
    id: string,
    rel: ResolvedRelationField,
    where?: AnyRecord,
  ): Promise<number> {
    const target = this.node(rel.target);
    const ctx = this.ctx();
    const w = where ? compileWhere(ctx, target, "b", where) : null;
    const rows = await exec(
      `MATCH ${relationPattern(ctx, "a", rel, "b", "r")} WHERE elementId(a) = ${ctx.param(id)}` +
        `${w ? ` AND ${w}` : ""} DELETE r RETURN count(*) AS c`,
      ctx.params,
    );
    return toCount(rows[0]?.c);
  }

  private async writeRelation(
    exec: Executor,
    id: string,
    rel: ResolvedRelationField,
    spec: unknown,
    mode: "create" | "update",
  ): Promise<void> {
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
        for (const item of asArray(disconnect)) {
          if (!isPlainObject(item))
            throw new CyphraValidationError(`${rel.name}.disconnect expects unique where objects.`);
          const where = this.engineFor(this.node(rel.target)).assertUnique(
            item,
            `${this.model.name}.${rel.name}.disconnect`,
          );
          await this.deleteEdges(exec, id, rel, where);
        }
      }
      if (set !== undefined) {
        if (!Array.isArray(set))
          throw new CyphraValidationError(`${rel.name}.set expects an array.`);
        await this.deleteEdges(exec, id, rel);
        for (const item of set) await this.connect(exec, id, rel, item);
      }
    } else if (disconnect === true || (mode === "update" && create !== undefined)) {
      // To-one: replace the existing edge (`connect` replaces it in its own statement).
      await this.deleteEdges(exec, id, rel);
    } else if (disconnect !== undefined && disconnect !== false) {
      throw new CyphraValidationError(
        `${rel.name}.disconnect on a to-one relation takes a boolean.`,
      );
    }

    if (connect !== undefined)
      for (const item of asArray(connect)) await this.connect(exec, id, rel, item);
    if (create !== undefined)
      for (const item of asArray(create)) await this.createRelated(exec, id, rel, item);
  }

  /** Compile scalar `data` of an update into `SET` assignments for variable `n`. */
  private setClauses(ctx: QueryContext, scalars: AnyRecord): string[] {
    const sets: string[] = [];
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
        for (const [op, amount] of Object.entries(v)) {
          if (amount === undefined) continue;
          const sym = { increment: "+", decrement: "-", multiply: "*" }[op];
          if (!sym) throw new CyphraValidationError(`Unknown number update "${op}".`);
          sets.push(
            `${ref} = ${ref} ${sym} ${ctx.param(encodeScalar(f, amount, this.model.name))}`,
          );
        }
        continue;
      }
      sets.push(`${ref} = ${ctx.param(encodeScalar(f, v, this.model.name))}`);
    }
    return sets;
  }

  private async updateNode(exec: Executor, id: string, data: unknown): Promise<void> {
    const { scalars, relations } = this.splitData(data, "update");
    const ctx = this.ctx();
    const sets = this.setClauses(ctx, scalars);
    if (sets.length) {
      await exec(
        `MATCH (n) WHERE elementId(n) = ${ctx.param(id)} SET ${sets.join(", ")}`,
        ctx.params,
      );
    }
    for (const [k, v] of Object.entries(relations)) {
      await this.writeRelation(exec, id, relationField(this.model, k)!, v, "update");
    }
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  create(args: AnyRecord): Promise<AnyRecord> {
    return this.runner.write(async (exec) => {
      const id = await this.createNode(exec, args.data);
      return this.readById(exec, id, args);
    });
  }

  // `async` so that invalid data rejects the returned promise instead of throwing synchronously.
  async createMany(args: AnyRecord): Promise<{ count: number }> {
    if (!Array.isArray(args.data))
      throw new CyphraValidationError("createMany: data must be an array.");
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
    });
  }

  update(args: AnyRecord): Promise<AnyRecord> {
    return this.runner.write(async (exec) => {
      const id = await this.findId(exec, args.where, "update");
      if (!id)
        throw new NotFoundError(
          `update: no ${this.model.name} matches ${JSON.stringify(args.where)}.`,
        );
      await this.updateNode(exec, id, args.data);
      return this.readById(exec, id, args);
    });
  }

  updateMany(args: AnyRecord): Promise<{ count: number }> {
    return this.runner.write(async (exec) => {
      const { scalars, relations } = this.splitData(args.data, "updateMany");
      if (Object.keys(relations).length) {
        throw new CyphraValidationError("updateMany does not support relation writes.");
      }
      const ctx = this.ctx();
      const w = compileWhere(ctx, this.model, "n", args.where);
      const sets = this.setClauses(ctx, scalars);
      const res = await exec(
        `MATCH (n:${this.label})${w ? ` WHERE ${w}` : ""}${sets.length ? ` SET ${sets.join(", ")}` : ""} RETURN count(n) AS c`,
        ctx.params,
      );
      return { count: toCount(res[0]?.c) };
    });
  }

  /**
   * Atomic upsert: one `MERGE` on a unique key of `where`, with the create data in
   * `ON CREATE SET` and the update in `ON MATCH SET`. Under concurrency this yields exactly one
   * node only when the key has a uniqueness constraint (`@id` / `@unique` / `@@unique` +
   * `cyphra db push` or a migration); without one, concurrent MERGEs can still create duplicates.
   *
   * Extra `where` filters (beyond the MERGE key) are checked on an existing node before it is
   * updated; if it does not match them, nothing is written and a {@link CyphraError} is thrown
   * (creating would duplicate the key). Nested relation writes run after the MERGE, in the same
   * transaction.
   */
  async upsert(args: AnyRecord): Promise<AnyRecord> {
    const { where, key: keyFields } = this.uniqueWhere(args.where, "upsert");
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
    const sets = this.setClauses(ctx, update.scalars);
    const flag = `n.${q(UPSERT_FLAG)}`;
    const trackCreated = nested || restWhere !== null;

    let text = `MERGE (n:${this.label} {${keyProps}})`;
    if (trackCreated) onCreate.push(`${flag} = true`);
    if (onCreate.length) text += ` ON CREATE SET ${onCreate.join(", ")}`;
    if (restWhere) {
      // Check the extra filters against the node as it was, then update it.
      text += ` WITH n, ${flag} IS NOT NULL AS created REMOVE ${flag}`;
      text += ` WITH n, created WHERE created OR (${restWhere})`;
      if (sets.length) {
        text += ` FOREACH (x IN CASE WHEN created THEN [] ELSE [1] END | SET ${sets.join(", ")})`;
      }
    } else {
      if (sets.length) text += ` ON MATCH SET ${sets.join(", ")}`;
      if (trackCreated) text += ` WITH n, ${flag} IS NOT NULL AS created REMOVE ${flag}`;
    }
    const projection = nested ? null : compileProjection(ctx, this.model, "n", args);
    text += ` RETURN elementId(n) AS id`;
    if (trackCreated) text += `, created`;
    if (projection) text += `, ${projection.expr} AS row`;

    return this.runner.write(async (exec) => {
      const rows = await exec(text, ctx.params);
      const row = rows[0];
      if (!row) {
        throw new CyphraError(
          `${this.model.name}.upsert: a node with ${keyFields.map((k) => `${k} = ${JSON.stringify(where[k])}`).join(", ")} exists but does not match the rest of where; creating another would duplicate the key.`,
        );
      }
      if (projection) return decodeRow(projection.shape, row.row)!;
      const id = row.id as string;
      const [relations, mode] = row.created
        ? ([create.relations, "create"] as const)
        : ([update.relations, "update"] as const);
      for (const [k, v] of Object.entries(relations)) {
        await this.writeRelation(exec, id, relationField(this.model, k)!, v, mode);
      }
      return this.readById(exec, id, args);
    });
  }

  /**
   * Delete one node. With `onDelete` rules on the model (or on models its cascades reach), the
   * node is locked, cascades are collected and `Restrict` rules checked before anything is
   * deleted, all in this transaction (see `onDelete.ts`).
   */
  delete(args: AnyRecord): Promise<AnyRecord> {
    return this.runner.write(async (exec) => {
      const id = await this.findId(exec, args.where, "delete");
      const missing = () =>
        new NotFoundError(`delete: no ${this.model.name} matches ${JSON.stringify(args.where)}.`);
      if (!id) throw missing();
      const rules = hasDeleteRules(this.schema, this.model);
      // Lock first so that the row returned is the one deleted (and the rules see every edge).
      if (rules && (await lockNodes(exec, this.schema, [id])).length === 0) throw missing();
      const row = await this.readById(exec, id, args);
      if (rules) {
        await deleteWithRules(exec, this.schema, this.model, [id]);
        return row;
      }
      const ctx = this.ctx();
      await exec(`MATCH (n) WHERE elementId(n) = ${ctx.param(id)} DETACH DELETE n`, ctx.params);
      return row;
    });
  }

  deleteMany(args: AnyRecord = {}): Promise<{ count: number }> {
    return this.runner.write(async (exec) => {
      const ctx = this.ctx();
      const w = compileWhere(ctx, this.model, "n", args.where);
      const match = `MATCH (n:${this.label})${w ? ` WHERE ${w}` : ""}`;
      if (hasDeleteRules(this.schema, this.model)) {
        const flag = `n.${q(LOCK_FLAG)}`;
        const rows = await exec(
          `${match} SET ${flag} = true REMOVE ${flag} RETURN elementId(n) AS id`,
          ctx.params,
        );
        const ids = rows.map((r) => r.id as string);
        return { count: await deleteWithRules(exec, this.schema, this.model, ids) };
      }
      const res = await exec(`${match} DETACH DELETE n RETURN count(*) AS c`, ctx.params);
      return { count: toCount(res[0]?.c) };
    });
  }
}
