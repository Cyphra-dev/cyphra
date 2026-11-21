import {
  createAdapterFactory,
  type AdapterFactory,
  type AdapterFactoryConfig,
  type AdapterFactoryCustomizeAdapterCreator,
  type CleanedWhere,
  type CustomAdapter,
  type DBAdapterDebugLogOption,
  type DBTransactionAdapter,
  type JoinConfig,
} from "better-auth/adapters";
import type { BetterAuthOptions } from "better-auth/types";
import { RestrictError, createOrm, type CyphraClient } from "@cyphra/runtime";
import { mergeAuthSchema } from "./merge.js";
import {
  deriveAuthGraph,
  type AuthGraph,
  type DeriveAuthGraphOptions,
  type ModelMapping,
  type NumberFields,
} from "./schema.js";
import { coerceScalar, fieldOf, toCyphraWhere } from "./where.js";

/** Options for {@link cyphraAdapter}. Pass `client` or `db`. */
export interface CyphraAdapterConfig {
  /** A Cyphra client (`new CyphraClient({ uri, user, password })`). */
  client?: CyphraClient;
  /** Your generated Cyphra ORM client; its connection (`db.$client`) is reused. */
  db?: { readonly $client: CyphraClient };
  /** Use plural model names (`users`, `sessions`, …). Default `false`. */
  usePlural?: boolean;
  /**
   * Better Auth `number` fields are stored as `Int` and reject fractions. List the fields that
   * hold fractional values to store them as `Float`, by model and field (schema key or database
   * name): `{ wallet: { balance: "float" } }`. Pass the same value to `authSchema`. Switching a
   * field from `int` to `float` needs no data migration: stored integers read back unchanged.
   */
  numberFields?: NumberFields;
  /**
   * Better Auth adapter debug logs. Leave off in production: logs can contain tokens and
   * other sensitive values.
   */
  debugLogs?: DBAdapterDebugLogOption;
}

type Row = Record<string, unknown>;
type Args = Record<string, unknown>;

type Delegate = {
  findMany(args: Args): Promise<Row[]>;
  findFirst(args: Args): Promise<Row | null>;
  count(args: Args): Promise<number>;
  create(args: Args): Promise<Row>;
  update(args: Args): Promise<Row>;
  updateMany(args: Args): Promise<{ count: number }>;
  deleteMany(args: Args): Promise<{ count: number }>;
};

