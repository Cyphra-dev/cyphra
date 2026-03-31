import {
  compileCreate,
  compileCreateLinkedNodes,
  compileCreateRelationship,
  compileRootOptionalOutgoingSelect,
  compileWhereFragment,
  concatCompiledCypher,
  eq,
  prop,
  select,
  type CompiledCypher,
} from "@cyphra/query";
import type { CyphraClient } from "@cyphra/runtime";
import type { NodeDeclaration, RelationalNodeField, SchemaDocument } from "@cyphra/schema";
import { validateSchema } from "@cyphra/schema";
import { createNodeCrud, type NodeCrud } from "./crud.js";
import { getIdFieldName, getNodeDeclaration, getScalarFields, getUniqueFieldNames } from "./nodeMeta.js";
import { decoratorStringArg, decoratorStringOrIdArg, getScalarDefaultFn } from "./schemaDecorators.js";

function newUuid(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  throw new Error("schemaClient.create: crypto.randomUUID is not available");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Prisma-style model key: **`Post`** → **`posts`**, **`Author`** → **`authors`**.
 */
export function modelNameToClientKey(nodeName: string): string {
  const head = nodeName.charAt(0).toLowerCase() + nodeName.slice(1);
  return head.endsWith("s") ? head : `${head}s`;
}

function assertScalarKeysAllowed(nodeDecl: NodeDeclaration, keys: Iterable<string>, ctx: string): void {
  const allowed = new Set(getScalarFields(nodeDecl).map((f) => f.name));
  for (const k of keys) {
    if (!allowed.has(k)) {
      throw new Error(`${ctx}: unknown field "${k}" on node ${nodeDecl.name}`);
    }
  }
}

function pickServerTimestampProperty(nodeDecl: NodeDeclaration): string | undefined {
  for (const f of getScalarFields(nodeDecl)) {
    if (f.type.name !== "DateTime") {
      continue;
    }
    if (getScalarDefaultFn(f) === "now") {
      return f.name;
    }
  }
  return undefined;
}

function prepareScalarCreatePayload(
  nodeDecl: NodeDeclaration,
  data: Record<string, unknown>,
  ctx: string,
): { props: Record<string, unknown>; serverTimestamp?: string } {
  assertScalarKeysAllowed(nodeDecl, Object.keys(data), ctx);
  const props = { ...data };
  const idField = getIdFieldName(nodeDecl);
  if (idField) {
    const idScalar = getScalarFields(nodeDecl).find((f) => f.name === idField);
    const fn = idScalar ? getScalarDefaultFn(idScalar) : undefined;
    if (fn === "cuid" && props[idField] == null) {
      props[idField] = newUuid();
    }
  }
  const ts = pickServerTimestampProperty(nodeDecl);
  if (ts !== undefined) {
    delete props[ts];
  }
  return ts !== undefined ? { props, serverTimestamp: ts } : { props };
}

function getRelationshipEdgeMeta(
  field: RelationalNodeField,
): { relType: string; direction: "IN" | "OUT" } | undefined {
  const relType = decoratorStringArg(field.decorators, "relationship", "type");
  const direction = decoratorStringOrIdArg(field.decorators, "relationship", "direction");
  if (!relType || (direction !== "IN" && direction !== "OUT")) {
    return undefined;
  }
  return { relType, direction };
}

type NestedRelSpec =
  | { field: RelationalNodeField; kind: "create"; payload: Record<string, unknown> }
  | { field: RelationalNodeField; kind: "connect"; payload: Record<string, unknown> };

function partitionCreateData(nodeDecl: NodeDeclaration, data: Record<string, unknown>): {
  scalars: Record<string, unknown>;
  nested?: NestedRelSpec;
} {
  const relational = new Map<string, RelationalNodeField>();
  for (const f of nodeDecl.fields) {
    if (f.kind === "Relational") {
      relational.set(f.name, f);
    }
  }
  const scalars: Record<string, unknown> = {};
  let nested: NestedRelSpec | undefined;
  for (const [k, v] of Object.entries(data)) {
    const rel = relational.get(k);
    if (rel) {
      if (nested) {
        throw new Error(
          `schemaClient.create: multiple nested relations in one create() is not supported yet (${nodeDecl.name})`,
        );
      }
      if (!isPlainObject(v)) {
        throw new Error(`schemaClient.create: field "${k}" must be an object with { create } or { connect }`);
      }
      const inner = v as { create?: unknown; connect?: unknown };
      if (inner.create !== undefined && inner.connect !== undefined) {
        throw new Error(`schemaClient.create: field "${k}" cannot use both create and connect`);
      }
      if (inner.connect !== undefined) {
        if (!isPlainObject(inner.connect)) {
          throw new Error(`schemaClient.create: field "${k}".connect must be an object`);
        }
        nested = { field: rel, kind: "connect", payload: inner.connect };
        continue;
      }
      if (!isPlainObject(inner.create)) {
        throw new Error(`schemaClient.create: field "${k}" expects { create: { … } } or { connect: { … } }`);
      }
      nested = { field: rel, kind: "create", payload: inner.create };
      continue;
    }
    scalars[k] = v;
  }
  return { scalars, nested };
}

function buildUniqueWhereForAlias(
  nodeDecl: NodeDeclaration,
  where: Record<string, unknown>,
  alias: string,
): import("@cyphra/query").WherePredicate[] {
  const id = getIdFieldName(nodeDecl);
  const uniq = getUniqueFieldNames(nodeDecl);
  const allowed = new Set<string>([...(id ? [id] : []), ...uniq]);
  const preds: import("@cyphra/query").WherePredicate[] = [];
  for (const [k, v] of Object.entries(where)) {
    if (!allowed.has(k)) {
      throw new Error(`schemaClient.connect: key "${k}" is not @id or @unique on ${nodeDecl.name}`);
    }
    preds.push(eq(prop(alias, k), v));
  }
  if (preds.length === 0) {
    throw new Error("schemaClient.connect: where must include at least one @id or @unique field");
  }
  return preds;
}

async function runCreateAndReturn(
  client: CyphraClient,
  label: string,
  idField: string,
  idValue: unknown,
  compiled: CompiledCypher,
): Promise<Record<string, unknown> | undefined> {
  return client.withWriteTransaction(async (tx) => {
    await client.runCompiledTx(tx, compiled);
    const q = select()
      .match(`(n:${label})`)
      .where(eq(prop("n", idField), idValue))
      .returnStar();
    return client.queryRecordTx(tx, q.toCypher());
  });
}

async function modelCreateWithConnect(
  client: CyphraClient,
  doc: SchemaDocument,
  nodeDecl: NodeDeclaration,
  scalars: Record<string, unknown>,
  nested: NestedRelSpec & { kind: "connect" },
  idField: string,
): Promise<Record<string, unknown> | undefined> {
  if (nested.field.cardinality === "many") {
    throw new Error(`schemaClient.connect: only to-one relations ("${nested.field.name}")`);
  }
  const edge = getRelationshipEdgeMeta(nested.field);
  if (!edge || edge.direction !== "OUT") {
    throw new Error(`schemaClient.connect: requires OUT @relationship on ${nodeDecl.name}.${nested.field.name}`);
  }
  const targetDecl = getNodeDeclaration(doc, nested.field.target);
  if (!targetDecl) {
    throw new Error(`schemaClient.connect: unknown target "${nested.field.target}"`);
  }
  const preds = buildUniqueWhereForAlias(targetDecl, nested.payload, "m");
  const wf = compileWhereFragment(preds);
  const matchPart: CompiledCypher = {
    text: `MATCH (m:${targetDecl.name}) WHERE ${wf.text}`,
    params: wf.params,
  };
  const primaryPrepared = prepareScalarCreatePayload(nodeDecl, scalars, "schemaClient.create");
  const createNode = compileCreate(nodeDecl.name, primaryPrepared.props, "n");
  const withTs =
    primaryPrepared.serverTimestamp !== undefined
      ? applyCreateServerTimestamp(createNode, "n", primaryPrepared.serverTimestamp)
      : createNode;
  const rel = compileCreateRelationship("n", "r", edge.relType, "m");
  const compiled = concatCompiledCypher([matchPart, withTs, rel], { separator: " " });
  return runCreateAndReturn(client, nodeDecl.name, idField, primaryPrepared.props[idField], compiled);
}

function applyCreateServerTimestamp(compiled: CompiledCypher, alias: string, property: string): CompiledCypher {
  const needle = `SET ${alias} += $props`;
  if (!compiled.text.includes(needle)) {
    throw new Error(`schemaClient: expected CREATE to contain ${JSON.stringify(needle)}`);
  }
  return {
    text: compiled.text.replace(needle, `${needle}, ${alias}.${property} = datetime()`),
    params: compiled.params,
  };
}

async function modelCreate(
  client: CyphraClient,
  doc: SchemaDocument,
  nodeDecl: NodeDeclaration,
  data: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const idField = getIdFieldName(nodeDecl);
  if (!idField) {
    throw new Error(`schemaClient.create: node "${nodeDecl.name}" has no @id field`);
  }

  const { scalars, nested } = partitionCreateData(nodeDecl, data);

  if (!nested) {
    const { props, serverTimestamp } = prepareScalarCreatePayload(nodeDecl, scalars, "schemaClient.create");
    const compiled = compileCreateLinkedNodes({
      primary: {
        label: nodeDecl.name,
        alias: "n",
        props,
        serverTimestamp,
      },
    });
    return runCreateAndReturn(client, nodeDecl.name, idField, props[idField], compiled);
  }

  if (nested.kind === "connect") {
    return modelCreateWithConnect(client, doc, nodeDecl, scalars, nested, idField);
  }

  if (nested.field.cardinality === "many") {
    throw new Error(
      `schemaClient.create: nested create is only supported for to-one relations ("${nested.field.name}")`,
    );
  }
  const edge = getRelationshipEdgeMeta(nested.field);
  if (!edge) {
    throw new Error(
      `schemaClient.create: field "${nested.field.name}" is missing @relationship(type: "…", direction: IN|OUT)`,
    );
  }
  if (edge.direction !== "OUT") {
    throw new Error(
      `schemaClient.create: nested create currently requires direction OUT from ${nodeDecl.name}.${nested.field.name}`,
    );
  }

  const targetDecl = getNodeDeclaration(doc, nested.field.target);
  if (!targetDecl) {
    throw new Error(`schemaClient.create: unknown target node "${nested.field.target}"`);
  }

  const primaryPrepared = prepareScalarCreatePayload(nodeDecl, scalars, "schemaClient.create");
  const childPrepared = prepareScalarCreatePayload(
    targetDecl,
    nested.payload,
    `schemaClient.create (${nested.field.name}.create)`,
  );

  const compiled = compileCreateLinkedNodes({
    primary: {
      label: nodeDecl.name,
      alias: "n",
      props: primaryPrepared.props,
      serverTimestamp: primaryPrepared.serverTimestamp,
    },
    secondary: {
      label: targetDecl.name,
      alias: "m",
      props: childPrepared.props,
    },
    link: { type: edge.relType, alias: "r" },
  });

  return runCreateAndReturn(
    client,
    nodeDecl.name,
    idField,
    primaryPrepared.props[idField],
    compiled,
  );
}

/** Prisma-shaped args for {@link ModelDelegate.create}. */
export type ModelCreateArgs = {
  readonly data: Record<string, unknown>;
};

/** Prisma-shaped args for {@link ModelDelegate.findMany}. */
export type ModelFindManyArgs = {
  readonly where?: Record<string, unknown>;
  readonly skip?: number;
  readonly take?: number;
  readonly orderBy?: { readonly field: string; readonly direction: "asc" | "desc" };
  readonly include?: Readonly<Record<string, boolean>>;
};

/** Prisma-shaped args for {@link ModelDelegate.findFirst}. */
export type ModelFindFirstArgs = {
  readonly where?: Record<string, unknown>;
  readonly orderBy?: { readonly field: string; readonly direction: "asc" | "desc" };
  readonly include?: Readonly<Record<string, boolean>>;
};

/** Prisma-shaped args for {@link ModelDelegate.findUnique}. */
export type ModelFindUniqueArgs = {
  readonly where: Record<string, unknown>;
};

/** Prisma-shaped args for {@link ModelDelegate.update}. */
export type ModelUpdateArgs = {
  readonly where: Record<string, unknown>;
  readonly data: Record<string, unknown>;
};

/** Prisma-shaped args for {@link ModelDelegate.delete}. */
export type ModelDeleteArgs = {
  readonly where: Record<string, unknown>;
};

/**
 * Per-node API similar to Prisma **`prisma.post.create({ data })`**
 * (nested **`create`** / **`connect`** on one OUT to-one edge; **`findMany`** with optional **`include`** / **`orderBy`**).
 */
export type ModelDelegate = {
  readonly label: string;
  findUnique(args: ModelFindUniqueArgs): Promise<Record<string, unknown> | undefined>;
  findFirst(args?: ModelFindFirstArgs): Promise<Record<string, unknown> | undefined>;
  findMany(args?: ModelFindManyArgs): Promise<Record<string, unknown>[]>;
  create(args: ModelCreateArgs): Promise<Record<string, unknown> | undefined>;
  update(args: ModelUpdateArgs): Promise<Record<string, unknown> | undefined>;
  delete(args: ModelDeleteArgs): Promise<void>;
};

export type CyphraSchemaClient = Readonly<Record<string, ModelDelegate>>;

function getSingleIncludeRel(
  nodeDecl: NodeDeclaration,
  include: Readonly<Record<string, boolean>>,
): { field: RelationalNodeField } | undefined {
  const keys = Object.entries(include)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  if (keys.length === 0) {
    return undefined;
  }
  if (keys.length > 1) {
    throw new Error(`schemaClient.findMany: only one include: true relation is supported (got ${keys.join(", ")})`);
  }
  const name = keys[0]!;
  const field = nodeDecl.fields.find(
    (f): f is RelationalNodeField => f.kind === "Relational" && f.name === name,
  );
  if (!field) {
    throw new Error(`schemaClient.findMany: unknown relation include "${name}" on ${nodeDecl.name}`);
  }
  if (field.cardinality === "many") {
    throw new Error(`schemaClient.findMany: include on "${name}" is only supported for to-one relations`);
  }
  const edge = getRelationshipEdgeMeta(field);
  if (!edge || edge.direction !== "OUT") {
    throw new Error(`schemaClient.findMany: include requires OUT @relationship on ${nodeDecl.name}.${name}`);
  }
  return { field };
}

async function modelFindMany(
  client: CyphraClient,
  doc: SchemaDocument,
  nodeDecl: NodeDeclaration,
  base: NodeCrud,
  args?: ModelFindManyArgs,
): Promise<Record<string, unknown>[]> {
  const include = args?.include;
  const hasInclude = include && Object.keys(include).length > 0;

  const preds: import("@cyphra/query").WherePredicate[] = [];
  if (args?.where && Object.keys(args.where).length > 0) {
    for (const [k, v] of Object.entries(args.where)) {
      preds.push(eq(prop("n", k), v));
    }
  }

  if (hasInclude) {
    const inc = getSingleIncludeRel(nodeDecl, include!);
    if (inc) {
      const targetDecl = getNodeDeclaration(doc, inc.field.target);
      if (!targetDecl) {
        throw new Error(`schemaClient.findMany: unknown target node "${inc.field.target}"`);
      }
      const edge = getRelationshipEdgeMeta(inc.field)!;

      const rootPicks = getScalarFields(nodeDecl).map((f) => f.name);
      const targetPicks = getScalarFields(targetDecl).map((f) => f.name);

      const orderDir = args?.orderBy?.direction === "asc" ? "ASC" : "DESC";
      const orderField = args?.orderBy?.field;

      const compiled = compileRootOptionalOutgoingSelect({
        rootLabel: nodeDecl.name,
        rootAlias: "n",
        outgoing: {
          relType: edge.relType,
          relAlias: "r",
          targetLabel: targetDecl.name,
          targetAlias: "a",
        },
        returnMaps: [
          { resultKey: "root", variable: "n", pick: rootPicks },
          { resultKey: "included", variable: "a", pick: targetPicks },
        ],
        where: preds.length > 0 ? preds : undefined,
        orderBy:
          orderField !== undefined
            ? { variable: "n", property: orderField, direction: orderDir }
            : undefined,
        skip: args?.skip,
        limit: args?.take,
      });

      const rows = await client.withSession((s) => client.queryRecords(s, compiled));

      const relKey = inc.field.name;
      return rows.map((row) => {
        const root = row.root as Record<string, unknown>;
        const incl = row.included as Record<string, unknown> | null | undefined;
        return {
          ...root,
          [relKey]: incl != null && Object.keys(incl).length > 0 ? incl : null,
        };
      });
    }
  }

  if (args?.orderBy !== undefined) {
    const rootPicks = getScalarFields(nodeDecl).map((f) => f.name);
    const orderDir = args.orderBy.direction === "asc" ? "ASC" : "DESC";
    const compiled = compileRootOptionalOutgoingSelect({
      rootLabel: nodeDecl.name,
      rootAlias: "n",
      returnMaps: [{ resultKey: "root", variable: "n", pick: rootPicks }],
      where: preds.length > 0 ? preds : undefined,
      orderBy: { variable: "n", property: args.orderBy.field, direction: orderDir },
      skip: args.skip,
      limit: args.take,
    });
    const rows = await client.withSession((s) => client.queryRecords(s, compiled));
    return rows.map((row) => row.root as Record<string, unknown>);
  }

  return flattenFindManyRows(
    await base.findMany({
      where: args?.where,
      skip: args?.skip,
      limit: args?.take,
    }),
  );
}

function flattenFindManyRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const n = row.n;
    if (n && typeof n === "object" && !Array.isArray(n)) {
      return { ...(n as Record<string, unknown>) };
    }
    return row;
  });
}

