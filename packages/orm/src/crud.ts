import {
  compileCreate,
  compileDetachDeleteWhere,
  compileMergeSet,
  compileSetWhere,
  eq,
  prop,
  select,
  type CompiledCypher,
  type WherePredicate,
} from "@cyphra/query";
import type { CyphraClient } from "@cyphra/runtime";
import type { SchemaDocument } from "@cyphra/schema";
import {
  getIdFieldName,
  getNodeDeclaration,
  getScalarFields,
  getUniqueFieldNames,
} from "./nodeMeta.js";

export type NodeCrud = {
  readonly label: string;
  findUnique(where: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
  findMany(opts?: {
    where?: Record<string, unknown>;
    skip?: number;
    limit?: number;
  }): Promise<Record<string, unknown>[]>;
  create(data: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
  update(
    where: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined>;
  delete(where: Record<string, unknown>): Promise<void>;
};

function withReturnNode(compiled: CompiledCypher, alias = "n"): CompiledCypher {
  return {
    text: `${compiled.text} RETURN ${alias} AS ${alias}`,
    params: compiled.params,
  };
}

function buildUniqueWhere(
  nodeDecl: import("@cyphra/schema").NodeDeclaration,
  where: Record<string, unknown>,
): WherePredicate[] {
  const id = getIdFieldName(nodeDecl);
  const uniq = getUniqueFieldNames(nodeDecl);
  const allowed = new Set<string>([...(id ? [id] : []), ...uniq]);
  const preds: WherePredicate[] = [];
  const alias = "n";
  for (const [k, v] of Object.entries(where)) {
    if (!allowed.has(k)) {
      throw new Error(`createCrud: key "${k}" is not @id or @unique on this node`);
    }
    preds.push(eq(prop(alias, k), v));
  }
  if (preds.length === 0) {
    throw new Error("createCrud: where must include at least one @id or @unique field");
  }
  return preds;
}

/**
 * CRUD helpers for one `node` declaration in a {@link SchemaDocument}.
 *
 * Uses `MERGE` on the `@id` field for {@link NodeCrud.create} when an id is present in `data`;
 * otherwise uses `CREATE` with `SET n += $props` (caller should supply ids via app logic).
 */
export function createNodeCrud(
  client: CyphraClient,
  doc: SchemaDocument,
  nodeName: string,
): NodeCrud {
  const nodeDecl = getNodeDeclaration(doc, nodeName);
  if (!nodeDecl) {
    throw new Error(`createNodeCrud: unknown node "${nodeName}"`);
  }
  const label = nodeDecl.name;
  const idField = getIdFieldName(nodeDecl);
  const scalarNames = new Set(getScalarFields(nodeDecl).map((f) => f.name));

  const assertScalarData = (data: Record<string, unknown>, labelForErr: string) => {
    for (const k of Object.keys(data)) {
      if (!scalarNames.has(k)) {
        throw new Error(`${labelForErr}: unknown field "${k}" for node ${nodeName}`);
      }
    }
  };

  return {
    label,

    async findUnique(where) {
      const preds = buildUniqueWhere(nodeDecl, where);
      const q = select()
        .match(`(n:${label})`)
        .where(...preds)
        .returnStar();
      return client.withSession((s) => client.queryRecord(s, q.toCypher()));
    },

    async findMany(opts) {
      const alias = "n";
      if (opts?.where && Object.keys(opts.where).length > 0) {
        const preds: WherePredicate[] = [];
        for (const [k, v] of Object.entries(opts.where)) {
          preds.push(eq(prop(alias, k), v));
        }
        let q = select()
          .match(`(${alias}:${label})`)
          .where(...preds)
          .returnStar();
        if (opts.skip != null) q = q.skip(opts.skip);
        if (opts.limit != null) q = q.limit(opts.limit);
        return client.withSession((s) => client.queryRecords(s, q.toCypher()));
      }
      let q = select().match(`(${alias}:${label})`).returnStar();
      if (opts?.skip != null) q = q.skip(opts.skip);
      if (opts?.limit != null) q = q.limit(opts.limit);
      return client.withSession((s) => client.queryRecords(s, q.toCypher()));
    },

    async create(data) {
      assertScalarData(data, "create");
      if (idField && data[idField] != null) {
        const { [idField]: keyVal, ...rest } = data;
        const compiled = compileMergeSet(label, idField, keyVal, rest);
        return client.withSession(async (s) => {
          return client.queryRecord(s, withReturnNode(compiled));
        });
      }
      const compiled = compileCreate(label, data);
      return client.withSession(async (s) => {
        return client.queryRecord(s, withReturnNode(compiled));
      });
    },

    async update(where, patch) {
      assertScalarData(patch, "update");
      const preds = buildUniqueWhere(nodeDecl, where);
      const compiled = compileSetWhere(label, "n", preds, patch);
      await client.withSession((s) => client.runCompiled(s, compiled));
      const q = select()
        .match(`(n:${label})`)
        .where(...preds)
        .returnStar();
      return client.withSession((s) => client.queryRecord(s, q.toCypher()));
    },

    async delete(where) {
      const preds = buildUniqueWhere(nodeDecl, where);
      const compiled = compileDetachDeleteWhere(label, "n", preds);
      await client.withSession((s) => client.runCompiled(s, compiled));
    },
  };
}