/** An ORM client or a transaction client built from the auth schema. */
type Db = Record<string, unknown> & {
  $cypher(strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
};

/** The client to run operations on, and how to run several writes atomically. */
interface Source {
  readonly db: Db;
  write<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

/** Property set and removed at once to take a node's write lock. */
const LOCK_FLAG = "__cyphraLock";

function quote(id: string): string {
  return "`" + id.replace(/`/g, "``") + "`";
}

/**
 * Take the write lock on the nodes `(:node {field: value})`. Neo4j holds it until the
 * transaction ends, so concurrent writers on the same node run one after the other.
 */
async function lockNode(db: Db, node: string, field: string, value: unknown): Promise<void> {
  const head = `MATCH (n:${quote(node)}) WHERE n.${quote(field)} = `;
  const flag = `n.${quote(LOCK_FLAG)}`;
  const tail = ` SET ${flag} = true REMOVE ${flag} RETURN count(n) AS c`;
  const strings = Object.assign([head, tail], { raw: [head, tail] });
  await db.$cypher(strings, value);
}

function fail(message: string): never {
  throw new Error(`@cyphra/better-auth: ${message}`);
}

function createOperations(
  options: DeriveAuthGraphOptions,
  source: (graph: AuthGraph) => Source,
  onInit?: (graph: AuthGraph, source: Source) => void,
): AdapterFactoryCustomizeAdapterCreator {
  return (ctx) => {
    const graph = deriveAuthGraph(ctx, options);
    const src = source(graph);
    onInit?.(graph, src);

    const modelOf = (model: string, modelKey?: string): ModelMapping =>
      graph.models.get(modelKey ?? ctx.getDefaultModelName(model)) ??
      fail(`unknown model "${model}".`);
    const parentOf = (key: string) => graph.models.get(key)!;
    const delegate = (db: Db, m: ModelMapping) => db[m.delegate] as Delegate;
    const whereOf = (m: ModelMapping, where: readonly CleanedWhere[] | undefined) =>
      toCyphraWhere(m, where, parentOf);
    const childrenOf = (m: ModelMapping) =>
      [...graph.models.values()].flatMap((c) =>
        c.foreignKeys.filter((fk) => fk.parentKey === m.key).map((fk) => ({ child: c, fk })),
      );

    /** Database field names for a Better Auth `select` (schema or database names). */
    const selected = (m: ModelMapping, select?: readonly string[]): string[] =>
      select?.length
        ? select.map((s) => (m.fields.has(s) ? s : ctx.getFieldName({ model: m.key, field: s })))
        : [...m.fields.keys()];

    /** Cyphra `select`: scalars directly, foreign keys through their edge. */
    function selectOf(m: ModelMapping, select?: readonly string[]): Args {
      const out: Args = {};
      for (const name of selected(m, select)) {
        const f = fieldOf(m, name);
        if (f.kind === "scalar") out[name] = true;
        else out[f.relation] = { select: { [f.refField]: true } };
      }
      return out;
    }

    /** A Cyphra record back to the row shape Better Auth expects. */
    function toRow(m: ModelMapping, rec: Row, select?: readonly string[]): Row {
      const out: Row = {};
      for (const name of selected(m, select)) {
        const f = fieldOf(m, name);
        if (f.kind === "scalar") out[name] = rec[name] ?? null;
        else out[name] = (rec[f.relation] as Row | null | undefined)?.[f.refField] ?? null;
      }
      return out;
    }

    /** Better Auth data → Cyphra data: foreign keys become `connect` / `disconnect`. */
    function writeData(m: ModelMapping, data: Row, mode: "create" | "update"): Args {
      const out: Args = {};
      for (const [key, value] of Object.entries(data)) {
        if (value === undefined) continue;
        const f = fieldOf(m, key);
        if (f.kind === "scalar") out[key] = coerceScalar(f, value);
        else if (value !== null) out[f.relation] = { connect: { [f.refField]: value } };
        else if (mode === "update") out[f.relation] = { disconnect: true };
      }
      return out;
    }

    /**
     * Neo4j has no unique constraint on "the edge to a given parent", so `unique` foreign keys
     * are checked here, with the parent locked so that concurrent writes cannot both pass.
     */
    async function assertUniqueForeignKeys(
      tx: Db,
      m: ModelMapping,
      data: Row,
      selfId: unknown,
    ): Promise<void> {
      for (const fk of m.foreignKeys) {
        const value = data[fk.name];
        if (!fk.unique || value === undefined || value === null) continue;
        const parent = parentOf(fk.parentKey);
        await lockNode(tx, parent.node, fk.refField, value);
        const where: Args = { [fk.relation]: { is: { [fk.refField]: value } } };
        if (selfId !== undefined) where[m.idField] = { not: selfId };
        if ((await delegate(tx, m).count({ where })) > 0) {
          fail(`unique constraint failed on ${m.dbName}.${fk.name} = ${JSON.stringify(value)}.`);
        }
      }
    }

    /**
     * Delete the nodes of `m` matching `where`. The schema carries each foreign key's
     * `references.onDelete` as an `onDelete` rule on the parent's list field, and the ORM applies
     * it in the same transaction: `cascade` (Better Auth's default) deletes the children,
     * `restrict` / `no action` refuse the delete, `set null` / `set default` just lose the edge.
     */
    async function deleteWhere(tx: Db, m: ModelMapping, where: Args): Promise<number> {
      try {
        return (await delegate(tx, m).deleteMany({ where })).count;
      } catch (e) {
        if (!(e instanceof RestrictError)) throw e;
        const parent = [...graph.models.values()].find((x) => x.node === e.model);
        const hit = parent && childrenOf(parent).find(({ fk }) => fk.inverse === e.relation);
        if (!parent || !hit) throw e;
        fail(
          `cannot delete ${parent.dbName}: ${hit.child.dbName}.${hit.fk.name} references it (onDelete: "${hit.fk.onDelete}").`,
        );
      }
    }

    /** Find one matching node and take its write lock; `null` if it is gone by then. */
    async function lockOne(tx: Db, m: ModelMapping, where: Args): Promise<unknown> {
      const first = await delegate(tx, m).findFirst({ where, select: { [m.idField]: true } });
      if (!first) return null;
      const id = first[m.idField];
      await lockNode(tx, m.node, m.idField, id);
      // Re-check under the lock: a concurrent writer may have changed or deleted the node.
      const still = await delegate(tx, m).count({ where: { AND: [where, { [m.idField]: id }] } });
      return still === 1 ? id : null;
    }

    /** Native joins: follow the edges in the same query (`include` on the relation field). */
    function joinPlan(m: ModelMapping, join: JoinConfig | undefined) {
      const select: Args = {};
      const readers: ((rec: Row, out: Row) => void)[] = [];
      for (const [name, cfg] of Object.entries(join ?? {})) {
        const jm = modelOf(name, cfg.modelKey);
        const forward = jm.foreignKeys.find(
          (fk) => fk.parentKey === m.key && fk.name === cfg.on.to,
        );
        const backward = m.foreignKeys.find(
          (fk) => fk.parentKey === jm.key && fk.name === cfg.on.from,
        );
        const field = forward?.inverse ?? backward?.relation;
        if (!field) continue; // let Better Auth fall back to separate queries
        const many = Boolean(forward);
        select[field] = {
          select: selectOf(jm),
          ...(many && cfg.limit !== undefined ? { take: cfg.limit } : {}),
        };
        readers.push((rec, out) => {
          const v = rec[field];
          const rows = (many ? (v as Row[]) : v ? [v as Row] : []).map((r) => toRow(jm, r));
          out[name] = cfg.relation === "one-to-one" ? (rows[0] ?? null) : rows;
        });
      }
      return {
        select,
        read: (rec: Row, out: Row) => {
          for (const r of readers) r(rec, out);
          return out;
        },
      };
    }

    /** A foreign key sorts by the referenced field of the related node, through the edge. */
    function orderByOf(m: ModelMapping, sortBy?: { field: string; direction: "asc" | "desc" }) {
      if (!sortBy) return undefined;
      const f = fieldOf(m, sortBy.field);
      if (f.kind === "scalar") return { [f.name]: sortBy.direction };
      return { [f.relation]: { [f.refField]: sortBy.direction } };
    }

    const adapter: CustomAdapter = {
      create: async ({ model, modelKey, data, select }) => {
        const m = modelOf(model, modelKey);
        return src.write(async (tx) => {
          await assertUniqueForeignKeys(tx, m, data, undefined);
          const rec = await delegate(tx, m).create({
            data: writeData(m, data, "create"),
            select: selectOf(m),
          });
          return toRow(m, rec, select) as typeof data;
        });
      },

      findOne: async <T>({
        model,
        modelKey,
        where,
        select,
        join,
      }: {
        model: string;
        modelKey?: string;
        where: CleanedWhere[];
        select?: string[];
        join?: JoinConfig;
      }) => {
        const m = modelOf(model, modelKey);
        const plan = joinPlan(m, join);
        const rec = await delegate(src.db, m).findFirst({
          where: whereOf(m, where),
          select: { ...selectOf(m, select), ...plan.select },
        });
        return (rec ? plan.read(rec, toRow(m, rec, select)) : null) as T | null;
      },

      findMany: async <T>({
        model,
        modelKey,
        where,
        limit,
        sortBy,
        offset,
        select,
        join,
      }: {
        model: string;
        modelKey?: string;
        where?: CleanedWhere[];
        limit: number;
        sortBy?: { field: string; direction: "asc" | "desc" };
        offset?: number;
        select?: string[];
        join?: JoinConfig;
      }) => {
        const m = modelOf(model, modelKey);
        const plan = joinPlan(m, join);
        const recs = await delegate(src.db, m).findMany({
          where: whereOf(m, where),
          select: { ...selectOf(m, select), ...plan.select },
          orderBy: orderByOf(m, sortBy),
          ...(offset ? { skip: offset } : {}),
          ...(limit !== undefined && limit >= 0 ? { take: limit } : {}),
        });
        return recs.map((rec) => plan.read(rec, toRow(m, rec, select))) as T[];
      },

      count: async ({ model, modelKey, where }) => {
        const m = modelOf(model, modelKey);
        return delegate(src.db, m).count({ where: whereOf(m, where) });
      },

      update: async <T>({
        model,
        modelKey,
        where,
        update,
      }: {
        model: string;
        modelKey?: string;
        where: CleanedWhere[];
        update: T;
      }) => {
        if (!where.length) return null;
        const m = modelOf(model, modelKey);
        return src.write(async (tx) => {
          const first = await delegate(tx, m).findFirst({
            where: whereOf(m, where),
            select: { [m.idField]: true },
          });
          if (!first) return null;
          const id = first[m.idField];
          await assertUniqueForeignKeys(tx, m, update as Row, id);
          const rec = await delegate(tx, m).update({
            where: { [m.idField]: id },
            data: writeData(m, update as Row, "update"),
            select: selectOf(m),
          });
          return toRow(m, rec) as T;
        });
      },

      updateMany: async ({ model, modelKey, where, update }) => {
        const m = modelOf(model, modelKey);
        const data = writeData(m, update, "update");
        const touchesEdges = m.foreignKeys.some((fk) => update[fk.name] !== undefined);
        if (!touchesEdges) {
          return (await delegate(src.db, m).updateMany({ where: whereOf(m, where), data })).count;
        }
        return src.write(async (tx) => {
          const ids = await delegate(tx, m).findMany({
            where: whereOf(m, where),
            select: { [m.idField]: true },
          });
          for (const rec of ids) {
            await assertUniqueForeignKeys(tx, m, update, rec[m.idField]);
            await delegate(tx, m).update({ where: { [m.idField]: rec[m.idField] }, data });
          }
          return ids.length;
        });
      },

      delete: async ({ model, modelKey, where }) => {
        const m = modelOf(model, modelKey);
        await src.write((tx) => deleteWhere(tx, m, whereOf(m, where)));
      },

      deleteMany: async ({ model, modelKey, where }) => {
        const m = modelOf(model, modelKey);
        return src.write((tx) => deleteWhere(tx, m, whereOf(m, where)));
      },

      /**
       * Atomic find-and-delete of one row: lock it, re-check the predicate, delete it. Of N
       * concurrent callers on the same row, one gets the row and the others get `null`.
       */
      consumeOne: async <T>({
        model,
        modelKey,
        where,
      }: {
        model: string;
        modelKey?: string;
        where: CleanedWhere[];
      }) => {
        const m = modelOf(model, modelKey);
        return src.write(async (tx) => {
          const id = await lockOne(tx, m, whereOf(m, where));
          if (id === null) return null;
          const byId = { [m.idField]: id };
          const rec = await delegate(tx, m).findFirst({ where: byId, select: selectOf(m) });
          if (!rec) return null;
          await deleteWhere(tx, m, byId);
          return toRow(m, rec) as T;
        });
      },

      /** Guarded atomic counter update on one row (`where` is both selector and guard). */
      incrementOne: async <T>({
        model,
        modelKey,
        where,
        increment,
        set,
      }: {
        model: string;
        modelKey?: string;
        where: CleanedWhere[];
        increment: Record<string, number>;
        set?: Record<string, unknown>;
      }) => {
        const m = modelOf(model, modelKey);
        return src.write(async (tx) => {
          const id = await lockOne(tx, m, whereOf(m, where));
          if (id === null) return null;
          const data = writeData(m, (set ?? {}) as Row, "update");
          for (const [key, delta] of Object.entries(increment)) {
            const f = fieldOf(m, key);
            if (f.kind !== "scalar") fail(`cannot increment the foreign key ${m.dbName}.${key}.`);
            data[key] = { increment: delta };
          }
          await assertUniqueForeignKeys(tx, m, (set ?? {}) as Row, id);
          const rec = await delegate(tx, m).update({
            where: { [m.idField]: id },
            data,
            select: selectOf(m),
          });
          return toRow(m, rec) as T;
        });
      },

      createSchema: async ({ file, tables }) => {
        const authGraph = deriveAuthGraph(
          {
            schema: tables,
            getModelName: ctx.getModelName,
            getFieldName: ctx.getFieldName,
          },
          options,
        );
        const { readFile } = await import("node:fs/promises");
        const path = await import("node:path");
        const target = file ?? (await configuredSchemaPath(readFile)) ?? "schema.cyphra";
        let existing: string | undefined;
        try {
          existing = await readFile(path.resolve(process.cwd(), target), "utf8");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        return {
          code: mergeAuthSchema(existing, authGraph.document),
          path: target,
          overwrite: true,
        };
      },
    };
    return adapter;
  };
}

/** The `schema` path from `cyphra.json` in the working directory, if there is one. */
async function configuredSchemaPath(
  readFile: (p: string, enc: "utf8") => Promise<string>,
): Promise<string | undefined> {
  try {
    const config = JSON.parse(await readFile("cyphra.json", "utf8")) as { schema?: unknown };
    return typeof config.schema === "string" ? config.schema : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Better Auth database adapter for Neo4j, built on the Cyphra ORM runtime.
 *
 * The Cyphra schema is derived from your Better Auth configuration (plugins included) at
 * runtime. Foreign keys are stored as edges: `Session.userId` is the edge
 * `(User)-[:HAS_SESSION]->(Session)`.
 *
 * @example
 * ```ts
 * import { betterAuth } from "better-auth";
 * import { cyphraAdapter } from "@cyphra/better-auth";
 * import { db } from "./db"; // your generated Cyphra client
 *
 * export const auth = betterAuth({ database: cyphraAdapter({ db }) });
 * ```
 */
export function cyphraAdapter(config: CyphraAdapterConfig): AdapterFactory<BetterAuthOptions> {
  const client = config.client ?? config.db?.$client;
  if (!client) fail("pass `client` (a CyphraClient) or `db` (a Cyphra ORM client).");

  /** Better Auth passes its options when it builds the adapter; transactions need them again. */
  let resolvedOptions: BetterAuthOptions | undefined;
  const graphOptions: DeriveAuthGraphOptions = { numberFields: config.numberFields };
  let root: { graph: AuthGraph; source: Source } | undefined;

  const base: AdapterFactoryConfig = {
    adapterId: "cyphra",
    adapterName: "Cyphra (Neo4j)",
    usePlural: config.usePlural ?? false,
    debugLogs: config.debugLogs ?? false,
    supportsJSON: false,
    supportsDates: true,
    supportsBooleans: true,
    supportsArrays: true,
    supportsNumericIds: false,
    supportsUUIDs: false,
  };

  const factoryConfig: AdapterFactoryConfig = {
    ...base,
    transaction: (callback) => {
      if (!resolvedOptions || !root) fail("adapter used before Better Auth initialized it.");
      const options = resolvedOptions;
      return root.source.write((tx) => {
        const inTx = createAdapterFactory({
          config: { ...base, transaction: false },
          adapter: createOperations(graphOptions, () => ({ db: tx, write: (fn) => fn(tx) })),
        });
        return callback(inTx(options) as DBTransactionAdapter);
      });
    },
  };

  const factory = createAdapterFactory({
    config: factoryConfig,
    adapter: createOperations(
      graphOptions,
      (graph) => {
        const orm = createOrm(graph.schema, { client }) as unknown as Db & {
          $transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
        };
        return { db: orm, write: (fn) => orm.$transaction(fn) };
      },
      (graph, source) => {
        root = { graph, source };
      },
    ),
  });

  return (options) => {
    resolvedOptions = options;
    return factory(options);
  };
}
