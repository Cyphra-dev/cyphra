import type {
  ResolvedNodeModel,
  ResolvedRelationField,
  ResolvedScalarField,
  SchemaModel,
} from "@cyphra/schema";
import type {
  ApiError,
  CypherRequest,
  CypherResponse,
  DeletePreview,
  EdgeFindRequest,
  EdgeFindResponse,
  EdgeUpdateRequest,
  FindRequest,
  FindResponse,
  RelatedRequest,
  StudioField,
  StudioMeta,
  StudioScalarField,
} from "./protocol.js";
import {
  StudioRequestError,
  StudioUnsupportedError,
  decodeData,
  decodeEdgeData,
  decodeWhere,
  keyOf,
  toWire,
} from "./values.js";

type AnyRecord = Record<string, unknown>;

/** The ORM operations the studio uses on one model (a subset of a model delegate). */
export type StudioDelegate = {
  findMany(args: AnyRecord): Promise<AnyRecord[]>;
  findUnique(args: AnyRecord): Promise<AnyRecord | null>;
  count(args: AnyRecord): Promise<number>;
  create(args: AnyRecord): Promise<AnyRecord>;
  update(args: AnyRecord): Promise<AnyRecord>;
  delete(args: AnyRecord): Promise<AnyRecord>;
};

/** What the API runs against: ORM delegates and raw Cypher. */
export type StudioDb = {
  delegate(model: string): StudioDelegate;
  /** Run one Cypher statement; `mode: "read"` runs in a read transaction. */
  cypher(query: string, params: AnyRecord, mode: "read" | "write"): Promise<AnyRecord[]>;
};

export type ApiResult = { status: number; body: unknown };

export type StudioApi = {
  readonly meta: StudioMeta;
  handle(method: string, path: string, body: unknown): Promise<ApiResult>;
};

/** Largest page the API returns. */
export const MAX_TAKE = 500;
/** Largest number of rows a raw Cypher query returns to the browser. */
export const MAX_CYPHER_ROWS = 1000;

