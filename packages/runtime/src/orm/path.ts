/**
 * Typed path results (`{ nodes, edges }`), shared by traversals and shortest-path queries.
 *
 * A path is never returned as a driver `Path` value: the statement turns it into a plain map of
 * lists, strings and booleans ({@link compilePath}), so decoding needs no `instanceof` check on a
 * driver class and works the same with `neo4j-driver` 5 and 6, from any copy of the package.
 *
 * @packageDocumentation
 */

import type { ResolvedNodeModel, ResolvedScalarField, SchemaModel } from "@cyphra/schema";
import type { QueryContext } from "./compile.js";
import { decodeScalar, toNative } from "./values.js";
import type { Path, PathEdge } from "./types.js";

type AnyRecord = Record<string, unknown>;

/**
 * Cypher expression for path variable `path` as
 * `{nodes: [{labels, properties}], edges: [{type, properties, out}]}`, where `out` is `true` when
 * `edges[i]` points from `nodes[i]` to `nodes[i + 1]`. Decode it with {@link decodePath}. With
 * `nodeProperties: false` the nodes carry only their labels (enough to type the edges), for a
 * caller that projects the nodes itself; with `nodes: false` too there are no nodes at all (when
 * {@link edgesNeedNodeLabels} says the edges can be typed without them), decoded with
 * {@link decodePathEdges}.
 */
export function compilePath(
  ctx: QueryContext,
  path: string,
  { nodeProperties = true, nodes = true }: { nodeProperties?: boolean; nodes?: boolean } = {},
): string {
  const withNodes = nodes || nodeProperties;
  const x = withNodes ? ctx.variable("x") : "";
  const i = ctx.variable("i");
  const rel = `relationships(${path})[${i}]`;
  const props = nodeProperties ? `, properties: properties(${x})` : "";
  const edges =
    `[${i} IN range(0, length(${path}) - 1) | ` +
    `{type: type(${rel}), properties: properties(${rel}), out: startNode(${rel}) = nodes(${path})[${i}]}]`;
  if (!withNodes) return `{edges: ${edges}}`;
  return `{nodes: [${x} IN nodes(${path}) | {labels: labels(${x})${props}}], edges: ${edges}}`;
}

/**
 * Whether typing edges of these relationship types needs their endpoint labels: only when a type
 * is shared by several `relationship { … }` models (told apart by their endpoints).
 */
export function edgesNeedNodeLabels(schema: SchemaModel, relTypes: Iterable<string>): boolean {
  const index = pathIndex(schema);
  for (const t of relTypes) if ((index.byRelType.get(t)?.length ?? 0) > 1) return true;
  return false;
}

function decodeProps(fields: readonly ResolvedScalarField[], raw: unknown): AnyRecord {
  const src = (raw ?? {}) as AnyRecord;
  const out: AnyRecord = {};
  for (const f of fields) out[f.name] = decodeScalar(f, src[f.name]);
  return out;
}

type RelationshipModel = SchemaModel["relationships"][number];

/** What decoding a path looks up in the schema, built once per schema (not once per node). */
type PathIndex = {
  /** Node model for a label (an implementation before its interface), with its scalar fields. */
  readonly byLabel: ReadonlyMap<string, ResolvedNodeModel>;
  readonly scalars: ReadonlyMap<ResolvedNodeModel, readonly ResolvedScalarField[]>;
  /** A model's name followed by the interfaces it implements. */
  readonly names: ReadonlyMap<ResolvedNodeModel, readonly string[]>;
  readonly byRelType: ReadonlyMap<string, readonly RelationshipModel[]>;
  /** Node models per joined label list, for nodes carrying several labels. */
  readonly modelOfLabels: Map<string, ResolvedNodeModel | undefined>;
};

const indexes = new WeakMap<SchemaModel, PathIndex>();

function pathIndex(schema: SchemaModel): PathIndex {
  let index = indexes.get(schema);
  if (index) return index;
  const byLabel = new Map<string, ResolvedNodeModel>();
  const scalars = new Map<ResolvedNodeModel, readonly ResolvedScalarField[]>();
  const names = new Map<ResolvedNodeModel, readonly string[]>();
  for (const m of schema.nodes) {
    const prev = byLabel.get(m.label);
    if (!prev || (prev.abstract && !m.abstract)) byLabel.set(m.label, m);
    scalars.set(
      m,
      m.fields.filter((f): f is ResolvedScalarField => f.kind === "scalar"),
    );
    names.set(m, [m.name, ...(m.interfaces ?? [])]);
  }
  // A `relationship { … }` model may name a union: its nodes match it too.
  for (const u of schema.nodes) {
    if (!u.union) continue;
    for (const [m, list] of names) {
      if ((u.implementations ?? []).includes(m.name)) names.set(m, [...list, u.name]);
    }
  }
  const byRelType = new Map<string, RelationshipModel[]>();
  for (const r of schema.relationships) {
    const list = byRelType.get(r.relType);
    if (list) list.push(r);
    else byRelType.set(r.relType, [r]);
  }
  index = { byLabel, scalars, names, byRelType, modelOfLabels: new Map() };
  indexes.set(schema, index);
  return index;
}

