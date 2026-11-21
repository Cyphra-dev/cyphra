import {
  formatRule,
  type ResolvedNodeModel,
  type ResolvedScalarField,
  type SchemaModel,
} from "@cyphra/schema";
import type {
  StudioField,
  StudioKey,
  StudioMeta,
  StudioNodeModel,
  StudioRelationshipModel,
  StudioScalarField,
} from "./protocol.js";

/** Thrown for malformed requests (answered with 400). */
export class StudioRequestError extends Error {}

type AnyRecord = Record<string, unknown>;

function isRecord(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function scalarMeta(f: ResolvedScalarField): StudioScalarField {
  return {
    kind: "scalar",
    name: f.name,
    type: f.type,
    optional: f.optional,
    list: f.list,
    id: f.id,
    unique: f.unique,
    hasDefault: f.default !== undefined,
    ...(f.enumValues ? { enumValues: f.enumValues } : {}),
    ...(f.dimensions !== undefined ? { dimensions: f.dimensions } : {}),
    ...(f.rules?.length ? { rules: f.rules.map((r) => formatRule(r)) } : {}),
    ...(f.inheritedFrom ? { inheritedFrom: f.inheritedFrom } : {}),
  };
}

/** How records of `node` are addressed: its `@id`, a `@unique` field, else a `@@unique`. */
export function keyOf(node: ResolvedNodeModel): StudioKey | null {
  const field = node.idField ?? node.uniqueFields[0];
  if (field) return { kind: "field", field };
  const cu = node.compoundUniques?.[0];
  return cu ? { kind: "compound", key: cu.key, fields: cu.fields } : null;
}

/** The schema as the UI needs it (no credentials, nothing but the model). */
export function buildMeta(
  schema: SchemaModel,
  info: { readOnly: boolean; connection: string; database?: string; version: string },
): StudioMeta {
  const nodes: StudioNodeModel[] = schema.nodes.map((n) => ({
    name: n.name,
    label: n.label,
    abstract: n.abstract === true,
    ...(n.implementations ? { implementations: n.implementations } : {}),
    ...(n.interfaces ? { interfaces: n.interfaces } : {}),
    key: keyOf(n),
    fields: n.fields.map((f): StudioField =>
      f.kind === "scalar"
        ? scalarMeta(f)
        : {
            kind: "relation",
            name: f.name,
            target: f.target,
            relType: f.relType,
            direction: f.direction,
            many: f.many,
            optional: f.optional,
            ...(f.edge ? { edge: f.edge } : {}),
            onDelete: f.onDelete ?? "SetNull",
          },
    ),
  }));
  const relationships: StudioRelationshipModel[] = schema.relationships.map((r) => {
    const from = schema.nodes.find((n) => n.name === r.from);
    const via = from?.fields.find(
      (f) => f.kind === "relation" && f.edge === r.name && f.direction === "OUT",
    );
    return {
      name: r.name,
      relType: r.relType,
      from: r.from,
      to: r.to,
      properties: r.properties.map(scalarMeta),
      ...(via ? { via: via.name } : {}),
    };
  });
  return { nodes, relationships, ...info };
}

/** One scalar value from the UI's JSON as the ORM takes it (`BigInt` text → `bigint`). */
function decodeScalar(f: Pick<ResolvedScalarField, "type" | "name">, v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (f.type === "BigInt") {
    if (typeof v === "bigint") return v;
    if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
    if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
    throw new StudioRequestError(`${f.name}: expected an integer, got ${JSON.stringify(v)}.`);
  }
  return v;
}

function decodeFieldValue(f: ResolvedScalarField, v: unknown): unknown {
  // A Json value is any JSON (an object or array included): passed through as is.
  if (f.type === "Json") return v;
  if (f.list && Array.isArray(v)) return v.map((x) => decodeScalar(f, x));
  return decodeScalar(f, v);
}

/** Operators of a scalar filter (`{ gt: … }`), to tell them from a bare point value. */
const FILTER_OPS = new Set([
  "equals",
  "not",
  "in",
  "notIn",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "startsWith",
  "endsWith",
  "mode",
  "has",
  "hasEvery",
  "hasSome",
  "isEmpty",
  "distance",
  "withinBBox",
]);

function decodeScalarFilter(f: ResolvedScalarField, v: unknown): unknown {
  if (!isRecord(v) || !Object.keys(v).every((k) => FILTER_OPS.has(k))) {
    return decodeFieldValue(f, v);
  }
  if (f.type === "Json") return v;
  const out: AnyRecord = {};
  for (const [op, x] of Object.entries(v)) {
    if (op === "mode" || op === "isEmpty" || op === "distance" || op === "withinBBox") out[op] = x;
    else if (op === "not") out[op] = decodeScalarFilter(f, x);
    else if (Array.isArray(x)) out[op] = x.map((y) => decodeScalar(f, y));
    else out[op] = decodeScalar(f, x);
  }
  return out;
}

function nodeModel(schema: SchemaModel, name: string): ResolvedNodeModel {
  const n = schema.nodes.find((x) => x.name === name);
  if (!n) throw new StudioRequestError(`Unknown model "${name}".`);
  return n;
}

/**
 * A `where` from the UI as the ORM takes it: `BigInt` values become `bigint`, relation filters
 * are decoded with the related model. Unknown keys are passed on (the ORM rejects them).
 */
export function decodeWhere(schema: SchemaModel, model: string, where: unknown): AnyRecord {
  if (where === undefined || where === null) return {};
  if (!isRecord(where)) throw new StudioRequestError("where must be an object.");
  const node = nodeModel(schema, model);
  const out: AnyRecord = {};
  for (const [k, v] of Object.entries(where)) {
    if (k === "AND" || k === "OR") {
      out[k] = (Array.isArray(v) ? v : [v]).map((x) => decodeWhere(schema, model, x));
      continue;
    }
    if (k === "NOT") {
      out[k] = Array.isArray(v)
        ? v.map((x) => decodeWhere(schema, model, x))
        : decodeWhere(schema, model, v);
      continue;
    }
    const f = node.fields.find((x) => x.name === k);
    if (f?.kind === "scalar") out[k] = decodeScalarFilter(f, v);
    else if (f?.kind === "relation" && isRecord(v)) {
      const r: AnyRecord = {};
      for (const [op, x] of Object.entries(v)) {
        r[op] = isRecord(x) ? decodeWhere(schema, f.target, x) : x;
      }
      out[k] = r;
    } else {
      const cu = node.compoundUniques?.find((c) => c.key === k);
      out[k] = cu && isRecord(v) ? decodeData(schema, model, v) : v;
    }
  }
  return out;
}

/** Write `data` from the UI as the ORM takes it (scalar fields only). */
export function decodeData(schema: SchemaModel, model: string, data: unknown): AnyRecord {
  if (!isRecord(data)) throw new StudioRequestError("data must be an object.");
  const node = nodeModel(schema, model);
  return decodeProps(node.fields, data, model);
}

/** Edge property `data` of relationship model `name`. */
export function decodeEdgeData(schema: SchemaModel, name: string, data: unknown): AnyRecord {
  if (!isRecord(data)) throw new StudioRequestError("data must be an object.");
  const rel = schema.relationships.find((r) => r.name === name);
  if (!rel) throw new StudioRequestError(`Unknown relationship model "${name}".`);
  return decodeProps(rel.properties, data, name);
}

function decodeProps(
  fields: readonly { kind: string; name: string }[],
  data: AnyRecord,
  owner: string,
): AnyRecord {
  const out: AnyRecord = {};
  for (const [k, v] of Object.entries(data)) {
    const f = fields.find((x) => x.name === k);
    if (!f) throw new StudioRequestError(`${owner} has no field "${k}".`);
    if (f.kind !== "scalar") {
      throw new StudioRequestError(`${owner}.${k} is a relation: it cannot be written here.`);
    }
    out[k] = decodeFieldValue(f as ResolvedScalarField, v);
  }
  return out;
}

/** Brand markers of `neo4j-driver` / Cyphra Cypher values. */
function marker(v: AnyRecord, name: string): boolean {
  return (v as Record<string, unknown>)[name] === true;
}

/**
 * Any value as JSON for the browser: `bigint` and 64-bit integers outside the safe range as
 * decimal text, temporal values and durations as ISO 8601 text, nodes as
 * `{ $labels, $elementId, ...properties }`, relationships as `{ $type, ...properties }`, paths
 * as `{ $path: [...] }`.
 */
export function toWire(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value !== "object") return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map(toWire);
  const v = value as AnyRecord;
  if (marker(v, "__isInteger__")) {
    const text = String(v);
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : text;
  }
  for (const m of [
    "__isDate__",
    "__isDateTime__",
    "__isLocalDateTime__",
    "__isLocalTime__",
    "__isTime__",
    "__isDuration__",
  ]) {
    if (marker(v, m)) return String(v);
  }
  if (marker(v, "__isPoint__")) {
    const srid = Number(toWire(v.srid));
    const geo = srid === 4326 || srid === 4979;
    const p: AnyRecord = geo ? { longitude: v.x, latitude: v.y } : { x: v.x, y: v.y };
    if (typeof v.z === "number") p[geo ? "height" : "z"] = v.z;
    return p;
  }
  if (marker(v, "__isNode__") || ("labels" in v && "properties" in v && "elementId" in v)) {
    return {
      $labels: v.labels,
      $elementId: v.elementId,
      ...(toWire(v.properties) as AnyRecord),
    };
  }
  if (
    marker(v, "__isRelationship__") ||
    ("type" in v && "properties" in v && "startNodeElementId" in v)
  ) {
    return { $type: v.type, ...(toWire(v.properties) as AnyRecord) };
  }
  if (marker(v, "__isPath__") || ("segments" in v && "start" in v && "end" in v)) {
    const segs = v.segments as AnyRecord[];
    return {
      $path: [toWire(v.start), ...segs.flatMap((s) => [toWire(s.relationship), toWire(s.end)])],
    };
  }
  const out: AnyRecord = {};
  for (const [k, x] of Object.entries(v)) out[k] = toWire(x);
  return out;
}