function isRecord(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function page(req: { skip?: unknown; take?: unknown }): { skip: number; take: number } {
  const skip = req.skip === undefined ? 0 : Number(req.skip);
  const take = req.take === undefined ? 50 : Number(req.take);
  if (!Number.isInteger(skip) || skip < 0) throw new StudioRequestError("skip must be ≥ 0.");
  if (!Number.isInteger(take) || take < 1 || take > MAX_TAKE) {
    throw new StudioRequestError(`take must be between 1 and ${MAX_TAKE}.`);
  }
  return { skip, take };
}

/** Backtick-quote a label, type or property name taken from the schema. */
function q(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

/**
 * Map an error to an API answer: validation issues (400), not found (404), uniqueness and
 * `onDelete: Restrict` (409), bad requests and features the dialect lacks (400). Anything else is
 * a 500 with its message.
 */
export function errorResult(e: unknown): ApiResult {
  const name = (e as { name?: string })?.name;
  const message = e instanceof Error ? e.message : String(e);
  const body: ApiError = { error: message };
  if (e instanceof StudioUnsupportedError) {
    return {
      status: 400,
      body: {
        ...body,
        unsupported: { feature: e.feature, dialect: e.dialect },
        ...(e.issues.length ? { issues: e.issues } : {}),
      },
    };
  }
  if (e instanceof StudioRequestError) return { status: 400, body };
  switch (name) {
    case "UnsupportedFeatureError": {
      const { feature, dialect } = e as { feature?: unknown; dialect?: unknown };
      return {
        status: 400,
        body: { ...body, unsupported: { feature: String(feature), dialect: String(dialect) } },
      };
    }
    case "CyphraValidationError": {
      const issues = ((e as { issues?: { field: string; message: string }[] }).issues ?? []).map(
        (i) => ({ field: i.field, message: i.message }),
      );
      return { status: 400, body: { ...body, ...(issues.length ? { issues } : {}) } };
    }
    case "NotFoundError":
      return { status: 404, body };
    case "UniqueConstraintError":
      return {
        status: 409,
        body: { ...body, fields: (e as { fields?: readonly string[] }).fields ?? [] },
      };
    case "RestrictError":
      return { status: 409, body };
    default: {
      // The database rejected the statement (syntax, a write in a read transaction, …): a bad
      // request.
      const code = (e as { code?: unknown })?.code;
      const client =
        typeof code === "string" &&
        (code.startsWith("Neo.ClientError.") || code.startsWith("Memgraph.ClientError."));
      return { status: client ? 400 : 500, body };
    }
  }
}

/**
 * Edge properties read with raw Cypher, shaped like the ORM returns them: `DateTime` as ISO text
 * with milliseconds, `Json` parsed from its stored text.
 */
function edgeProps(fields: readonly ResolvedScalarField[], props: AnyRecord): AnyRecord {
  const out: AnyRecord = { ...props };
  for (const f of fields) {
    const v = out[f.name];
    if (typeof v !== "string") continue;
    if (f.type === "DateTime") {
      const d = new Date(v.replace(/(\.\d{3})\d+/, "$1"));
      if (!Number.isNaN(d.getTime())) out[f.name] = d.toISOString();
    } else if (f.type === "Json") {
      try {
        out[f.name] = JSON.parse(v);
      } catch {
        // not JSON text: shown as stored
      }
    }
  }
  return out;
}

/** Build the JSON API of the studio. Every route answers JSON-serializable data. */
export function createStudioApi(opts: {
  schema: SchemaModel;
  db: StudioDb;
  meta: StudioMeta;
  readOnly: boolean;
}): StudioApi {
  const { schema, db, meta, readOnly } = opts;
  const nodeByName = new Map(schema.nodes.map((n) => [n.name, n]));

  const node = (name: string): ResolvedNodeModel => {
    const n = nodeByName.get(name);
    if (!n) throw new StudioRequestError(`Unknown model "${name}".`);
    return n;
  };
  const relationsOf = (n: ResolvedNodeModel): ResolvedRelationField[] =>
    n.fields.filter((f): f is ResolvedRelationField => f.kind === "relation");

  /** `include` for list views: counts of to-many relations, the key of to-one relations. */
  const includeFor = (n: ResolvedNodeModel): AnyRecord | undefined => {
    const rels = relationsOf(n);
    if (rels.length === 0) return undefined;
    const include: AnyRecord = {};
    if (rels.some((r) => r.many)) {
      include._count = {
        select: Object.fromEntries(rels.filter((r) => r.many).map((r) => [r.name, true])),
      };
    }
    for (const r of rels.filter((x) => !x.many)) {
      const target = node(r.target);
      const key = keyOf(target);
      const fields = key ? (key.kind === "field" ? [key.field] : key.fields) : [];
      include[r.name] = fields.length
        ? { select: Object.fromEntries(fields.map((f) => [f, true])) }
        : true;
    }
    return include;
  };

  const orderByOf = (n: ResolvedNodeModel, orderBy: unknown): AnyRecord[] | undefined => {
    if (orderBy === undefined || orderBy === null) return undefined;
    if (!isRecord(orderBy)) throw new StudioRequestError("orderBy must be an object.");
    return Object.entries(orderBy).map(([k, dir]) => {
      if (dir !== "asc" && dir !== "desc") {
        throw new StudioRequestError(`orderBy.${k} must be "asc" or "desc".`);
      }
      const f = n.fields.find((x) => x.name === k);
      if (f?.kind === "relation") {
        if (!f.many) throw new StudioRequestError(`Cannot sort by to-one relation ${k}.`);
        return { [k]: { _count: dir } };
      }
      return { [k]: dir };
    });
  };

  const keyWhere = (model: string, where: unknown): AnyRecord => {
    if (!isRecord(where) || Object.keys(where).length === 0) {
      throw new StudioRequestError("A record key (where) is required.");
    }
    return decodeWhere(schema, model, where);
  };

  /**
   * Refuse to write fields whose values the dialect cannot store (a `Time` on Memgraph), with a
   * message naming them, before anything runs.
   */
  const assertStorable = (fields: readonly StudioField[], data: unknown, owner: string) => {
    if (!isRecord(data)) return;
    const bad = fields.filter(
      (f): f is StudioScalarField & { unsupported: string } =>
        f.kind === "scalar" &&
        f.unsupported !== undefined &&
        data[f.name] !== undefined &&
        data[f.name] !== null,
    );
    if (bad.length === 0) return;
    const server =
      meta.dialect === "memgraph" ? "Memgraph" : meta.dialect === "falkordb" ? "FalkorDB" : "Neo4j";
    throw new StudioUnsupportedError(
      `${bad.map((f) => `${owner}.${f.name}`).join(", ")} cannot be written on ${server}: ${bad[0]!.unsupported}`,
      `${bad[0]!.type} values`,
      meta.dialect,
      bad.map((f) => ({ field: f.name, message: f.unsupported })),
    );
  };
  const nodeFields = (name: string) => meta.nodes.find((x) => x.name === name)?.fields ?? [];

  const writable = (n: ResolvedNodeModel) => {
    if (readOnly) throw new StudioRequestError("The studio runs in read-only mode.");
    if (n.abstract) {
      throw new StudioRequestError(
        `${n.name} is an interface: write through one of its implementations.`,
      );
    }
  };

  const findModel = async (model: string, req: FindRequest): Promise<FindResponse> => {
    const n = node(model);
    const where = decodeWhere(schema, model, req.where);
    const { skip, take } = page(req);
    const include = includeFor(n);
    const d = db.delegate(model);
    const [rows, total] = await Promise.all([
      d.findMany({
        where,
        skip,
        take,
        ...(include ? { include } : {}),
        ...(req.orderBy ? { orderBy: orderByOf(n, req.orderBy) } : {}),
      }),
      d.count({ where }),
    ]);
    return { rows: toWire(rows) as AnyRecord[], total };
  };

  const related = async (model: string, req: RelatedRequest): Promise<FindResponse> => {
    const n = node(model);
    const rel = relationsOf(n).find((r) => r.name === req.relation);
    if (!rel) throw new StudioRequestError(`${model} has no relation "${req.relation}".`);
    const target = node(rel.target);
    const where = keyWhere(model, req.where);
    const { skip, take } = page(req);
    const inner = includeFor(target);
    // The edge properties come back under `$edge` on each related node.
    const nested: AnyRecord = { ...(inner ? { include: inner } : {}) };
    if (rel.many) {
      Object.assign(nested, { skip, take });
      if (req.orderBy) nested.orderBy = orderByOf(target, req.orderBy);
    }
    const include: AnyRecord = {
      [rel.name]: Object.keys(nested).length ? nested : true,
      ...(rel.many ? { _count: { select: { [rel.name]: true } } } : {}),
    };
    const rec = await db.delegate(model).findUnique({ where, include });
    if (!rec) return { rows: [], total: 0 };
    const value = rec[rel.name];
    const rows = rel.many ? ((value as AnyRecord[]) ?? []) : value ? [value as AnyRecord] : [];
    const total = rel.many
      ? Number((rec._count as AnyRecord | undefined)?.[rel.name] ?? rows.length)
      : rows.length;
    return { rows: toWire(rows) as AnyRecord[], total };
  };

  const deletePreview = async (model: string, where: unknown): Promise<DeletePreview> => {
    const n = node(model);
    const rels = relationsOf(n);
    const w = keyWhere(model, where);
    if (rels.length === 0) {
      const rec = await db.delegate(model).findUnique({ where: w });
      if (!rec) throw Object.assign(new Error(`No ${model} matches.`), { name: "NotFoundError" });
      return { effects: [], blocked: false };
    }
    const select: AnyRecord = {};
    const many = rels.filter((r) => r.many);
    if (many.length) {
      select._count = { select: Object.fromEntries(many.map((r) => [r.name, true])) };
    }
    for (const r of rels.filter((x) => !x.many)) {
      const target = node(r.target);
      const key = keyOf(target);
      select[r.name] = key
        ? {
            select: Object.fromEntries(
              (key.kind === "field" ? [key.field] : key.fields).map((f) => [f, true]),
            ),
          }
        : true;
    }
    const rec = await db.delegate(model).findUnique({ where: w, select });
    if (!rec) throw Object.assign(new Error(`No ${model} matches.`), { name: "NotFoundError" });
    const counts = (rec._count ?? {}) as AnyRecord;
    const effects = rels.map((r) => ({
      relation: r.name,
      target: r.target,
      rule: r.onDelete ?? "SetNull",
      count: r.many ? Number(counts[r.name] ?? 0) : rec[r.name] ? 1 : 0,
    }));
    return {
      effects,
      blocked: effects.some((e) => e.rule === "Restrict" && e.count > 0),
    };
  };

  const relModel = (name: string) => {
    const r = schema.relationships.find((x) => x.name === name);
    if (!r) throw new StudioRequestError(`Unknown relationship model "${name}".`);
    return r;
  };

  /** `MATCH` of the edges of relationship model `name` (labels and type from the schema). */
  const edgePattern = (name: string) => {
    const r = relModel(name);
    return {
      r,
      from: node(r.from),
      to: node(r.to),
      text: `MATCH (a:${q(node(r.from).label)})-[r:${q(r.relType)}]->(b:${q(node(r.to).label)})`,
    };
  };

  /** Map projection of the key fields of `n` (all scalar fields when it has no key). */
  const keyProjection = (n: ResolvedNodeModel, alias: string): string => {
    const key = keyOf(n);
    const fields = key
      ? key.kind === "field"
        ? [key.field]
        : key.fields
      : n.fields.filter((f) => f.kind === "scalar").map((f) => f.name);
    return `${alias} {${fields.map((f) => `.${q(f)}`).join(", ")}}`;
  };

  const findEdges = async (name: string, req: EdgeFindRequest): Promise<EdgeFindResponse> => {
    const { r, from, to, text } = edgePattern(name);
    const { skip, take } = page(req);
    let order = "";
    if (req.orderBy !== undefined) {
      if (!isRecord(req.orderBy)) throw new StudioRequestError("orderBy must be an object.");
      const parts = Object.entries(req.orderBy).map(([k, dir]) => {
        if (!r.properties.some((p) => p.name === k)) {
          throw new StudioRequestError(`${name} has no property "${k}".`);
        }
        if (dir !== "asc" && dir !== "desc") {
          throw new StudioRequestError(`orderBy.${k} must be "asc" or "desc".`);
        }
        return `r.${q(k)} ${dir === "desc" ? "DESC" : "ASC"}`;
      });
      if (parts.length) order = ` ORDER BY ${parts.join(", ")}`;
    }
    const [rows, totals] = await Promise.all([
      db.cypher(
        `${text} RETURN ${keyProjection(from, "a")} AS from, ${keyProjection(to, "b")} AS to, properties(r) AS properties${order} SKIP ${skip} LIMIT ${take}`,
        {},
        "read",
      ),
      db.cypher(`${text} RETURN count(r) AS total`, {}, "read"),
    ]);
    return {
      rows: rows.map((row) => {
        const w = toWire(row) as { from: AnyRecord; to: AnyRecord; properties: AnyRecord };
        return { ...w, properties: edgeProps(r.properties, w.properties ?? {}) };
      }),
      total: Number(toWire(totals[0]?.total) ?? 0),
    };
  };

  /** Edge properties are written through the `from` model's relation (`connect` + `$edge`). */
  const updateEdge = async (name: string, req: EdgeUpdateRequest): Promise<unknown> => {
    if (readOnly) throw new StudioRequestError("The studio runs in read-only mode.");
    const r = relModel(name);
    const via = meta.relationships.find((x) => x.name === name)?.via;
    if (!via) {
      throw new StudioRequestError(
        `${r.from} has no outgoing relation typed by ${name}: its edges cannot be edited here.`,
      );
    }
    const from = keyWhere(r.from, req.from);
    const to = keyWhere(r.to, req.to);
    assertStorable(
      meta.relationships.find((x) => x.name === name)?.properties ?? [],
      req.data,
      name,
    );
    const data = decodeEdgeData(schema, name, req.data);
    await db.delegate(r.from).update({
      where: from,
      data: { [via]: { connect: { ...to, $edge: data } } },
    });
    return { ok: true };
  };

  const cypher = async (req: CypherRequest): Promise<CypherResponse> => {
    if (typeof req.query !== "string" || !req.query.trim()) {
      throw new StudioRequestError("query is required.");
    }
    if (req.params !== undefined && !isRecord(req.params)) {
      throw new StudioRequestError("params must be an object.");
    }
    if (req.write && readOnly) {
      throw new StudioRequestError("The studio runs in read-only mode: writes are disabled.");
    }
    const rows = await db.cypher(req.query, req.params ?? {}, req.write ? "write" : "read");
    const shown = rows.slice(0, MAX_CYPHER_ROWS);
    const columns = shown[0] ? Object.keys(shown[0]) : [];
    return {
      columns,
      rows: shown.map((r) => toWire(r) as AnyRecord),
      truncated: rows.length > shown.length,
    };
  };

  const counts = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    await Promise.all([
      ...schema.nodes.map(async (n) => {
        out[n.name] = await db.delegate(n.name).count({});
      }),
      ...schema.relationships.map(async (r) => {
        const { text } = edgePattern(r.name);
        const rows = await db.cypher(`${text} RETURN count(r) AS total`, {}, "read");
        out[r.name] = Number(toWire(rows[0]?.total) ?? 0);
      }),
    ]);
    return out;
  };

  type Route = (params: string[], body: AnyRecord) => Promise<unknown>;
  const routes: [string, RegExp, Route][] = [
    ["GET", /^\/api\/meta$/, async () => meta],
    ["GET", /^\/api\/counts$/, () => counts()],
    ["POST", /^\/api\/models\/([^/]+)\/find$/, ([m], b) => findModel(m!, b as FindRequest)],
    [
      "POST",
      /^\/api\/models\/([^/]+)\/related$/,
      ([m], b) => related(m!, b as unknown as RelatedRequest),
    ],
    [
      "POST",
      /^\/api\/models\/([^/]+)\/create$/,
      async ([m], b) => {
        const n = node(m!);
        writable(n);
        assertStorable(nodeFields(m!), b.data, m!);
        const rec = await db.delegate(m!).create({ data: decodeData(schema, m!, b.data) });
        return { row: toWire(rec) };
      },
    ],
    [
      "POST",
      /^\/api\/models\/([^/]+)\/update$/,
      async ([m], b) => {
        const n = node(m!);
        writable(n);
        assertStorable(nodeFields(m!), b.data, m!);
        const rec = await db.delegate(m!).update({
          where: keyWhere(m!, b.where),
          data: decodeData(schema, m!, b.data),
        });
        return { row: toWire(rec) };
      },
    ],
    ["POST", /^\/api\/models\/([^/]+)\/delete-preview$/, ([m], b) => deletePreview(m!, b.where)],
    [
      "POST",
      /^\/api\/models\/([^/]+)\/delete$/,
      async ([m], b) => {
        const n = node(m!);
        writable(n);
        const rec = await db.delegate(m!).delete({ where: keyWhere(m!, b.where) });
        return { row: toWire(rec) };
      },
    ],
    [
      "POST",
      /^\/api\/relationships\/([^/]+)\/find$/,
      ([r], b) => findEdges(r!, b as EdgeFindRequest),
    ],
    [
      "POST",
      /^\/api\/relationships\/([^/]+)\/update$/,
      ([r], b) => updateEdge(r!, b as unknown as EdgeUpdateRequest),
    ],
    ["POST", /^\/api\/cypher$/, (_p, b) => cypher(b as unknown as CypherRequest)],
  ];

  return {
    meta,
    async handle(method, path, body) {
      for (const [m, re, route] of routes) {
        const match = re.exec(path);
        if (!match) continue;
        if (m !== method) return { status: 405, body: { error: `Use ${m}.` } };
        if (m === "POST" && !isRecord(body)) {
          return { status: 400, body: { error: "Expected a JSON object body." } };
        }
        try {
          const params = match.slice(1).map((s) => decodeURIComponent(s));
          return { status: 200, body: await route(params, (body ?? {}) as AnyRecord) };
        } catch (e) {
          return errorResult(e);
        }
      }
      return { status: 404, body: { error: "Not found." } };
    },
  };
}