/**
 * The model a node with these labels decodes as: an implementation's label wins over its
 * interface's, then the first model (in schema order) whose label the node carries.
 */
function modelOf(
  index: PathIndex,
  schema: SchemaModel,
  labels: unknown,
): ResolvedNodeModel | undefined {
  const list = Array.isArray(labels) ? (labels as unknown[]) : [];
  if (list.length === 1) return index.byLabel.get(String(list[0]));
  const key = list.join("\u0000");
  if (index.modelOfLabels.has(key)) return index.modelOfLabels.get(key);
  const known = schema.nodes.filter((m) => list.includes(m.label));
  const model = known.find((m) => !m.abstract) ?? known[0];
  if (index.modelOfLabels.size < 1024) index.modelOfLabels.set(key, model);
  return model;
}

type RawPath = { nodes?: unknown[]; edges?: unknown[] };
type RawEdge = { type?: unknown; properties?: unknown; out?: unknown };

function decodeEdges(
  index: PathIndex,
  models: readonly (ResolvedNodeModel | undefined)[],
  rawEdges: readonly RawEdge[],
): PathEdge[] {
  const none: readonly string[] = [];
  const edges = new Array<PathEdge>(rawEdges.length);
  for (let i = 0; i < rawEdges.length; i++) {
    const e = rawEdges[i]!;
    const type = String(e.type);
    const out = e.out === true;
    const candidates = index.byRelType.get(type);
    let edgeModel: RelationshipModel | undefined;
    if (candidates) {
      if (candidates.length === 1) {
        edgeModel = candidates[0];
      } else {
        const s = models[out ? i : i + 1];
        const t = models[out ? i + 1 : i];
        const start = s ? index.names.get(s)! : none;
        const end = t ? index.names.get(t)! : none;
        edgeModel = candidates.find((r) => start.includes(r.from) && end.includes(r.to));
      }
    }
    edges[i] = {
      type,
      direction: out ? "out" : "in",
      properties: edgeModel ? decodeProps(edgeModel.properties, e.properties) : {},
    };
  }
  return edges;
}

/**
 * Decode a value built by {@link compilePath}. Nodes are decoded with the scalar fields of the
 * model whose label they carry, edges with the `relationship { … }` model of their type and
 * endpoints (`{}` for an untyped edge). Properties outside the schema are dropped; a node with no
 * known label keeps its raw properties (converted with {@link toNative}).
 */
export function decodePath(schema: SchemaModel, raw: unknown): Path<AnyRecord, PathEdge> {
  const src = (raw ?? {}) as RawPath;
  const rawNodes = (src.nodes ?? []) as { labels?: unknown; properties?: unknown }[];
  const index = pathIndex(schema);
  // A node with an implementation's label decodes as that implementation, not as its interface.
  const models = rawNodes.map((n) => modelOf(index, schema, n.labels));
  const nodes = rawNodes.map((n, i) => {
    const model = models[i];
    return model
      ? decodeProps(index.scalars.get(model)!, n.properties)
      : (toNative(n.properties ?? {}) as AnyRecord);
  });
  return { nodes, edges: decodeEdges(index, models, (src.edges ?? []) as RawEdge[]) };
}

/**
 * The edges of a value built by {@link compilePath} (typically with `nodeProperties: false`),
 * decoded like {@link decodePath} does, without decoding the nodes: for callers that project the
 * nodes themselves (shortest paths).
 */
export function decodePathEdges(schema: SchemaModel, raw: unknown): PathEdge[] {
  const src = (raw ?? {}) as RawPath;
  const rawEdges = (src.edges ?? []) as RawEdge[];
  if (rawEdges.length === 0) return [];
  const index = pathIndex(schema);
  const rawNodes = (src.nodes ?? []) as { labels?: unknown }[];
  const models = rawNodes.map((n) => modelOf(index, schema, n.labels));
  return decodeEdges(index, models, rawEdges);
}