function buildModelDelegate(
  client: CyphraClient,
  doc: SchemaDocument,
  nodeDecl: NodeDeclaration,
  base: NodeCrud,
): ModelDelegate {
  return {
    label: base.label,
    findUnique: (args) => base.findUnique(args.where),
    findFirst: async (args) => {
      const rows = await modelFindMany(client, doc, nodeDecl, base, {
        where: args?.where,
        take: 1,
        orderBy: args?.orderBy,
        include: args?.include,
      });
      return rows[0];
    },
    findMany: (args) => modelFindMany(client, doc, nodeDecl, base, args),
    create: (a) => modelCreate(client, doc, nodeDecl, a.data),
    update: (a) => base.update(a.where, a.data),
    delete: (a) => base.delete(a.where),
  };
}

/**
 * Build a **`db.posts.create`-style** client: one delegate per **`node`** in the schema (keys from {@link modelNameToClientKey}).
 *
 * - **`create`**: graph **`CREATE`** with **`@default(cuid())`** / **`@default(now())`**; nested **`create`** or **`connect`** on one OUT to-one relation.
 * - **`findMany`**: optional **`include`** (one optional OUT to-one) and **`orderBy`** on the root node; otherwise same as {@link createNodeCrud}.
 */
export function createSchemaClient(client: CyphraClient, doc: SchemaDocument): CyphraSchemaClient {
  validateSchema(doc);
  const out: Record<string, ModelDelegate> = {};
  for (const decl of doc.declarations) {
    if (decl.kind !== "Node") {
      continue;
    }
    const key = modelNameToClientKey(decl.name);
    const base = createNodeCrud(client, doc, decl.name);
    out[key] = buildModelDelegate(client, doc, decl, base);
  }
  return out;
}
